import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateObject } from "ai";
import { z } from "zod";
import { fireworks, FIREWORKS_MODEL } from "./fireworks";
import { cloneRepo, normalizeRepoUrl, readRepoContext } from "./repo";

const EnvVarSpec = z.object({
  name: z
    .string()
    .describe(
      "The literal environment variable name exactly as the code or docs reference it, e.g. " +
        "OPENAI_API_KEY or DATABASE_URL. Must be a real variable the app reads -- never a category, " +
        "placeholder, or description like 'llm_provider_api_keys' or 'your_api_key_here'."
    ),
  description: z
    .string()
    .describe("Short plain-language explanation of what this is and where to get it."),
  required: z
    .boolean()
    .describe("True if the app cannot build or start without it; false if it's optional."),
  buildTime: z
    .boolean()
    .describe(
      "True if this is needed while the image builds (e.g. a framework inlines it at build time), " +
        "false if it's only needed once the app is running."
    ),
});

const AnalysisSchema = z.object({
  webServable: z
    .boolean()
    .describe(
      "True if this project is (or can be) a web service listening on an HTTP port. " +
        "False for CLI tools, libraries, or documentation/skills collections with no server component."
    ),
  reasoning: z.string().describe("One sentence explaining the webServable determination."),
  dockerfile: z
    .string()
    .nullable()
    .describe(
      "A complete, working Dockerfile if one needs to be written -- must include an EXPOSE line and " +
        "a CMD/ENTRYPOINT that starts the server in the foreground. Null if the repo already has one " +
        "or if webServable is false."
    ),
  requiredEnvVars: z
    .array(EnvVarSpec)
    .describe(
      "Environment variables the user must supply for this app to build/run, inferred from " +
        ".env.example, the README, docker-compose, or the code's configuration. Empty array if none " +
        "are needed. Do not invent variables that have working defaults."
    ),
  setupCommands: z
    .array(z.string())
    .describe(
      "Shell commands that build or install this project so it is ready to USE, run from /repo " +
        "as root at image build time. Only for non-web projects opened in a terminal. Prefer the " +
        "project's documented install (e.g. 'go build -o /usr/local/bin/croc .', " +
        "'pip install -e .', 'npm install && npm run build'). Must be non-interactive and need no " +
        "secrets or network logins. Empty array if nothing is needed or nothing can be built offline."
    ),
  tryCommand: z
    .string()
    .nullable()
    .describe(
      "A single command the user can run FIRST to see the tool working, assuming setupCommands " +
        "already ran (e.g. 'croc --help'). Must reference a binary or entrypoint that will actually " +
        "exist afterwards -- never a path like './croc' unless a build step produces it. Null if unclear."
    ),
});

export type EnvVarRequirement = z.infer<typeof EnvVarSpec>;

export interface RepoAnalysis {
  repoUrl: string;
  webServable: boolean;
  reasoning: string;
  /** Present only when the repo had no Dockerfile and one was generated. */
  synthesizedDockerfile: string | null;
  dockerfileSource: "repo" | "synthesized";
  requiredEnvVars: EnvVarRequirement[];
  /** Build/install steps so a terminal opens with the tool ready to run. */
  setupCommands: string[];
  /** First command worth trying once setup has run. */
  tryCommand: string | null;
}

// Analysis is deterministic-ish and expensive (clone + LLM call), and the agent
// flow analyzes then deploys as two separate tool calls. Cache so the second
// call doesn't redo the LLM work.
const analysisCache = new Map<string, RepoAnalysis>();

export function getCachedAnalysis(repoUrl: string): RepoAnalysis | undefined {
  return analysisCache.get(normalizeRepoUrl(repoUrl));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompt versions are kept side by side so the eval can measure one against
 * the other. v1 asked for "real evidence" but never said what a variable name
 * may look like, and the model duly invented `llm_provider_api_keys` -- a
 * category, not a variable any app reads. v2 spells that rule out.
 */
export type PromptVersion = "v1" | "v2";

const ENV_VAR_RULES: Record<PromptVersion, string> = {
  v1:
    "Then list the environment variables a user must supply for it to actually work. Base this on " +
    "real evidence (.env.example, README setup instructions, docker-compose environment keys) -- " +
    "not guesses. Mark buildTime true only for variables consumed while the image builds.",
  v2:
    "Then list the environment variables a user must supply for it to actually work. Rules:\n" +
    "- Base every entry on real evidence (.env.example, README setup instructions, docker-compose " +
    "environment keys). Do not guess or invent.\n" +
    "- Use the literal variable name the app reads (e.g. ANTHROPIC_API_KEY), never a category or " +
    "placeholder like 'llm_provider_api_keys'. If several providers are possible, list the specific " +
    "variables and mark them optional rather than inventing one umbrella name.\n" +
    "- Omit variables that already have working defaults -- this list should be as short as possible, " +
    "and empty is a good answer for most repos.\n" +
    "- Mark buildTime true only for variables consumed while the image builds.",
};

export interface AnalyzeContextInput {
  repoUrl: string;
  /** README + manifest text, as produced by readRepoContext(). */
  context: string;
  hasDockerfile: boolean;
  promptVersion?: PromptVersion;
}

/**
 * The pure LLM step, with no cloning or filesystem access. Separated out so the
 * eval can replay saved repo fixtures offline -- fast, repeatable, and free of
 * network flakiness that would otherwise be scored as model error.
 */
export async function analyzeRepoContext({
  repoUrl,
  context,
  hasDockerfile,
  promptVersion = "v2",
}: AnalyzeContextInput): Promise<Omit<RepoAnalysis, "repoUrl">> {
  const { object } = await generateObject({
    model: fireworks.chat(FIREWORKS_MODEL),
    schema: AnalysisSchema,
    prompt:
      `Repo: ${repoUrl}\n\n${context}\n\n` +
      `This repo ${hasDockerfile ? "already has" : "does NOT have"} a root Dockerfile.\n\n` +
      "Determine if it's a web-servable application (something that runs an HTTP server a browser " +
      "could hit) as opposed to a CLI tool, library, or documentation/skills collection.\n" +
      (hasDockerfile
        ? "It already has a Dockerfile, so set dockerfile to null -- do not write one.\n"
        : "If it is web-servable, write a complete Dockerfile: install dependencies, EXPOSE the port " +
          "it listens on, and CMD/ENTRYPOINT to start the server in the foreground. Use a full base " +
          "image (not scratch/distroless) so a shell is available. If it's not web-servable, set " +
          "dockerfile to null.\n") +
      ENV_VAR_RULES[promptVersion] +
      "\n\nFinally, if this is NOT web-servable it will be opened in a terminal, so say how to make " +
      "it actually usable there. Give setupCommands that build or install it from /repo (following " +
      "the project's own README), and a tryCommand that demonstrates it. The tryCommand must work " +
      "after setupCommands run -- do not suggest running a binary that no build step produces.",
  });

  return {
    webServable: object.webServable,
    reasoning: object.reasoning,
    synthesizedDockerfile: hasDockerfile ? null : object.dockerfile,
    dockerfileSource: hasDockerfile ? "repo" : "synthesized",
    requiredEnvVars: object.requiredEnvVars,
    setupCommands: object.setupCommands,
    tryCommand: object.tryCommand,
  };
}

/**
 * Clones a repo and works out (a) whether it's something we can serve at all,
 * (b) a Dockerfile for it if it doesn't ship one, and (c) which environment
 * variables the user will need to provide. Split out from the deploy step so
 * the agent can ask the user for secrets *before* burning a build on a repo
 * that would fail without them.
 */
export async function analyzeRepo(repoUrlInput: string): Promise<RepoAnalysis> {
  const repoUrl = normalizeRepoUrl(repoUrlInput);
  const cached = analysisCache.get(repoUrl);
  if (cached) return cached;

  const workDir = await cloneRepo(repoUrl);
  try {
    // Delegates to the same function the eval measures, so what ships and what
    // gets scored can't drift apart.
    const result = await analyzeRepoContext({
      repoUrl,
      context: await readRepoContext(workDir),
      hasDockerfile: await fileExists(join(workDir, "Dockerfile")),
    });

    const analysis: RepoAnalysis = { repoUrl, ...result };
    analysisCache.set(repoUrl, analysis);
    return analysis;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

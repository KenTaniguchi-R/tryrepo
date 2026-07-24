/**
 * Evaluates the LLM stage of the pipeline -- `analyzeRepoContext` -- against 20
 * real trending repos, offline from saved fixtures.
 *
 * Deliberately scoped to the model's decisions. The full deploy path is
 * measured separately by scripts/batch-test.ts; folding Docker builds and
 * Daytona quota into an eval would score infrastructure noise as model quality.
 *
 *   BRAINTRUST_API_KEY=... FIREWORKS_API_KEY=... \
 *     pnpm exec tsx evals/analyze.eval.ts [v1|v2]
 */
import { Eval } from "braintrust";
import fixtures from "./fixtures.json";
import { LABELS_BY_NAME } from "./labels";
import { analyzeRepoContext, type PromptVersion } from "../src/lib/analyzeRepo";

const PROJECT = process.env.BRAINTRUST_PROJECT ?? "tryrepo";
const promptVersion = (process.argv[2] as PromptVersion) ?? "v2";
const experimentName = `analyze-${promptVersion}`;

interface Fixture {
  name: string;
  repoUrl: string;
  hasDockerfile: boolean;
  context: string;
}

type Output = Awaited<ReturnType<typeof analyzeRepoContext>>;

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Is every returned name shaped like a real environment variable? This is what
 * caught the model inventing `llm_provider_api_keys` -- a category, not a
 * variable any program reads.
 */
function envVarNamesWellFormed({ output }: { output: Output }) {
  const names = output.requiredEnvVars.map((v) => v.name);
  if (names.length === 0) return { name: "env_var_names_well_formed", score: 1 };
  const bad = names.filter((n) => !ENV_VAR_NAME.test(n));
  return {
    name: "env_var_names_well_formed",
    score: (names.length - bad.length) / names.length,
    metadata: { bad, names },
  };
}

/**
 * Does each name actually appear somewhere in the repo's own files? A variable
 * the repo never mentions was invented, however plausible it looks.
 */
function envVarsGrounded({ output, metadata }: { output: Output; metadata?: { context?: string } }) {
  const names = output.requiredEnvVars.map((v) => v.name);
  if (names.length === 0) return { name: "env_vars_grounded", score: 1 };
  const context = metadata?.context ?? "";
  const ungrounded = names.filter((n) => !context.includes(n));
  return {
    name: "env_vars_grounded",
    score: (names.length - ungrounded.length) / names.length,
    metadata: { ungrounded },
  };
}

/** Binary classification against the hand labels. Ambiguous repos abstain. */
function webServableCorrect({
  output,
  expected,
}: {
  output: Output;
  expected?: { webServable: boolean; ambiguous?: boolean };
}) {
  if (!expected || expected.ambiguous) {
    return { name: "web_servable_correct", score: null };
  }
  return {
    name: "web_servable_correct",
    score: output.webServable === expected.webServable ? 1 : 0,
  };
}

/** A repo judged servable but given no Dockerfile can never deploy. */
function dockerfileWhenNeeded({ output }: { output: Output }) {
  if (!output.webServable || output.dockerfileSource === "repo") {
    return { name: "dockerfile_when_needed", score: null };
  }
  const df = output.synthesizedDockerfile ?? "";
  const usable = df.includes("FROM") && /^\s*(CMD|ENTRYPOINT)\s/im.test(df);
  return { name: "dockerfile_when_needed", score: usable ? 1 : 0 };
}

type Expected = { webServable: boolean; ambiguous?: boolean };
type CaseMetadata = { repo: string; context: string };

async function main() {
  await Eval<Fixture, Output, Expected, CaseMetadata>(PROJECT, {
    // TS SDK field is `experimentName` -- the docs' `experiment` is Python.
    experimentName,
    metadata: { prompt_version: promptVersion, model: process.env.FIREWORKS_MODEL },
    data: () =>
      (fixtures as Fixture[]).map((f) => {
        const label = LABELS_BY_NAME.get(f.name);
        return {
          input: f,
          // An unlabelled repo abstains rather than being scored against a guess.
          expected: label
            ? { webServable: label.webServable, ambiguous: label.ambiguous }
            : { webServable: false, ambiguous: true },
          // Carried so the grounding scorer can check names against the repo.
          metadata: { repo: f.name, context: f.context },
        };
      }),
    task: (input) =>
      analyzeRepoContext({
        repoUrl: input.repoUrl,
        context: input.context,
        hasDockerfile: input.hasDockerfile,
        promptVersion,
      }),
    scores: [envVarNamesWellFormed, envVarsGrounded, webServableCorrect, dockerfileWhenNeeded],
    // The task is a nondeterministic LLM call, so a single pass proves little.
    trialCount: 2,
    maxConcurrency: 5,
  });

  // No manual summarize() needed: Eval() already prints a comparison table
  // against the previous experiment, with per-score improvements/regressions.
}

main();

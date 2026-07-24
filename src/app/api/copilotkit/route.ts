import {
  BuiltInAgent,
  CopilotRuntime,
  createCopilotRuntimeHandler,
  defineTool,
} from "@copilotkit/runtime/v2";
import { z } from "zod";
import { deployRepo } from "@/lib/deploy";
import { analyzeRepo } from "@/lib/analyzeRepo";
import { logDeployAttempt } from "@/lib/braintrust";
import { fireworks, FIREWORKS_MODEL } from "@/lib/fireworks";
import { repoTools } from "@/lib/repoTools";

const analyzeTool = defineTool({
  name: "analyzeRepo",
  description:
    "Inspect a GitHub repository BEFORE deploying it. Reports whether it's a web-servable project, " +
    "whether a Dockerfile had to be generated for it, and — importantly — which environment variables " +
    "the user must supply for it to build and run. Always call this first.",
  parameters: z.object({
    repoUrl: z
      .string()
      .describe("GitHub repository URL, e.g. https://github.com/owner/repo or owner/repo"),
  }),
  execute: async ({ repoUrl }) => {
    console.log(`[analyzeTool] analyzing: ${repoUrl}`);
    try {
      const analysis = await analyzeRepo(repoUrl);
      console.log(`[analyzeTool] result:`, {
        webServable: analysis.webServable,
        dockerfileSource: analysis.dockerfileSource,
        envVars: analysis.requiredEnvVars.map((v) => v.name),
      });
      return {
        status: "ok" as const,
        webServable: analysis.webServable,
        reasoning: analysis.reasoning,
        dockerfileSource: analysis.dockerfileSource,
        requiredEnvVars: analysis.requiredEnvVars,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[analyzeTool] failed: ${message}`);
      return { status: "error" as const, error: message };
    }
  },
});

const deployTool = defineTool({
  name: "deployRepo",
  description:
    "Deploy a public GitHub repository into a live, temporary, publicly reachable sandbox and return a preview URL. " +
    "Call analyzeRepo first; if it reported required environment variables, collect them from the user " +
    "(via the collectEnvVars tool) and pass them here as envVars.",
  parameters: z.object({
    repoUrl: z
      .string()
      .describe("GitHub repository URL, e.g. https://github.com/owner/repo or owner/repo"),
    envVars: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Environment variable name/value pairs supplied by the user. Omit or pass {} if none are needed."
      ),
  }),
  execute: async ({ repoUrl, envVars }) => {
    const startedAt = Date.now();
    console.log(`[deployTool] starting: ${repoUrl}`);
    try {
      const result = await deployRepo(repoUrl, envVars ?? {}, (msg) =>
        console.log(`[deployTool] ${msg}`)
      );
      await logDeployAttempt({
        repoUrl,
        success: true,
        durationMs: Date.now() - startedAt,
        previewUrl: result.previewUrl,
        runCommand: result.runCommand,
      });
      console.log(`[deployTool] success:`, result);
      return {
        status: "success" as const,
        previewUrl: result.previewUrl,
        sandboxId: result.sandboxId,
        port: result.port,
        runCommand: result.runCommand,
        dockerfileSource: result.dockerfileSource,
        workspaceId: result.workspaceId,
        note: "This preview URL auto-expires in 30 minutes.",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logDeployAttempt({
        repoUrl,
        success: false,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      console.log(`[deployTool] failed: ${message}`);
      return { status: "error" as const, error: message };
    }
  },
});

const runtime = new CopilotRuntime({
  agents: {
    default: new BuiltInAgent({
      model: fireworks.chat(FIREWORKS_MODEL),
      tools: [analyzeTool, deployTool, ...repoTools],
      // Default maxSteps is 1 -- the model would call a tool but never get a
      // follow-up turn. The full flow can be analyze -> collectEnvVars ->
      // deploy -> summarize, so it needs headroom for several rounds. A
      // read-heavy repo Q&A exchange (overview, grep, two reads, answer)
      // needs even more, hence 12.
      maxSteps: 12,
      prompt:
        "You help users try out open source GitHub projects instantly, without them needing to clone or configure anything locally.\n\n" +
        "When a user gives you a GitHub repo URL (or owner/repo shorthand), follow this sequence:\n" +
        "1. Call analyzeRepo first, always.\n" +
        "2. If it reports webServable: false, do NOT call deployRepo. Briefly explain why there's no " +
        "web preview (it's a CLI tool, library, or docs collection), then call openTerminal so the " +
        "user gets an interactive shell with the repo checked out at /repo instead. Once it's ready, " +
        "suggest a concrete first command based on the repo's README (e.g. how to install and run it).\n" +
        "3. If it reports any requiredEnvVars, call collectEnvVars with that exact list to ask the user " +
        "for the values. Do NOT invent, guess, or fabricate values yourself, and do not skip this step.\n" +
        "4. Call deployRepo, passing envVars with whatever the user supplied (or {} if none were needed).\n" +
        "5. Give the user the preview URL and mention it expires in 30 minutes. If dockerfileSource is " +
        "'synthesized', flag that the Dockerfile was auto-generated and is best-effort.\n\n" +
        "If the user declines to provide env vars, you may still attempt the deploy, but warn them it " +
        "will probably fail without them." +
        "\n\nAfter a deploy or terminal session succeeds you get a workspaceId. The user can then ask " +
        "questions about the code. To answer those, call getRepoOverview with that workspaceId FIRST so " +
        "you know the layout, then use grepRepo and readFile to look at specific code before answering. " +
        "Never guess at what the code does -- read it. You cannot edit files or redeploy; if the user " +
        "asks for a change, explain what would need to change and where.",
    }),
  },
});

const handler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
  mode: "single-route",
});

export const POST = handler;

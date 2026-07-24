import { createOpenAI } from "@ai-sdk/openai";
import {
  BuiltInAgent,
  CopilotRuntime,
  createCopilotRuntimeHandler,
  defineTool,
} from "@copilotkit/runtime/v2";
import { z } from "zod";
import { deployRepo } from "@/lib/deploy";
import { logDeployAttempt } from "@/lib/braintrust";

const fireworks = createOpenAI({
  apiKey: process.env.FIREWORKS_API_KEY,
  baseURL: "https://api.fireworks.ai/inference/v1",
});

const deployTool = defineTool({
  name: "deployRepo",
  description:
    "Deploy a public GitHub repository that has a root-level Dockerfile into a live, temporary, publicly reachable sandbox. Returns a preview URL. Only supports repos with a Dockerfile at the repo root.",
  parameters: z.object({
    repoUrl: z
      .string()
      .describe("GitHub repository URL, e.g. https://github.com/owner/repo or owner/repo"),
  }),
  execute: async ({ repoUrl }) => {
    const startedAt = Date.now();
    console.log(`[deployTool] starting: ${repoUrl}`);
    try {
      const result = await deployRepo(repoUrl, (msg) => console.log(`[deployTool] ${msg}`));
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
      model: fireworks.chat(process.env.FIREWORKS_MODEL ?? "accounts/fireworks/models/minimax-m3"),
      tools: [deployTool],
      // Default maxSteps is 1 -- the model would call the tool but never get a
      // follow-up turn to report the result back in the chat. We need at least
      // one more step after the tool call to summarize the outcome for the user.
      maxSteps: 4,
      prompt:
        "You help users try out open source GitHub projects instantly, without them needing to clone or configure anything locally. " +
        "When a user gives you a GitHub repo URL (or owner/repo shorthand), call the deployRepo tool. " +
        "If it fails because there's no Dockerfile, tell the user clearly that this MVP only supports repos with a root Dockerfile. " +
        "When it succeeds, give the user the preview URL and mention it expires in 30 minutes.",
    }),
  },
});

const handler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
  mode: "single-route",
});

export const POST = handler;

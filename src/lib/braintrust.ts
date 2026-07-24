import { initLogger } from "braintrust";

const logger = process.env.BRAINTRUST_API_KEY
  ? initLogger({
      projectName: process.env.BRAINTRUST_PROJECT ?? "tryrepo",
      apiKey: process.env.BRAINTRUST_API_KEY,
    })
  : null;

interface DeployAttemptLog {
  repoUrl: string;
  success: boolean;
  durationMs: number;
  previewUrl?: string;
  runCommand?: string;
  error?: string;
}

/**
 * Logs every deploy attempt (success or failure) so we can show a real
 * "tested against N repos, X% success" stat instead of an unverified claim.
 * No-op if BRAINTRUST_API_KEY isn't set, so local dev doesn't require it.
 */
export async function logDeployAttempt(entry: DeployAttemptLog): Promise<void> {
  if (!logger) return;
  await logger.traced(
    async (span) => {
      span.log({
        input: { repoUrl: entry.repoUrl },
        output: entry.success
          ? { previewUrl: entry.previewUrl, runCommand: entry.runCommand }
          : { error: entry.error },
        scores: { deployed: entry.success ? 1 : 0 },
        metadata: { durationMs: entry.durationMs },
      });
    },
    { name: "deployRepo", type: "task" }
  );
}

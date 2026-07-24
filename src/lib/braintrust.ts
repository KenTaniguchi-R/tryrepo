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

interface TerminalAttemptLog {
  repoUrl: string;
  success: boolean;
  durationMs: number;
  baseImage?: string;
  /** Whether the project's build/install actually ran into the image. */
  setupRan?: boolean;
  tryCommand?: string | null;
  error?: string;
}

/**
 * Terminals are the other half of the product -- most repos are not web apps,
 * so most sessions end up here. Tracing only deploys would leave the majority
 * of real usage missing from the dashboard.
 *
 * `ready_to_use` is the score worth watching: a shell that opened but has no
 * built binary in it is a much weaker result than one you can type into
 * immediately, and the two are indistinguishable without it.
 */
export async function logTerminalAttempt(entry: TerminalAttemptLog): Promise<void> {
  if (!logger) return;
  await logger.traced(
    async (span) => {
      span.log({
        input: { repoUrl: entry.repoUrl },
        output: entry.success
          ? { baseImage: entry.baseImage, tryCommand: entry.tryCommand, setupRan: entry.setupRan }
          : { error: entry.error },
        scores: {
          opened: entry.success ? 1 : 0,
          ready_to_use: entry.success && entry.setupRan ? 1 : 0,
        },
        metadata: { durationMs: entry.durationMs, baseImage: entry.baseImage },
      });
    },
    { name: "openTerminal", type: "task" }
  );
}

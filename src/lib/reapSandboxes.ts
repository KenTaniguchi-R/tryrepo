import { Daytona, SandboxState } from "@daytona/sdk";

/**
 * Daytona enforces a total disk quota (30GiB on the free tier) and dead
 * sandboxes keep consuming it. Once it's full, every create fails with
 * "Total disk limit exceeded" -- which reads like a per-repo build failure
 * and takes the whole app down until someone manually cleans up.
 *
 * So before each deploy we reap sandboxes that can't be serving anyone:
 *   - terminal-state ones (build_failed / error / stopped / archived), which
 *     are pure quota waste, and
 *   - ones older than the preview lifetime, whose URLs have already expired.
 *
 * A running sandbox inside its lifetime is never touched -- someone may be
 * looking at it right now.
 */

const PREVIEW_LIFETIME_MS = 30 * 60 * 1000; // matches autoDeleteInterval: 30
const GRACE_MS = 5 * 60 * 1000;

const DEAD_STATES = new Set<SandboxState>([
  SandboxState.BUILD_FAILED,
  SandboxState.ERROR,
  SandboxState.STOPPED,
  SandboxState.ARCHIVED,
  SandboxState.DESTROYED,
]);

export async function reapExpiredSandboxes(
  daytona: Daytona,
  now: number = Date.now()
): Promise<number> {
  let reaped = 0;

  try {
    for await (const sandbox of daytona.list()) {
      const isDead = sandbox.state !== undefined && DEAD_STATES.has(sandbox.state);
      const createdAt = sandbox.createdAt ? Date.parse(sandbox.createdAt) : NaN;
      const isExpired =
        !Number.isNaN(createdAt) && now - createdAt > PREVIEW_LIFETIME_MS + GRACE_MS;

      if (!isDead && !isExpired) continue;

      try {
        await sandbox.delete();
        reaped++;
      } catch {
        // Another request may be deleting it, or it's mid-state-change.
        // Not worth failing the deploy over.
      }
    }
  } catch {
    // Reaping is opportunistic -- never block a deploy because listing failed.
  }

  return reaped;
}

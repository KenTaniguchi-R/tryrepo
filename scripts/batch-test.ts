/**
 * Runs every repo in src/data/trending-repos.json through the real deploy
 * pipeline and reports how many actually end up serving a live page.
 *
 * This is where the "X of 20 trending repos work" number comes from -- it is
 * measured, not estimated. Results are written to batch-results.json.
 *
 *   pnpm exec tsx scripts/batch-test.ts
 */
import { writeFile } from "node:fs/promises";
import { Daytona } from "@daytona/sdk";
import trending from "../src/data/trending-repos.json";
import { deployRepo } from "../src/lib/deploy";
import { closeSession, getSession, sendInput, startTerminalSession } from "../src/lib/terminal";

const CONCURRENCY = 2; // Daytona co-locates sandboxes on shared runners; keep this low (see daytonaio/daytona#5137)
const VERIFY_ATTEMPTS = 8;
const VERIFY_DELAY_MS = 4000;

type Outcome =
  | "served"
  | "terminal"
  | "terminal_failed"
  | "build_failed"
  | "started_but_not_http"
  | "quota_exhausted";

interface Result {
  name: string;
  outcome: Outcome;
  dockerfileSource?: "repo" | "synthesized";
  previewUrl?: string;
  httpStatus?: number;
  detail?: string;
  elapsedMs: number;
}

/**
 * A repo with no web UI isn't a failure any more -- the product opens an
 * interactive shell instead. Verify that path for real: start the PTY, run a
 * command, and confirm the output comes back.
 */
async function verifyTerminal(repoUrl: string): Promise<{ ok: boolean; detail?: string }> {
  let sessionId: string | undefined;
  try {
    const started = await startTerminalSession(repoUrl, "batch-test");
    sessionId = started.sessionId;

    const session = getSession(sessionId);
    if (!session) return { ok: false, detail: "session vanished after start" };

    let output = "";
    const listener = (chunk: Uint8Array) => {
      output += Buffer.from(chunk).toString("utf8");
    };
    session.listeners.add(listener);

    await sendInput(sessionId, "echo TRYREPO_PTY_OK\n");
    for (let i = 0; i < 10 && !output.includes("TRYREPO_PTY_OK"); i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    session.listeners.delete(listener);

    // The echoed keystrokes also contain the marker, so require it twice:
    // once as the typed line, once as the command's actual output.
    const hits = output.split("TRYREPO_PTY_OK").length - 1;
    return hits >= 2
      ? { ok: true }
      : { ok: false, detail: `shell did not echo back the test command (hits=${hits})` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (sessionId) await closeSession(sessionId).catch(() => {});
  }
}

async function verifyServes(url: string): Promise<{ ok: boolean; status?: number }> {
  for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return { ok: true, status: res.status };
      // A 502 from the Daytona proxy means the port isn't serving HTTP (yet).
      if (i === VERIFY_ATTEMPTS - 1) return { ok: false, status: res.status };
    } catch {
      // network error / timeout -- keep waiting for the app to boot
    }
    await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
  }
  return { ok: false };
}

async function cleanup(sandboxId: string) {
  try {
    const daytona = new Daytona();
    const sandbox = await daytona.get(sandboxId);
    await sandbox.delete();
  } catch {
    // best-effort -- autoDeleteInterval will reap it anyway
  }
}

async function testRepo(name: string, url: string): Promise<Result> {
  const startedAt = Date.now();
  try {
    const result = await deployRepo(url);
    const { ok, status } = await verifyServes(result.previewUrl);
    await cleanup(result.sandboxId);

    return {
      name,
      outcome: ok ? "served" : "started_but_not_http",
      dockerfileSource: result.dockerfileSource,
      previewUrl: result.previewUrl,
      httpStatus: status,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    // Quota exhaustion is an account-level problem, NOT the repo's fault --
    // it must never be counted as a build failure or the numbers are garbage.
    if (detail.includes("disk limit exceeded") || detail.includes("concurrency limit")) {
      return {
        name,
        outcome: "quota_exhausted",
        detail: detail.slice(0, 300),
        elapsedMs: Date.now() - startedAt,
      };
    }

    // Not a web app -> the product falls back to an interactive shell, so
    // measure whether that actually works rather than calling it a failure.
    if (detail.includes("web-servable")) {
      const term = await verifyTerminal(url);
      return {
        name,
        outcome: term.ok ? "terminal" : "terminal_failed",
        detail: term.ok ? detail.slice(0, 200) : term.detail,
        elapsedMs: Date.now() - startedAt,
      };
    }

    return {
      name,
      outcome: "build_failed",
      detail: detail.slice(0, 300),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

async function main() {
  // Optional CLI filter: pass repo names to re-test just those.
  //   pnpm exec tsx scripts/batch-test.ts schollz/croc agegr/pi-web
  const only = new Set(process.argv.slice(2));
  const repos = trending.repos
    .filter((r) => only.size === 0 || only.has(r.name))
    .map((r) => ({ name: r.name, url: r.url }));
  const results: Result[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < repos.length) {
      const { name, url } = repos[cursor++];
      console.log(`[start] ${name}`);
      const result = await testRepo(name, url);
      results.push(result);
      console.log(
        `[done ] ${name}: ${result.outcome}` +
          (result.dockerfileSource ? ` (${result.dockerfileSource})` : "") +
          ` ${Math.round(result.elapsedMs / 1000)}s`
      );
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const served = results.filter((r) => r.outcome === "served");
  const terminal = results.filter((r) => r.outcome === "terminal");
  const usable = served.length + terminal.length;

  console.log("\n===== SUMMARY =====");
  console.log(`total repos:              ${results.length}`);
  console.log(
    `USABLE (something to try): ${usable}/${results.length} ` +
      `(${Math.round((usable / results.length) * 100)}%)`
  );
  console.log(`  live web preview:       ${served.length}`);
  console.log(`    from repo Dockerfile: ${served.filter((r) => r.dockerfileSource === "repo").length}`);
  console.log(`    from generated one:   ${served.filter((r) => r.dockerfileSource === "synthesized").length}`);
  console.log(`  interactive terminal:   ${terminal.length}`);
  console.log(`\nall outcomes:`, counts);

  const quota = results.filter((r) => r.outcome === "quota_exhausted").length;
  if (quota > 0) {
    console.log(
      `\n!! ${quota} repo(s) hit the Daytona account quota, not a real failure. ` +
        `Run scripts/cleanup-sandboxes.ts and re-test those before trusting these numbers.`
    );
  }

  await writeFile(
    "batch-results.json",
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2)
  );
  console.log("\nwrote batch-results.json");
}

main();

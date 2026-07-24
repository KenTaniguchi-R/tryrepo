import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Daytona, Image } from "@daytona/sdk";
import type { Sandbox } from "@daytona/sdk";
import { analyzeRepo } from "./analyzeRepo";
import { reapExpiredSandboxes } from "./reapSandboxes";
import { cloneRepo, normalizeRepoUrl } from "./repo";
import { attachDeployment, createWorkspace, sweepWorkspaces } from "./workspace";

export type DeployProgress = (message: string) => void;

export interface DeployResult {
  previewUrl: string;
  sandboxId: string;
  port: number;
  runCommand: string;
  dockerfileSource: "repo" | "synthesized";
  workspaceId: string;
}

async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseDockerfileArrayOrShell(raw: string): string {
  const arrayMatch = raw.match(/\[(.*)\]/);
  if (arrayMatch) {
    return arrayMatch[1]
      .split(",")
      .map((p) => p.trim().replace(/^["']|["']$/g, ""))
      .join(" ");
  }
  return raw.trim();
}

/**
 * Daytona's own in-sandbox agent needs to run as root to handle exec/session
 * requests. A Dockerfile ending in a non-root `USER` directive (a common,
 * otherwise-sensible security practice) reproducibly breaks sandbox startup
 * entirely -- confirmed with a controlled test: the identical fixture passed
 * with no USER line and failed on both of two independent fresh sandboxes
 * with one added. We don't need container-user hardening for an ephemeral
 * trial sandbox, so strip it rather than fail repos that follow best practice.
 */
function stripUserDirective(dockerfileContent: string): { content: string; stripped: boolean } {
  let stripped = false;
  const lines = dockerfileContent.split("\n").map((line) => {
    if (/^\s*USER\s+\S+/i.test(line)) {
      stripped = true;
      return `# ${line} (stripped by tryrepo -- Daytona sandboxes require root)`;
    }
    return line;
  });
  return { content: lines.join("\n"), stripped };
}

function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/**
 * Runtime env vars can be passed to daytona.create({ envVars }), but variables
 * consumed *during the build* (frontend frameworks routinely inline them at
 * build time) have to exist inside the image build itself. Injecting an ENV
 * line after every FROM covers both the build stages and the final stage of a
 * multi-stage build.
 *
 * Note this bakes the values into the image layers. Acceptable here because
 * sandboxes are private, single-use, and auto-deleted after 30 minutes -- but
 * it's the reason this is not a "bring your production secrets" feature.
 */
function injectBuildTimeEnv(dockerfileContent: string, envVars: Record<string, string>): string {
  const names = Object.keys(envVars);
  if (names.length === 0) return dockerfileContent;

  const envBlock = names
    .map((name) => `ENV ${name}="${escapeEnvValue(envVars[name])}"`)
    .join("\n");

  return dockerfileContent
    .split("\n")
    .map((line) => (/^\s*FROM\s+\S+/i.test(line) ? `${line}\n${envBlock}` : line))
    .join("\n");
}

function detectExposedPort(dockerfileContent: string): number {
  const match = dockerfileContent.match(/^\s*EXPOSE\s+(\d+)/im);
  return match ? parseInt(match[1], 10) : 8000;
}

function detectRunCommand(dockerfileContent: string): string {
  let cmd: string | null = null;
  let entrypoint: string | null = null;
  for (const line of dockerfileContent.split("\n")) {
    const cmdMatch = line.match(/^\s*CMD\s+(.*)/i);
    if (cmdMatch) cmd = cmdMatch[1];
    const entrypointMatch = line.match(/^\s*ENTRYPOINT\s+(.*)/i);
    if (entrypointMatch) entrypoint = entrypointMatch[1];
  }
  if (entrypoint && cmd) {
    return `${parseDockerfileArrayOrShell(entrypoint)} ${parseDockerfileArrayOrShell(cmd)}`;
  }
  if (entrypoint) return parseDockerfileArrayOrShell(entrypoint);
  if (cmd) return parseDockerfileArrayOrShell(cmd);
  throw new Error(
    "Could not find a CMD or ENTRYPOINT in the Dockerfile -- don't know how to start this app."
  );
}


const MAX_SANDBOX_ATTEMPTS = 2;

// Passed as a fake "now" to the reaper when the account is out of quota, so
// even in-lifetime previews look expired and get reclaimed. Only used in that
// already-broken state, where the alternative is failing every deploy.
const PREVIEW_LIFETIME_GRACE_MS = 60 * 60 * 1000;

/**
 * Known Daytona platform issue: a sandbox can report "started" before its
 * container is actually network-reachable, or (under concurrent load) get
 * starved/killed on a shared runner -- both surface as the same misleading
 * "failed to resolve container IP" 400 error (see daytonaio/daytona#4142,
 * #5137, both open as of 2026-07-24). Retrying the session call alone isn't
 * always enough if the underlying container is actually dead, so on
 * persistent failure we throw the sandbox away and create a fresh one rather
 * than retrying the same one forever.
 */
async function createSandboxAndStartSession(
  daytona: Daytona,
  image: Image,
  runCommand: string,
  envVars: Record<string, string>,
  onProgress: DeployProgress
): Promise<Sandbox> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_SANDBOX_ATTEMPTS; attempt++) {
    let sandbox: Sandbox | undefined;
    try {
      // Default create() timeout is 60s -- too short once a build compiles from
      // source (e.g. a Go/Rust project) instead of just installing prebuilt deps.
      sandbox = await daytona.create(
        { image, public: true, autoDeleteInterval: 30, envVars },
        { timeout: 240 }
      );
      onProgress(
        `Sandbox ${sandbox.id} created (attempt ${attempt}/${MAX_SANDBOX_ATTEMPTS}) -- starting app with: ${runCommand}`
      );

      await retry(() => sandbox!.process.createSession("app"), 8, 4000);
      await sandbox.process.executeSessionCommand("app", {
        command: `cd /repo && ${runCommand}`,
        runAsync: true,
      });
      return sandbox;
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);

      // Quota exhaustion isn't this repo's fault and retrying identically
      // won't help -- reap hard (including still-running previews) and let
      // the next attempt through, rather than failing the user's deploy.
      if (message.includes("disk limit exceeded") || message.includes("concurrency limit")) {
        onProgress("Account sandbox quota is full -- reclaiming space...");
        await reapExpiredSandboxes(daytona, Date.now() + PREVIEW_LIFETIME_GRACE_MS);
      } else {
        onProgress(
          `Sandbox${sandbox ? ` ${sandbox.id}` : ""} attempt ${attempt} failed -- ` +
            (attempt < MAX_SANDBOX_ATTEMPTS ? "retrying with a fresh sandbox..." : "giving up")
        );
      }

      if (sandbox) await sandbox.delete().catch(() => {});
    }
  }

  throw lastErr;
}

/**
 * Clones a repo, builds a Daytona sandbox image from its Dockerfile (or a
 * Fireworks-synthesized one if it doesn't have one), explicitly starts the
 * app (Daytona does not auto-run the Dockerfile CMD -- confirmed via a live
 * spike), and returns a public, auto-expiring preview URL.
 *
 * `envVars` are the values the user supplied when analyzeRepo reported that
 * this repo needs them; they're applied both at build time (injected into the
 * Dockerfile) and at runtime (passed to the sandbox).
 */
export async function deployRepo(
  repoUrlInput: string,
  envVars: Record<string, string> = {},
  onProgress: DeployProgress = () => {}
): Promise<DeployResult> {
  const repoUrl = normalizeRepoUrl(repoUrlInput);

  onProgress(`Analyzing ${repoUrl}...`);
  const analysis = await analyzeRepo(repoUrl);
  if (!analysis.webServable) {
    throw new Error(
      `This doesn't look like a web-servable project (${analysis.reasoning}). ` +
        "Not supported yet -- tryrepo only handles projects that run an HTTP server."
    );
  }

  onProgress(`Cloning ${repoUrl}...`);
  const workDir = await cloneRepo(repoUrl);
  await sweepWorkspaces();
  const workspace = createWorkspace(repoUrl, workDir);

  {
    const dockerfilePath = join(workDir, "Dockerfile");

    if (analysis.dockerfileSource === "synthesized") {
      if (!analysis.synthesizedDockerfile) {
        throw new Error("No Dockerfile in the repo and none could be generated for it.");
      }
      await writeFile(dockerfilePath, analysis.synthesizedDockerfile, "utf8");
      onProgress("Using generated Dockerfile...");
    } else if (!(await fileExists(dockerfilePath))) {
      throw new Error("Expected a Dockerfile at the repo root but none was found.");
    }

    const rawDockerfileContent = await readFile(dockerfilePath, "utf8");
    const { content: strippedContent, stripped } = stripUserDirective(rawDockerfileContent);
    if (stripped) {
      onProgress("Removed non-root USER directive (Daytona sandboxes require root)...");
    }

    const dockerfileContent = injectBuildTimeEnv(strippedContent, envVars);
    if (Object.keys(envVars).length > 0) {
      onProgress(`Applying ${Object.keys(envVars).length} environment variable(s)...`);
    }
    // Trailing newline is REQUIRED: Image.addLocalDir() appends its COPY
    // instruction to this content without inserting one, so a Dockerfile
    // ending in e.g. "WORKDIR /app" silently becomes "WORKDIR /appCOPY ...".
    // Most real repos end with a newline, which is why this stayed hidden.
    await writeFile(dockerfilePath, dockerfileContent.replace(/\n*$/, "\n"), "utf8");

    const port = detectExposedPort(dockerfileContent);
    const runCommand = detectRunCommand(dockerfileContent);

    onProgress("Building sandbox image...");
    const image = Image.fromDockerfile(dockerfilePath).addLocalDir(workDir, "/repo");

    const daytona = new Daytona();

    // Free quota from dead/expired sandboxes first -- a full account fails
    // every create with a misleading "disk limit exceeded" error.
    const reaped = await reapExpiredSandboxes(daytona);
    if (reaped > 0) onProgress(`Reclaimed ${reaped} expired sandbox(es)...`);

    const sandbox = await createSandboxAndStartSession(
      daytona,
      image,
      runCommand,
      envVars,
      onProgress
    );

    onProgress(`Exposing port ${port}...`);
    const preview = await sandbox.getPreviewLink(port);
    onProgress(`Live at ${preview.url}`);

    attachDeployment(workspace.id, preview.url, sandbox.id);

    return {
      previewUrl: preview.url,
      sandboxId: sandbox.id,
      port,
      runCommand,
      dockerfileSource: analysis.dockerfileSource,
      workspaceId: workspace.id,
    };
  }
}

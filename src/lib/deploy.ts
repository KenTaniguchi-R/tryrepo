import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Daytona, Image } from "@daytona/sdk";

const execFileAsync = promisify(execFile);

export type DeployProgress = (message: string) => void;

export interface DeployResult {
  previewUrl: string;
  sandboxId: string;
  port: number;
  runCommand: string;
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

function normalizeRepoUrl(input: string): string {
  const trimmed = input.trim();
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("git@") ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("/")
  ) {
    return trimmed;
  }
  // allow shorthand like "owner/repo"
  return `https://github.com/${trimmed}.git`;
}

/**
 * Clones a repo, requires a root Dockerfile (MVP scope), builds a Daytona
 * sandbox image from it, explicitly starts the app (Daytona does not
 * auto-run the Dockerfile CMD -- confirmed via a live spike), and returns
 * a public, auto-expiring preview URL.
 */
export async function deployRepo(
  repoUrlInput: string,
  onProgress: DeployProgress = () => {}
): Promise<DeployResult> {
  const repoUrl = normalizeRepoUrl(repoUrlInput);
  const workDir = await mkdtemp(join(tmpdir(), "tryrepo-"));

  try {
    onProgress(`Cloning ${repoUrl}...`);
    await execFileAsync("git", ["clone", "--depth", "1", repoUrl, workDir], {
      timeout: 60_000,
    });

    const dockerfilePath = join(workDir, "Dockerfile");
    if (!(await fileExists(dockerfilePath))) {
      throw new Error(
        "No Dockerfile found at the repo root. This MVP only supports Dockerfile-based repos."
      );
    }

    const dockerfileContent = await readFile(dockerfilePath, "utf8");
    const port = detectExposedPort(dockerfileContent);
    const runCommand = detectRunCommand(dockerfileContent);

    onProgress("Found Dockerfile -- building sandbox image...");
    const image = Image.fromDockerfile(dockerfilePath).addLocalDir(workDir, "/repo");

    const daytona = new Daytona();
    const sandbox = await daytona.create({
      image,
      public: true,
      autoDeleteInterval: 30,
    });
    onProgress(`Sandbox ${sandbox.id} created -- starting app with: ${runCommand}`);

    await sandbox.process.createSession("app");
    await sandbox.process.executeSessionCommand("app", {
      command: `cd /repo && ${runCommand}`,
      runAsync: true,
    });

    onProgress(`Exposing port ${port}...`);
    const preview = await sandbox.getPreviewLink(port);
    onProgress(`Live at ${preview.url}`);

    return { previewUrl: preview.url, sandboxId: sandbox.id, port, runCommand };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

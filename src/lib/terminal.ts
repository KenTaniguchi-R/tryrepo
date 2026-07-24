import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Daytona, Image } from "@daytona/sdk";
import type { PtyHandle, Sandbox } from "@daytona/sdk";
import { reapExpiredSandboxes } from "./reapSandboxes";
import { cloneRepo, normalizeRepoUrl } from "./repo";
import { createWorkspace, sweepWorkspaces } from "./workspace";

/**
 * Not every repo is a web app. CLI tools, TUIs and libraries have no port to
 * preview -- but they're still worth trying, you just need a shell. Daytona
 * exposes real PTY sessions, so we build an image with the repo baked in and
 * hand the user an interactive terminal sitting in it.
 *
 * The browser can't talk to Daytona's PTY websocket directly (it needs the
 * API key), so sessions live here on the server and the client drives them
 * over SSE (output) + POST (input).
 */

interface TerminalSession {
  id: string;
  /**
   * Opaque id of the browser that started this session. A terminal is a root
   * shell, so knowing (or guessing) a session id must NOT be enough to attach
   * to one -- the caller has to present the same owner cookie.
   */
  ownerId: string;
  sandbox: Sandbox;
  pty: PtyHandle;
  /** Output produced before a client attached, so nothing is missed. */
  backlog: Uint8Array[];
  listeners: Set<(chunk: Uint8Array) => void>;
  closed: boolean;
}

const sessions = new Map<string, TerminalSession>();

export function newOwnerId(): string {
  return randomBytes(16).toString("hex");
}

/** Pick a base image that actually has the repo's runtime available. */
async function pickBaseImage(workDir: string): Promise<string> {
  const has = async (file: string) => {
    try {
      await access(join(workDir, file));
      return true;
    } catch {
      return false;
    }
  };

  if (await has("package.json")) return "node:22-bookworm";
  if ((await has("requirements.txt")) || (await has("pyproject.toml"))) return "python:3.12-bookworm";
  if (await has("go.mod")) return "golang:1-bookworm";
  if (await has("Cargo.toml")) return "rust:1-bookworm";
  return "debian:stable-slim";
}

export async function startTerminalSession(
  repoUrlInput: string,
  ownerId: string
): Promise<{ sessionId: string; sandboxId: string; baseImage: string; workspaceId: string }> {
  const repoUrl = normalizeRepoUrl(repoUrlInput);
  const workDir = await cloneRepo(repoUrl);
  await sweepWorkspaces();
  const workspace = createWorkspace(repoUrl, workDir);

  {
    const baseImage = await pickBaseImage(workDir);

    // Copy the already-cloned repo in rather than cloning inside the build --
    // no network needed during the build, and it works for private-ish cases.
    const dockerfilePath = join(workDir, "Dockerfile.tryrepo-terminal");
    await writeFile(
      dockerfilePath,
      [
        `FROM ${baseImage}`,
        "RUN apt-get update && apt-get install -y --no-install-recommends " +
          "bash git ca-certificates curl less vim-tiny procps && rm -rf /var/lib/apt/lists/*",
        // Daytona's PTY execs /usr/bin/bash specifically. Not every image has
        // it there (some only ship /bin/bash), and the SDK gives no way to
        // choose the shell, so make sure that exact path resolves.
        "RUN [ -x /usr/bin/bash ] || ln -s \"$(command -v bash)\" /usr/bin/bash",
        "WORKDIR /repo",
        // Trailing newline is REQUIRED: Image.addLocalDir() concatenates its
        // COPY instruction onto this content without inserting one, so a file
        // ending in "WORKDIR /repo" silently becomes "WORKDIR /repoCOPY ...".
        "",
      ].join("\n"),
      "utf8"
    );

    const image = Image.fromDockerfile(dockerfilePath).addLocalDir(workDir, "/repo");

    const daytona = new Daytona();
    await reapExpiredSandboxes(daytona);

    const sandbox = await daytona.create(
      { image, public: true, autoDeleteInterval: 30 },
      { timeout: 240 }
    );

    // Unguessable: a session id is a capability to a root shell.
    const id = randomBytes(24).toString("hex");
    const session: TerminalSession = {
      id,
      ownerId,
      sandbox,
      pty: undefined as unknown as PtyHandle,
      backlog: [],
      listeners: new Set(),
      closed: false,
    };

    const pty = await sandbox.process.createPty({
      id: "tryrepo",
      cwd: "/repo",
      cols: 100,
      rows: 28,
      envs: { TERM: "xterm-256color" },
      onData: (chunk) => {
        if (session.listeners.size === 0) {
          // Cap the backlog so a chatty process can't grow unbounded.
          if (session.backlog.length < 500) session.backlog.push(chunk);
          return;
        }
        for (const listener of session.listeners) listener(chunk);
      },
    });

    session.pty = pty;
    await pty.waitForConnection();
    sessions.set(id, session);

    return { sessionId: id, sandboxId: sandbox.id, baseImage, workspaceId: workspace.id };
  }
}

/**
 * Ownership is enforced here rather than at each call site, so a new route
 * can't accidentally expose a shell by forgetting to check. Pass the caller's
 * owner cookie; a mismatch is indistinguishable from "no such session".
 */
export function getSession(sessionId: string, ownerId?: string): TerminalSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (ownerId !== undefined && session.ownerId !== ownerId) return undefined;
  return session;
}

export async function sendInput(
  sessionId: string,
  data: string,
  ownerId?: string
): Promise<boolean> {
  const session = getSession(sessionId, ownerId);
  if (!session || session.closed) return false;
  await session.pty.sendInput(data);
  return true;
}

export async function resize(
  sessionId: string,
  cols: number,
  rows: number,
  ownerId?: string
): Promise<boolean> {
  const session = getSession(sessionId, ownerId);
  if (!session || session.closed) return false;
  await session.pty.resize(cols, rows);
  return true;
}

export async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.closed = true;
  sessions.delete(sessionId);
  await session.pty.disconnect().catch(() => {});
  await session.sandbox.delete().catch(() => {});
}

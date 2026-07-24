import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

/**
 * A cloned repo that outlives the deploy that produced it, so the agent can
 * still read the code while the user is looking at the running app.
 *
 * Deliberately in-memory and unpersisted: a server restart loses these, and
 * the sweeper is the only reclamation path. That is the same trade terminal.ts
 * makes for PTY sessions.
 *
 * Ids are random rather than sequential. A workspace id is the only thing
 * guarding a clone's contents, and the tools that take one perform no other
 * authorization check, so a guessable id would let one caller read another's
 * checkout.
 */
export interface Workspace {
  id: string;
  workDir: string;
  repoUrl: string;
  previewUrl?: string;
  sandboxId?: string;
  createdAt: number;
}

/** Sits just past the sandbox's own 30-minute autoDeleteInterval. */
export const WORKSPACE_TTL_MS = 35 * 60 * 1000;

const workspaces = new Map<string, Workspace>();

export function createWorkspace(
  repoUrl: string,
  workDir: string,
  now: number = Date.now()
): Workspace {
  const id = `ws-${randomBytes(16).toString("base64url")}`;
  const workspace: Workspace = { id, workDir, repoUrl, createdAt: now };
  workspaces.set(id, workspace);
  return workspace;
}

export function getWorkspace(id: string): Workspace | undefined {
  return workspaces.get(id);
}

export function attachDeployment(id: string, previewUrl: string, sandboxId: string): void {
  const workspace = workspaces.get(id);
  if (!workspace) return;
  workspace.previewUrl = previewUrl;
  workspace.sandboxId = sandboxId;
}

export async function closeWorkspace(id: string): Promise<void> {
  const workspace = workspaces.get(id);
  if (!workspace) return;
  workspaces.delete(id);
  await rm(workspace.workDir, { recursive: true, force: true }).catch(() => {});
}

/** Reclaims expired clones. Never throws -- cleanup must not break a request. */
export async function sweepWorkspaces(now: number = Date.now()): Promise<number> {
  let swept = 0;
  for (const [id, workspace] of workspaces) {
    if (now - workspace.createdAt <= WORKSPACE_TTL_MS) continue;
    await closeWorkspace(id);
    swept++;
  }
  return swept;
}

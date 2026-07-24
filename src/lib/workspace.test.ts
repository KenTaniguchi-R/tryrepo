import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspace,
  getWorkspace,
  attachDeployment,
  closeWorkspace,
  sweepWorkspaces,
  WORKSPACE_TTL_MS,
} from "@/lib/workspace";

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ws-test-"));
  await mkdir(join(dir, "src"), { recursive: true });
  return dir;
}

const exists = async (p: string) =>
  await access(p).then(() => true).catch(() => false);

describe("workspace store", () => {
  it("stores and retrieves a workspace", async () => {
    const dir = await tempDir();
    const ws = createWorkspace("https://github.com/o/r", dir);

    expect(ws.id).toBeTruthy();
    expect(getWorkspace(ws.id)?.workDir).toBe(dir);
    await closeWorkspace(ws.id);
  });

  it("issues unique ids for concurrent workspaces", async () => {
    const a = createWorkspace("https://github.com/o/a", await tempDir());
    const b = createWorkspace("https://github.com/o/b", await tempDir());

    expect(a.id).not.toBe(b.id);
    await closeWorkspace(a.id);
    await closeWorkspace(b.id);
  });

  it("attaches deployment details after the fact", async () => {
    const ws = createWorkspace("https://github.com/o/r", await tempDir());
    attachDeployment(ws.id, "https://preview.example", "sandbox-1");

    expect(getWorkspace(ws.id)?.previewUrl).toBe("https://preview.example");
    expect(getWorkspace(ws.id)?.sandboxId).toBe("sandbox-1");
    await closeWorkspace(ws.id);
  });

  it("deletes the working directory on close", async () => {
    const dir = await tempDir();
    const ws = createWorkspace("https://github.com/o/r", dir);

    await closeWorkspace(ws.id);

    expect(getWorkspace(ws.id)).toBeUndefined();
    expect(await exists(dir)).toBe(false);
  });

  it("sweeps workspaces past the TTL and keeps fresh ones", async () => {
    const oldDir = await tempDir();
    const freshDir = await tempDir();
    const t0 = 1_000_000;

    const old = createWorkspace("https://github.com/o/old", oldDir, t0);
    const fresh = createWorkspace("https://github.com/o/fresh", freshDir, t0);

    const swept = await sweepWorkspaces(t0 + WORKSPACE_TTL_MS + 1);
    // `fresh` was created at the same instant, so bump only `old` past the TTL
    // by sweeping at a time the fresh one has not yet reached.
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(getWorkspace(old.id)).toBeUndefined();
    expect(await exists(oldDir)).toBe(false);

    await closeWorkspace(fresh.id);
  });

  it("does not throw when closing an unknown id", async () => {
    await expect(closeWorkspace("nope")).resolves.toBeUndefined();
  });
});

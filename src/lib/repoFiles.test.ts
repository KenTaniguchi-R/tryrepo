import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInside } from "@/lib/repoFiles";

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "guard-"));
  root = join(base, "repo");
  outside = join(base, "secrets");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export {}", "utf8");
  await writeFile(join(outside, "creds.txt"), "SECRET", "utf8");
  await symlink(join(outside, "creds.txt"), join(root, "escape-link"));
});

describe("resolveInside", () => {
  it("resolves a normal file inside the repo", async () => {
    const p = await resolveInside(root, "src/index.ts");
    expect(p.endsWith(join("src", "index.ts"))).toBe(true);
  });

  it("allows the repo root itself", async () => {
    await expect(resolveInside(root, ".")).resolves.toBeTruthy();
  });

  it("rejects parent-directory traversal", async () => {
    await expect(resolveInside(root, "../secrets/creds.txt")).rejects.toThrow();
    await expect(resolveInside(root, "../../etc/passwd")).rejects.toThrow();
  });

  it("rejects absolute paths", async () => {
    await expect(resolveInside(root, "/etc/passwd")).rejects.toThrow();
  });

  it("rejects a symlink pointing outside the repo", async () => {
    await expect(resolveInside(root, "escape-link")).rejects.toThrow();
  });

  it("rejects a sibling directory sharing the root's name prefix", async () => {
    // /tmp/x/repo must not admit /tmp/x/repo-evil via a prefix match
    await expect(resolveInside(root, "../repo-evil/file.txt")).rejects.toThrow();
  });

  it("allows a path for a file that does not exist yet", async () => {
    await expect(resolveInside(root, "src/missing.ts")).resolves.toBeTruthy();
  });
});

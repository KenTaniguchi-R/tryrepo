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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readRepoFile, listRepoFiles, grepRepo } from "@/lib/repoFiles";

const execFileAsync = promisify(execFile);

describe("repo file primitives", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "files-"));
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "node_modules", "junk"), { recursive: true });
    await writeFile(
      join(repo, "src", "app.ts"),
      ["import x from 'y';", "export function handleLogin() {}", "// trailing"].join("\n"),
      "utf8"
    );
    await writeFile(join(repo, "README.md"), "# Demo\n", "utf8");
    await writeFile(join(repo, "node_modules", "junk", "b.js"), "handleLogin", "utf8");
    await writeFile(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));

    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    await execFileAsync("git", ["add", "-A"], { cwd: repo });
    await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  });

  it("reads a file", async () => {
    const res = await readRepoFile(repo, "src/app.ts");
    expect(res.lines).toContain("handleLogin");
    expect(res.lines.startsWith("1\t")).toBe(true);
    expect(res.truncated).toBe(false);
  });

  it("reads a slice with offset and limit", async () => {
    const res = await readRepoFile(repo, "src/app.ts", { offset: 2, limit: 1 });
    expect(res.lines.trim()).toBe("2\texport function handleLogin() {}");
  });

  it("refuses a binary file", async () => {
    await expect(readRepoFile(repo, "logo.png")).rejects.toThrow(/binary/i);
  });

  it("refuses to read outside the repo", async () => {
    await expect(readRepoFile(repo, "../../etc/passwd")).rejects.toThrow();
  });

  it("lists files and skips noise directories", async () => {
    const res = await listRepoFiles(repo);
    expect(res.entries.some((e) => e.includes("src/app.ts"))).toBe(true);
    expect(res.entries.some((e) => e.includes("node_modules"))).toBe(false);
  });

  it("caps the listing and reports truncation", async () => {
    const res = await listRepoFiles(repo, { maxEntries: 1 });
    expect(res.entries).toHaveLength(1);
    expect(res.truncated).toBe(true);
  });

  it("greps tracked content", async () => {
    const res = await grepRepo(repo, "handleLogin");
    expect(res.matches.some((m) => m.includes("src/app.ts"))).toBe(true);
  });

  it("returns no matches without throwing", async () => {
    const res = await grepRepo(repo, "zzz-not-present-zzz");
    expect(res.matches).toEqual([]);
  });
});

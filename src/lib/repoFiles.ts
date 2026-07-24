import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

/** Directories never worth walking or searching. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
]);

/**
 * Resolves `relPath` against `workDir` and proves the result stays inside it.
 *
 * Lexical resolution alone is not enough: a symlink inside the repo can point
 * anywhere, so the candidate is realpath'd before the containment check. The
 * check appends a separator so a sibling like `/tmp/repo-evil` cannot satisfy
 * a prefix match against `/tmp/repo`.
 */
export async function resolveInside(workDir: string, relPath: string): Promise<string> {
  if (isAbsolute(relPath)) {
    throw new Error(`Absolute paths are not allowed: ${relPath}`);
  }

  const rootReal = await realpath(workDir);
  const candidate = resolve(rootReal, relPath);

  // The target may not exist yet; fall back to the lexically-resolved path,
  // which has already had any `..` segments collapsed.
  const real = await realpath(candidate).catch(() => candidate);

  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`Path escapes the workspace: ${relPath}`);
  }
  return real;
}

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BYTES = 256 * 1024;
const DEFAULT_LINE_LIMIT = 400;

/** A NUL byte in the first 4KB is the usual heuristic for "not text". */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 4096).includes(0);
}

export async function readRepoFile(
  workDir: string,
  relPath: string,
  opts: { offset?: number; limit?: number } = {}
): Promise<{ path: string; lines: string; truncated: boolean }> {
  const abs = await resolveInside(workDir, relPath);

  const info = await stat(abs);
  if (info.isDirectory()) throw new Error(`${relPath} is a directory, not a file`);
  if (info.size > MAX_BYTES) throw new Error(`${relPath} is too large to read (${info.size} bytes)`);

  const buf = await readFile(abs);
  if (looksBinary(buf)) throw new Error(`${relPath} looks binary and was not read`);

  const all = buf.toString("utf8").split("\n");
  const offset = Math.max(1, opts.offset ?? 1);
  const limit = Math.max(1, opts.limit ?? DEFAULT_LINE_LIMIT);
  const slice = all.slice(offset - 1, offset - 1 + limit);

  return {
    path: relPath,
    lines: slice.map((line, i) => `${offset + i}\t${line}`).join("\n"),
    truncated: offset - 1 + limit < all.length,
  };
}

export async function listRepoFiles(
  workDir: string,
  opts: { subdir?: string; depth?: number; maxEntries?: number } = {}
): Promise<{ entries: string[]; truncated: boolean }> {
  const start = await resolveInside(workDir, opts.subdir ?? ".");
  const maxDepth = opts.depth ?? 3;
  const maxEntries = opts.maxEntries ?? 300;
  const entries: string[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated || depth > maxDepth) return;
    const found = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of found) {
      if (truncated) return;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const abs = join(dir, entry.name);
      const rel = relative(workDir, abs);
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      entries.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) await walk(abs, depth + 1);
    }
  }

  await walk(start, 1);
  return { entries, truncated };
}

export async function grepRepo(
  workDir: string,
  pattern: string,
  opts: { glob?: string; maxResults?: number } = {}
): Promise<{ matches: string[]; truncated: boolean }> {
  const maxResults = opts.maxResults ?? 60;

  // `--untracked` matters: deploy.ts writes a synthesized Dockerfile into the
  // clone that git does not know about yet. Exit code 1 means "no matches",
  // which execFile surfaces as a rejection, so it is handled rather than thrown.
  const args = [
    "grep",
    "--line-number",
    "--untracked",
    "-I",
    "--no-color",
    "--fixed-strings",
    "-e",
    pattern,
  ];
  if (opts.glob) args.push("--", opts.glob);

  const stdout = await execFileAsync("git", args, {
    cwd: workDir,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  })
    .then((r) => r.stdout)
    .catch((err: { code?: number; stdout?: string }) => (err.code === 1 ? "" : err.stdout ?? ""));

  const lines = stdout.split("\n").filter(Boolean);
  return { matches: lines.slice(0, maxResults), truncated: lines.length > maxResults };
}

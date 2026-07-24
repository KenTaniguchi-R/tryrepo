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

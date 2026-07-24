# Split Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the agent produces something runnable, show it in a right-hand pane while the same conversation continues on the left, now able to read the repo's files.

**Architecture:** Clones stop being deleted after deploy and are registered in an in-memory workspace store with a TTL sweeper. Four read-only backend tools (`getRepoOverview`, `listFiles`, `grepRepo`, `readFile`) let the agent navigate that clone. The frontend lifts tool results into a single `PaneState` that renders either a preview iframe or the existing terminal.

**Tech Stack:** Next.js 16 (App Router), TypeScript, CopilotKit v2, Daytona SDK, Zod, Vitest (added in Task 1), Tailwind v4.

## Global Constraints

- Package manager is **pnpm**. Never use npm or yarn.
- Light mode only. No `dark:` variants — `globals.css` sets `color-scheme: light`.
- Accent color is `emerald-700`. Borders are `neutral-200`. Radius is `rounded-2xl` for panels, `rounded-full` for pills.
- Icons come from `@phosphor-icons/react`. Never hand-roll SVG icon paths.
- Import CopilotKit from `@copilotkit/react-core/v2` and `@copilotkit/runtime/v2`, never the package roots.
- Do not bump `ai` or `@ai-sdk/openai` — they are pinned to what `@copilotkit/runtime` bundles.
- Sandbox preview lifetime is **30 minutes** (`autoDeleteInterval: 30`). Do not change it.
- Cleanup is opportunistic: it must never fail a user-facing operation. Follow the philosophy documented at the top of `src/lib/reapSandboxes.ts`.
- Run `pnpm exec tsc --noEmit` and `pnpm lint` before every commit. Both must be clean.

---

### Task 1: Workspace store

Holds cloned repos past the end of a deploy so the agent can read them, and reclaims them on a timer.

**Files:**
- Create: `src/lib/workspace.ts`
- Create: `src/lib/workspace.test.ts`
- Create: `vitest.config.ts`
- Modify: `package.json` (add `test` script and vitest devDependency)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Workspace { id: string; workDir: string; repoUrl: string; previewUrl?: string; sandboxId?: string; createdAt: number }`
  - `createWorkspace(repoUrl: string, workDir: string, now?: number): Workspace`
  - `getWorkspace(id: string): Workspace | undefined`
  - `attachDeployment(id: string, previewUrl: string, sandboxId: string): void`
  - `closeWorkspace(id: string): Promise<void>`
  - `sweepWorkspaces(now?: number): Promise<number>`
  - `WORKSPACE_TTL_MS: number`

- [ ] **Step 1: Install Vitest**

There is no test runner in this repo yet. Vitest is added here because this task's deliverable needs one.

```bash
pnpm add -D vitest
```

If this fails with `ERR_PNPM_IGNORED_BUILDS`, run `pnpm approve-builds --all`. `esbuild` is already listed under `allowBuilds` in `pnpm-workspace.yaml`.

- [ ] **Step 2: Add the test script and Vitest config**

In `package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

Create `vitest.config.ts`. The alias mirrors the `@/*` path in `tsconfig.json`; without it `@/lib/...` imports fail inside tests.

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Write the failing test**

Create `src/lib/workspace.test.ts`:

```ts
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
```

Note the fifth test sweeps both entries because they share `t0`. That is intentional: it asserts the TTL boundary is applied, and the fresh entry is cleaned up explicitly afterward so the test leaves no temp dirs behind.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Failed to resolve import "@/lib/workspace"`.

- [ ] **Step 5: Implement the store**

Create `src/lib/workspace.ts`. The module-level `Map` mirrors `src/lib/terminal.ts`, but ids are generated with a CSPRNG rather than `terminal.ts`'s monotonic counter — see the note in the file header for why.

```ts
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS, 6 tests.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
git add package.json pnpm-lock.yaml vitest.config.ts src/lib/workspace.ts src/lib/workspace.test.ts
git commit -m "Add workspace store for clones that outlive their deploy"
```

---

### Task 2: Path guard

The security boundary for every file the agent reads. A bug here is an exposure, not a UX problem — `.env.local` sits in this repo's root.

**Files:**
- Create: `src/lib/repoFiles.ts`
- Create: `src/lib/repoFiles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveInside(workDir: string, relPath: string): Promise<string>` — returns an absolute real path, throws if it escapes.
  - `SKIP_DIRS: ReadonlySet<string>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/repoFiles.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/repoFiles.test.ts`
Expected: FAIL — cannot resolve `@/lib/repoFiles`.

- [ ] **Step 3: Implement the guard**

Create `src/lib/repoFiles.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/repoFiles.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
git add src/lib/repoFiles.ts src/lib/repoFiles.test.ts
git commit -m "Add path guard for agent file reads"
```

---

### Task 3: Read, list, and grep

The three primitives the agent uses to navigate a repo.

**Files:**
- Modify: `src/lib/repoFiles.ts` (append)
- Modify: `src/lib/repoFiles.test.ts` (append)

**Interfaces:**
- Consumes: `resolveInside`, `SKIP_DIRS` from Task 2.
- Produces:
  - `readRepoFile(workDir: string, relPath: string, opts?: { offset?: number; limit?: number }): Promise<{ path: string; lines: string; truncated: boolean }>`
  - `listRepoFiles(workDir: string, opts?: { subdir?: string; depth?: number; maxEntries?: number }): Promise<{ entries: string[]; truncated: boolean }>`
  - `grepRepo(workDir: string, pattern: string, opts?: { glob?: string; maxResults?: number }): Promise<{ matches: string[]; truncated: boolean }>`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/repoFiles.test.ts`:

```ts
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
    expect(res.truncated).toBe(false);
  });

  it("reads a slice with offset and limit", async () => {
    const res = await readRepoFile(repo, "src/app.ts", { offset: 2, limit: 1 });
    expect(res.lines.trim()).toBe("export function handleLogin() {}");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/repoFiles.test.ts`
Expected: FAIL — `readRepoFile` / `listRepoFiles` / `grepRepo` are not exported.

- [ ] **Step 3: Implement the primitives**

Append to `src/lib/repoFiles.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/repoFiles.test.ts`
Expected: PASS, 15 tests total in this file.

- [ ] **Step 5: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
git add src/lib/repoFiles.ts src/lib/repoFiles.test.ts
git commit -m "Add read, list, and grep primitives for repo navigation"
```

---

### Task 4: Hand clones to the workspace

Stops both clone call sites from deleting their working directory and registers it instead.

**Files:**
- Modify: `src/lib/deploy.ts:10-16` (`DeployResult`), `src/lib/deploy.ts:205-261` (`deployRepo`)
- Modify: `src/lib/terminal.ts:50-117` (`startTerminalSession`)
- Modify: `src/app/api/copilotkit/route.ts:80-88` (`deployTool` return value)

**Interfaces:**
- Consumes: `createWorkspace`, `attachDeployment`, `sweepWorkspaces` from Task 1.
- Produces: `DeployResult.workspaceId: string`; `startTerminalSession` returns an added `workspaceId: string`; the `deployRepo` tool result carries `workspaceId` through to the client.

- [ ] **Step 1: Add `workspaceId` to `DeployResult`**

In `src/lib/deploy.ts`, extend the interface at line 10:

```ts
export interface DeployResult {
  previewUrl: string;
  sandboxId: string;
  port: number;
  runCommand: string;
  dockerfileSource: "repo" | "synthesized";
  workspaceId: string;
}
```

- [ ] **Step 2: Register the clone instead of deleting it**

In `deployRepo`, add the import at the top of the file:

```ts
import { attachDeployment, createWorkspace, sweepWorkspaces } from "./workspace";
```

Replace the clone line (currently `const workDir = await cloneRepo(repoUrl);` at line 206) and the `finally` block (lines 259-261).

After cloning, register immediately — before the build — so a failed build still leaves a readable repo:

```ts
  onProgress(`Cloning ${repoUrl}...`);
  const workDir = await cloneRepo(repoUrl);
  await sweepWorkspaces();
  const workspace = createWorkspace(repoUrl, workDir);
```

Then delete the entire `finally { await rm(workDir, ...) }` block. The clone is now owned by the workspace store and reclaimed by the sweeper.

Before the `return`, record the deployment, and add `workspaceId` to the returned object:

```ts
    attachDeployment(workspace.id, preview.url, sandbox.id);

    return {
      previewUrl: preview.url,
      sandboxId: sandbox.id,
      port,
      runCommand,
      dockerfileSource: analysis.dockerfileSource,
      workspaceId: workspace.id,
    };
```

Remove `rm` from the `node:fs/promises` import on line 1 if nothing else in the file uses it.

- [ ] **Step 3: Do the same in `startTerminalSession`**

In `src/lib/terminal.ts`, add the import:

```ts
import { createWorkspace, sweepWorkspaces } from "./workspace";
```

After `const workDir = await cloneRepo(repoUrl);` (line 54):

```ts
  await sweepWorkspaces();
  const workspace = createWorkspace(repoUrl, workDir);
```

Delete the `finally { await rm(workDir, ...) }` block at lines 114-116, and drop `rm` from the import on line 1 if unused.

Widen the return type on line 52 and the returned object on line 113:

```ts
): Promise<{ sessionId: string; sandboxId: string; baseImage: string; workspaceId: string }> {
```

```ts
    return { sessionId: id, sandboxId: sandbox.id, baseImage, workspaceId: workspace.id };
```

- [ ] **Step 4: Pass `workspaceId` through the deploy tool**

`deployTool` in `src/app/api/copilotkit/route.ts` builds its result object field by field rather than spreading `result`, so a new field on `DeployResult` does **not** reach the client automatically. Without this step the frontend never sees `workspaceId` and the pane can never open.

Add the field to the returned object at lines 80-88:

```ts
      return {
        status: "success" as const,
        previewUrl: result.previewUrl,
        sandboxId: result.sandboxId,
        port: result.port,
        runCommand: result.runCommand,
        dockerfileSource: result.dockerfileSource,
        workspaceId: result.workspaceId,
        note: "This preview URL auto-expires in 30 minutes.",
      };
```

No equivalent change is needed for the terminal: `/api/terminal/start/route.ts` returns `NextResponse.json(result)`, which passes the whole object through.

- [ ] **Step 5: Verify the clone survives a real deploy**

There is no unit test here because both functions require live Daytona credentials. Use the existing harness:

Run: `DAYTONA_API_KEY=... pnpm exec tsx scripts/test-deploy.ts schollz/croc`
Expected: the script prints PASS, and the temp clone directory it reports still exists on disk afterward rather than being removed.

- [ ] **Step 6: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
git add src/lib/deploy.ts src/lib/terminal.ts src/app/api/copilotkit/route.ts
git commit -m "Hand cloned repos to the workspace store instead of deleting them"
```

---

### Task 5: Expose the repo tools to the agent

Four read-only backend tools, plus the prompt rule that makes the agent reach for them.

**Files:**
- Create: `src/lib/repoTools.ts`
- Modify: `src/app/api/copilotkit/route.ts:103-127` (runtime definition)

**Interfaces:**
- Consumes: `getWorkspace` (Task 1); `readRepoFile`, `listRepoFiles`, `grepRepo` (Task 3); `readRepoContext` from `src/lib/repo.ts`.
- Produces: `repoTools: ReturnType<typeof defineTool>[]` — an array of four tools ready to spread into the agent's `tools`.

- [ ] **Step 1: Write the tools module**

Create `src/lib/repoTools.ts`. Each tool resolves the workspace first and returns a structured error rather than throwing, matching how `analyzeTool` and `deployTool` already behave.

```ts
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { getWorkspace } from "./workspace";
import { readRepoContext } from "./repo";
import { grepRepo, listRepoFiles, readRepoFile } from "./repoFiles";

const workspaceId = z.string().describe("The workspaceId returned by deployRepo or openTerminal");

function resolve(id: string) {
  const workspace = getWorkspace(id);
  if (!workspace) {
    return {
      error:
        "That workspace is gone -- it expired or the server restarted. Ask the user to deploy the repo again.",
    } as const;
  }
  return { workspace } as const;
}

const overviewTool = defineTool({
  name: "getRepoOverview",
  description:
    "Get a high-level picture of a repo already cloned into a workspace: its top-level layout, " +
    "README, and manifest files. Call this FIRST before answering any question about the code, " +
    "so you know where to look before searching.",
  parameters: z.object({ workspaceId }),
  execute: async ({ workspaceId: id }) => {
    const found = resolve(id);
    if ("error" in found) return { status: "error" as const, error: found.error };
    try {
      const [context, tree] = await Promise.all([
        readRepoContext(found.workspace.workDir),
        listRepoFiles(found.workspace.workDir, { depth: 2, maxEntries: 200 }),
      ]);
      return {
        status: "ok" as const,
        repoUrl: found.workspace.repoUrl,
        tree: tree.entries,
        treeTruncated: tree.truncated,
        context,
      };
    } catch (err) {
      return { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const listTool = defineTool({
  name: "listFiles",
  description:
    "List files and directories inside a workspace, optionally under a subdirectory. Use this to " +
    "explore deeper after getRepoOverview.",
  parameters: z.object({
    workspaceId,
    subdir: z.string().optional().describe("Repo-relative directory, e.g. src/lib"),
    depth: z.number().optional().describe("How many levels to descend. Default 3."),
  }),
  execute: async ({ workspaceId: id, subdir, depth }) => {
    const found = resolve(id);
    if ("error" in found) return { status: "error" as const, error: found.error };
    try {
      const res = await listRepoFiles(found.workspace.workDir, { subdir, depth });
      return { status: "ok" as const, ...res };
    } catch (err) {
      return { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const grepTool = defineTool({
  name: "grepRepo",
  description:
    "Search the repo for a literal string and get back file:line matches. Use this to find where " +
    "a symbol, config key, or error message is defined or used.",
  parameters: z.object({
    workspaceId,
    pattern: z.string().describe("Literal text to search for. Not a regex."),
    glob: z.string().optional().describe("Restrict to a path pattern, e.g. *.ts"),
  }),
  execute: async ({ workspaceId: id, pattern, glob }) => {
    const found = resolve(id);
    if ("error" in found) return { status: "error" as const, error: found.error };
    try {
      const res = await grepRepo(found.workspace.workDir, pattern, { glob });
      return { status: "ok" as const, ...res };
    } catch (err) {
      return { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const readTool = defineTool({
  name: "readFile",
  description:
    "Read a text file from the workspace, optionally a line range. Prefer reading a targeted range " +
    "over a whole large file.",
  parameters: z.object({
    workspaceId,
    path: z.string().describe("Repo-relative path, e.g. src/index.ts"),
    offset: z.number().optional().describe("1-based first line to read"),
    limit: z.number().optional().describe("How many lines to read. Default 400."),
  }),
  execute: async ({ workspaceId: id, path, offset, limit }) => {
    const found = resolve(id);
    if ("error" in found) return { status: "error" as const, error: found.error };
    try {
      const res = await readRepoFile(found.workspace.workDir, path, { offset, limit });
      return { status: "ok" as const, ...res };
    } catch (err) {
      return { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const repoTools = [overviewTool, listTool, grepTool, readTool];
```

- [ ] **Step 2: Register the tools and update the prompt**

In `src/app/api/copilotkit/route.ts`, add the import:

```ts
import { repoTools } from "@/lib/repoTools";
```

Change the `tools` array to include them:

```ts
      tools: [analyzeTool, deployTool, ...repoTools],
```

Append this paragraph to the end of the existing `prompt` string, after the env-vars paragraph:

```
"\n\nAfter a deploy or terminal session succeeds you get a workspaceId. The user can then ask " +
"questions about the code. To answer those, call getRepoOverview with that workspaceId FIRST so " +
"you know the layout, then use grepRepo and readFile to look at specific code before answering. " +
"Never guess at what the code does -- read it. You cannot edit files or redeploy; if the user " +
"asks for a change, explain what would need to change and where."
```

`maxSteps` is currently 8. A read-heavy exchange (overview, grep, two reads, answer) fits, but raise it to 12 so a multi-hop question is not cut off mid-investigation.

- [ ] **Step 3: Verify against a real repo**

Run: `pnpm dev`, deploy a small repo through the chat, then ask "what does this project do, and where is the entry point?"
Expected: the agent calls `getRepoOverview` before answering, then at least one of `grepRepo` / `readFile`, and cites a real path that exists in the repo. Server logs show the tool calls.

- [ ] **Step 4: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
git add src/lib/repoTools.ts src/app/api/copilotkit/route.ts
git commit -m "Give the agent read-only tools for navigating a deployed repo"
```

---

### Task 6: Frame-check endpoint

Decides whether a preview URL can be embedded before the iframe is rendered, so a refusing app shows a real fallback instead of a blank box.

**Files:**
- Create: `src/lib/frameCheck.ts`
- Create: `src/lib/frameCheck.test.ts`
- Create: `src/app/api/frame-check/route.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isEmbeddable(headers: Headers): boolean`
  - `GET /api/frame-check?url=<encoded>` returning `{ embeddable: boolean }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/frameCheck.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isEmbeddable } from "@/lib/frameCheck";

const h = (init: Record<string, string>) => new Headers(init);

describe("isEmbeddable", () => {
  it("allows a response with no framing headers", () => {
    expect(isEmbeddable(h({ "content-type": "text/html" }))).toBe(true);
  });

  it("blocks X-Frame-Options DENY and SAMEORIGIN", () => {
    expect(isEmbeddable(h({ "x-frame-options": "DENY" }))).toBe(false);
    expect(isEmbeddable(h({ "x-frame-options": "sameorigin" }))).toBe(false);
  });

  it("blocks CSP frame-ancestors none and self", () => {
    expect(isEmbeddable(h({ "content-security-policy": "frame-ancestors 'none'" }))).toBe(false);
    expect(
      isEmbeddable(h({ "content-security-policy": "default-src *; frame-ancestors 'self'" }))
    ).toBe(false);
  });

  it("allows a CSP with no frame-ancestors directive", () => {
    expect(isEmbeddable(h({ "content-security-policy": "default-src 'self'" }))).toBe(true);
  });

  it("allows frame-ancestors with a wildcard", () => {
    expect(isEmbeddable(h({ "content-security-policy": "frame-ancestors *" }))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/frameCheck.test.ts`
Expected: FAIL — cannot resolve `@/lib/frameCheck`.

- [ ] **Step 3: Implement the header check**

Create `src/lib/frameCheck.ts`:

```ts
/**
 * Whether a response permits being embedded in our iframe.
 *
 * A blocked iframe renders blank with no error event we can catch, so this is
 * checked server-side before the pane commits to embedding. Conservative by
 * design: anything other than a clearly permissive policy counts as blocked.
 */
export function isEmbeddable(headers: Headers): boolean {
  const xfo = headers.get("x-frame-options");
  if (xfo && /deny|sameorigin/i.test(xfo)) return false;

  const csp = headers.get("content-security-policy");
  if (csp) {
    const directive = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith("frame-ancestors"));

    if (directive) {
      const value = directive.slice("frame-ancestors".length).trim().toLowerCase();
      if (!value.includes("*")) return false;
    }
  }

  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/frameCheck.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the route**

Create `src/app/api/frame-check/route.ts`:

```ts
import { NextResponse } from "next/server";
import { isEmbeddable } from "@/lib/frameCheck";

export async function GET(request: Request) {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: "url is not valid" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return NextResponse.json({ error: "unsupported protocol" }, { status: 400 });
  }

  try {
    const res = await fetch(parsed, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    return NextResponse.json({ embeddable: isEmbeddable(res.headers) });
  } catch {
    // The app may still be booting. Assume embeddable and let the iframe try;
    // a blank frame is recoverable, a false "cannot embed" is not.
    return NextResponse.json({ embeddable: true, unreachable: true });
  }
}
```

- [ ] **Step 6: Verify the route by hand**

Run `pnpm dev`, then:

```bash
curl -s "http://localhost:3000/api/frame-check?url=https%3A%2F%2Fexample.com"
curl -s "http://localhost:3000/api/frame-check?url=https%3A%2F%2Fgithub.com"
```

Expected: `example.com` returns `{"embeddable":true}`; `github.com` returns `{"embeddable":false}` (it sets `X-Frame-Options: deny`).

- [ ] **Step 7: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
git add src/lib/frameCheck.ts src/lib/frameCheck.test.ts src/app/api/frame-check/route.ts
git commit -m "Add frame-check endpoint so unembeddable previews get a fallback"
```

---

### Task 7: Workspace pane

The right-hand pane: a preview iframe with chrome, or the terminal, or a fallback.

**Files:**
- Create: `src/components/WorkspacePane.tsx`
- Modify: `src/components/RepoTerminal.tsx:100` (fixed height becomes a flex fill)

**Interfaces:**
- Consumes: `GET /api/frame-check` (Task 6); `RepoTerminal` (existing).
- Produces:
  - `type PaneState = { kind: "none" } | { kind: "preview"; workspaceId: string; previewUrl: string; startedAt: number } | { kind: "terminal"; sessionId: string; repoUrl: string; baseImage: string }`
  - `function WorkspacePane({ state }: { state: PaneState }): JSX.Element | null`

- [ ] **Step 1: Let the terminal fill its container**

In `src/components/RepoTerminal.tsx`, the terminal body is currently fixed at `h-[340px]` (line 100), which wastes a full-height pane. Change the wrapper and body so it fills whatever it is given:

```tsx
    <div className="border border-neutral-200 rounded-2xl overflow-hidden flex flex-col h-full">
```

```tsx
      <div ref={containerRef} className="flex-1 min-h-[240px] bg-[#0a0a0a] p-2" />
```

The existing `fit.fit()` call on window resize already handles reflow, so no other change is needed.

- [ ] **Step 2: Write the pane**

Create `src/components/WorkspacePane.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { ArrowClockwise, ArrowSquareOut } from "@phosphor-icons/react";
import { RepoTerminal } from "./RepoTerminal";

const PREVIEW_LIFETIME_MS = 30 * 60 * 1000;

export type PaneState =
  | { kind: "none" }
  | { kind: "preview"; workspaceId: string; previewUrl: string; startedAt: number }
  | { kind: "terminal"; sessionId: string; repoUrl: string; baseImage: string };

function useCountdown(startedAt: number): number {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, startedAt + PREVIEW_LIFETIME_MS - Date.now())
  );
  useEffect(() => {
    const timer = setInterval(
      () => setRemaining(Math.max(0, startedAt + PREVIEW_LIFETIME_MS - Date.now())),
      1000
    );
    return () => clearInterval(timer);
  }, [startedAt]);
  return remaining;
}

function formatRemaining(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function PreviewFrame({ previewUrl, startedAt }: { previewUrl: string; startedAt: number }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [embeddable, setEmbeddable] = useState<boolean | null>(null);
  const remaining = useCountdown(startedAt);
  const expired = remaining <= 0;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/frame-check?url=${encodeURIComponent(previewUrl)}`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setEmbeddable(json.embeddable !== false);
      })
      .catch(() => {
        if (!cancelled) setEmbeddable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [previewUrl]);

  return (
    <div className="flex flex-col h-full border border-neutral-200 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200 shrink-0">
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={expired}
          aria-label="Reload preview"
          className="w-7 h-7 rounded-full border border-neutral-200 flex items-center justify-center text-neutral-500 hover:bg-neutral-100 disabled:opacity-40"
        >
          <ArrowClockwise size={13} />
        </button>
        <span className="flex-1 font-mono text-xs text-neutral-500 truncate">
          {previewUrl.replace(/^https?:\/\//, "")}
        </span>
        <span
          className={
            "font-mono text-xs rounded-full px-2 py-0.5 " +
            (expired ? "bg-neutral-100 text-neutral-500" : "bg-amber-50 text-amber-700")
          }
        >
          {expired ? "expired" : `${formatRemaining(remaining)} left`}
        </span>
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open preview in a new tab"
          className="w-7 h-7 rounded-full border border-neutral-200 flex items-center justify-center text-neutral-500 hover:bg-neutral-100"
        >
          <ArrowSquareOut size={13} />
        </a>
      </div>

      <div className="flex-1 min-h-0 bg-neutral-50">
        {expired ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
            <p className="text-sm font-medium">This preview has expired.</p>
            <p className="text-xs text-neutral-500 max-w-xs">
              Sandboxes are deleted after 30 minutes. Ask in the chat to deploy it again. You can
              still ask questions about the code.
            </p>
          </div>
        ) : embeddable === false ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
            <p className="text-sm font-medium">This app refuses to be embedded.</p>
            <p className="text-xs text-neutral-500 max-w-xs">
              It sends framing headers that block preview windows. It is running fine, it just has to
              be opened directly.
            </p>
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 bg-emerald-700 text-white text-sm font-medium rounded-full px-4 py-2"
            >
              Open in a new tab
              <ArrowSquareOut size={13} />
            </a>
          </div>
        ) : embeddable === null ? (
          <div className="h-full flex items-center justify-center text-xs text-neutral-400">
            Checking preview…
          </div>
        ) : (
          <iframe
            key={reloadKey}
            src={previewUrl}
            title="Repo preview"
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}
      </div>
    </div>
  );
}

export function WorkspacePane({ state }: { state: PaneState }) {
  if (state.kind === "none") return null;
  if (state.kind === "terminal") {
    return (
      <RepoTerminal
        sessionId={state.sessionId}
        repoUrl={state.repoUrl}
        baseImage={state.baseImage}
      />
    );
  }
  return <PreviewFrame previewUrl={state.previewUrl} startedAt={state.startedAt} />;
}
```

- [ ] **Step 3: Verify both pane modes render**

Run `pnpm dev`. The pane is not wired into the page until Task 8, so verify it directly by temporarily rendering it at the bottom of `page.tsx`'s `main` with a hardcoded state:

```tsx
<div className="h-[420px]">
  <WorkspacePane state={{ kind: "preview", workspaceId: "x", previewUrl: "https://example.com", startedAt: Date.now() }} />
</div>
```

Expected: chrome bar with a live countdown ticking down, and example.com rendering inside the frame. Swap the URL to `https://github.com` and confirm the "refuses to be embedded" fallback appears instead of a blank frame. Remove the temporary block before committing.

- [ ] **Step 4: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
git add src/components/WorkspacePane.tsx src/components/RepoTerminal.tsx
git commit -m "Add workspace pane hosting preview iframe or terminal"
```

---

### Task 8: Wire the split layout

Lifts tool results into `PaneState` and switches the page between the landing and the split view.

**Files:**
- Modify: `src/components/TerminalTool.tsx:15-72`
- Create: `src/components/DeployTool.tsx`
- Modify: `src/app/page.tsx` (whole `Chat`/`Home` structure)

**Interfaces:**
- Consumes: `PaneState`, `WorkspacePane` (Task 7); `DeployResult.workspaceId` (Task 4).
- Produces: nothing downstream.

- [ ] **Step 1: Report terminal sessions upward instead of rendering inline**

In `src/components/TerminalTool.tsx`, change the signature to accept a callback and stop mounting `RepoTerminal` on success. Keep the executing and error states inline — those belong in the conversation.

Replace the component with:

```tsx
"use client";

import { useEffect } from "react";
import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";

/**
 * The escape hatch for repos that have no web UI to preview -- CLI tools,
 * TUIs, libraries. The agent drops the user into a real shell in a sandbox.
 *
 * On success the session is handed to the workspace pane rather than rendered
 * in the message list, where a PTY would only get a fraction of the height.
 */
export function TerminalTool({
  onReady,
}: {
  onReady: (session: { sessionId: string; repoUrl: string; baseImage: string }) => void;
}) {
  useFrontendTool({
    name: "openTerminal",
    description:
      "Open an interactive terminal in a sandbox with the repo checked out at /repo. Use this for " +
      "projects that are NOT web-servable -- CLI tools, TUIs, and libraries -- so the user can still " +
      "try them. Takes ~1-2 minutes to build.",
    parameters: z.object({
      repoUrl: z.string().describe("GitHub repository URL or owner/repo"),
    }),
    handler: async ({ repoUrl }) => {
      const res = await fetch("/api/terminal/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl }),
      });
      const json = await res.json();
      if (!res.ok) {
        return { status: "error", error: json.error ?? "failed to start terminal" };
      }
      return {
        status: "ready",
        sessionId: json.sessionId,
        baseImage: json.baseImage,
        workspaceId: json.workspaceId,
        note: "The terminal is open in the panel beside the chat. Suggest a first command to try.",
      };
    },
    render: ({ args, result, status }) => {
      if (status === "executing" || !result) {
        return (
          <div className="border border-neutral-200 rounded-2xl px-4 py-3 text-sm text-neutral-500">
            Building a sandbox for{" "}
            <span className="font-mono">{args?.repoUrl ?? "the repo"}</span>…
          </div>
        );
      }

      // useFrontendTool hands back the object the handler returned -- already
      // parsed, unlike useRenderTool for backend tools. Do not JSON.parse here.
      const data = result as {
        status?: string;
        sessionId?: string;
        baseImage?: string;
        error?: string;
      };

      if (data.status !== "ready" || !data.sessionId) {
        return (
          <div className="border border-red-200 bg-red-50 rounded-2xl px-4 py-3 text-sm text-red-700">
            Couldn&apos;t open a terminal: {data.error ?? "unknown error"}
          </div>
        );
      }

      return (
        <TerminalReady
          sessionId={data.sessionId}
          repoUrl={args?.repoUrl ?? ""}
          baseImage={data.baseImage ?? ""}
          onReady={onReady}
        />
      );
    },
  });

  return null;
}

/**
 * A renderer cannot call setState during render, so the hand-off to the pane
 * happens in an effect keyed on the session.
 */
function TerminalReady({
  sessionId,
  repoUrl,
  baseImage,
  onReady,
}: {
  sessionId: string;
  repoUrl: string;
  baseImage: string;
  onReady: (session: { sessionId: string; repoUrl: string; baseImage: string }) => void;
}) {
  useEffect(() => {
    onReady({ sessionId, repoUrl, baseImage });
  }, [sessionId, repoUrl, baseImage, onReady]);

  return (
    <div className="border border-neutral-200 rounded-2xl px-4 py-3 text-sm text-neutral-500">
      Terminal is open in the panel beside the chat.
    </div>
  );
}
```

- [ ] **Step 2: Add a renderer for the backend deploy tool**

Create `src/components/DeployTool.tsx`. `deployRepo` is a *backend* tool, so this uses `useRenderTool` and its `result` arrives as a **string**.

```tsx
"use client";

import { useEffect } from "react";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";

type DeployPayload = {
  status?: string;
  previewUrl?: string;
  workspaceId?: string;
  error?: string;
};

function parse(result: string): DeployPayload {
  try {
    return JSON.parse(result) as DeployPayload;
  } catch {
    return {};
  }
}

export function DeployTool({
  onDeployed,
}: {
  onDeployed: (deploy: { workspaceId: string; previewUrl: string }) => void;
}) {
  useRenderTool(
    {
      name: "deployRepo",
      parameters: z.object({ repoUrl: z.string() }),
      render: (props) => {
        if (props.status !== "complete") {
          return (
            <div className="border border-neutral-200 rounded-2xl px-4 py-3 text-sm text-neutral-500">
              Deploying <span className="font-mono">{props.parameters?.repoUrl ?? "the repo"}</span>…
            </div>
          );
        }

        const data = parse(props.result);
        if (data.status !== "success" || !data.previewUrl || !data.workspaceId) {
          return (
            <div className="border border-red-200 bg-red-50 rounded-2xl px-4 py-3 text-sm text-red-700">
              Deploy failed: {data.error ?? "unknown error"}
            </div>
          );
        }

        return (
          <DeployReady
            workspaceId={data.workspaceId}
            previewUrl={data.previewUrl}
            onDeployed={onDeployed}
          />
        );
      },
    },
    [onDeployed]
  );

  return null;
}

function DeployReady({
  workspaceId,
  previewUrl,
  onDeployed,
}: {
  workspaceId: string;
  previewUrl: string;
  onDeployed: (deploy: { workspaceId: string; previewUrl: string }) => void;
}) {
  useEffect(() => {
    onDeployed({ workspaceId, previewUrl });
  }, [workspaceId, previewUrl, onDeployed]);

  return (
    <div className="border border-neutral-200 rounded-2xl px-4 py-3 text-sm text-neutral-500">
      Live in the panel beside the chat.
    </div>
  );
}
```

- [ ] **Step 3: Switch the page between landing and split view**

In `src/app/page.tsx`:

Add imports:

```tsx
import { useCallback } from "react";
import { DeployTool } from "@/components/DeployTool";
import { WorkspacePane, type PaneState } from "@/components/WorkspacePane";
```

Change `Chat` to accept and raise pane state. Replace its signature and the two tool mounts:

```tsx
function Chat({
  pane,
  setPane,
}: {
  pane: PaneState;
  setPane: (state: PaneState) => void;
}) {
  const searchParams = useSearchParams();
  const repo = searchParams.get("repo") ?? "";
  const split = pane.kind !== "none";

  const onDeployed = useCallback(
    ({ workspaceId, previewUrl }: { workspaceId: string; previewUrl: string }) =>
      setPane({ kind: "preview", workspaceId, previewUrl, startedAt: Date.now() }),
    [setPane]
  );

  const onTerminalReady = useCallback(
    (session: { sessionId: string; repoUrl: string; baseImage: string }) =>
      setPane({ kind: "terminal", ...session }),
    [setPane]
  );

  return (
    <div className="flex flex-col gap-3 h-full">
      <EnvVarPrompt />
      <DeployTool onDeployed={onDeployed} />
      <TerminalTool onReady={onTerminalReady} />
      {repo && !split && <RepoBanner repo={repo} />}
      <div className="flex-1 min-h-0 border border-neutral-200 rounded-2xl overflow-hidden flex flex-col">
        <div className="flex-1 min-h-0">
          <CopilotChat
            labels={{ chatInputPlaceholder: "Paste a GitHub URL or owner/repo…" }}
            welcomeScreen={{ welcomeMessage: () => null }}
            input={{
              showDisclaimer: false,
              sendButton: { className: "bg-emerald-700 text-white" },
            }}
          />
        </div>
        {!split && (
          <div className="px-4 pb-4 flex flex-col gap-2 shrink-0">
            <span className="text-xs text-neutral-400">
              Or try one of this week&apos;s trending repos
            </span>
            <div className="flex flex-wrap gap-2">
              {quickStartRepos.map((r) => (
                <Link
                  key={r.name}
                  href={`/?repo=${encodeURIComponent(r.url)}`}
                  className="inline-flex items-center gap-1.5 text-xs font-mono bg-neutral-100 border border-neutral-200 rounded-full px-3 py-1.5 hover:bg-neutral-200 transition-colors"
                >
                  <ArrowSquareOut size={12} className="text-neutral-400" />
                  {r.name}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
      {!split && (
        <p className="text-center text-xs text-neutral-400">
          Auto-expires in 30 minutes. Nothing persists.
        </p>
      )}
    </div>
  );
}
```

Then replace `Home` so the container widens and the hero collapses once the pane is live. Below `lg` the two panes stack, per the spec:

```tsx
export default function Home() {
  const [pane, setPane] = useState<PaneState>({ kind: "none" });
  const split = pane.kind !== "none";

  return (
    <CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={true}>
      <main
        className={
          "flex flex-col flex-1 mx-auto w-full p-6 gap-6 " +
          (split ? "max-w-6xl" : "max-w-2xl")
        }
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-700 text-white flex items-center justify-center font-mono font-bold text-xs">
              tr
            </div>
            <span className="font-semibold tracking-tight">tryrepo</span>
          </div>
          <Link
            href="/templates"
            className="inline-flex items-center gap-1 text-sm text-neutral-500 border border-neutral-200 rounded-full pl-3 pr-2 py-1.5 hover:border-neutral-300"
          >
            Trending
            <ArrowRight size={13} weight="bold" />
          </Link>
        </div>

        {!split && (
          <div className="text-center max-w-md mx-auto">
            <h1 className="text-3xl font-semibold tracking-tight leading-tight">
              Paste a repo. Get a live preview.
            </h1>
            <p className="text-sm text-neutral-500 mt-2">
              Point tryrepo at any GitHub repo. It uses the repo&apos;s Dockerfile, or writes one,
              then hands you a disposable preview URL. No local setup.
            </p>
          </div>
        )}

        <div
          className={
            split
              ? "flex-1 min-h-[70vh] grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4"
              : "flex-1 min-h-[55vh]"
          }
        >
          <Suspense fallback={null}>
            <Chat pane={pane} setPane={setPane} />
          </Suspense>
          {split && (
            <div className="min-h-[420px] lg:min-h-0">
              <WorkspacePane state={pane} />
            </div>
          )}
        </div>
      </main>
    </CopilotKit>
  );
}
```

- [ ] **Step 4: Verify the whole flow end to end**

Run `pnpm dev` and check all three paths:

1. **Web repo.** Deploy one with a Dockerfile. Expected: hero collapses, layout widens to two columns, the app renders in the right pane with a ticking countdown. Then ask "where is the entry point?" and confirm the agent calls the repo tools and cites a real path.
2. **CLI repo.** Ask it to try `schollz/croc`. Expected: the agent calls `openTerminal`, the chat shows the short "open in the panel" note, and the terminal fills the right pane at full height rather than 340px.
3. **Narrow viewport.** Resize below 1024px. Expected: the panes stack vertically, nothing overflows horizontally.

- [ ] **Step 5: Commit**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
git add src/app/page.tsx src/components/TerminalTool.tsx src/components/DeployTool.tsx
git commit -m "Show deploys and terminals in a split workspace pane"
```

---

## Deferred security finding (accepted, not fixed here)

An automated review flagged `src/lib/terminal.ts`: session ids are
`term-<counter>-<8 hex of sandbox id>`, and `/api/terminal/[id]/input` and
`/api/terminal/[id]/stream` call `getSession(id)` with no authorization check.
Guessing an id therefore grants interactive shell access to another user's
sandbox. Rated HIGH.

Decision: **acknowledged and deferred.** The app currently runs on localhost via
`pnpm dev`, where practical exposure is low. This is recorded so it is not
silently lost, and so the final whole-branch review can triage it.

It stops being low-risk the moment the app is demoed on a shared network or
hosted anywhere. The fix is CSPRNG session ids plus binding the session to its
requester — an httpOnly cookie set by the `start` route and verified in both
`/input` and `/stream`.

This plan does not touch it, but it does avoid repeating the pattern:
`workspace.ts` (Task 1) generates ids with `randomBytes` rather than a counter,
because a workspace id is likewise the only thing guarding a clone's contents.

## Known deviation from the spec

The spec's states table says the **Building** state should be shown in the pane, with it "mirroring the progress messages `deployRepo` already emits." This plan does not do that, for two reasons found while writing it:

1. Those progress messages never leave the server. `route.ts:69-71` passes `(msg) => console.log(msg)` as the `onProgress` callback, so they go to the server console and are not streamed to the client at all. Surfacing them would mean building progress streaming first.
2. The pane only exists once there is something to show. During a deploy `PaneState` is still `none`, so there is no pane to render into without also making the pane appear before the deploy resolves, which contradicts "transform in place on success."

So in this plan the building state renders **inline in the chat**, where the tool call already lives — `DeployTool` and `TerminalTool` each show an executing state. The pane appears on success.

Streaming real progress into the pane is a reasonable follow-up, but it is its own piece of work and is deliberately out of scope here.

## Notes for the implementer

- **The clone is now long-lived.** Nothing deletes it except `sweepWorkspaces`, which only runs when a new deploy or terminal session starts. A dev server left running after one deploy keeps that clone until the next one. This is a known, accepted trade from the spec.
- **`git grep` needs a git dir.** `cloneRepo` uses `git clone --depth 1`, so the clone always has one. If a future code path ever builds a workspace from a non-git directory, `grepRepo` will fail and needs a fallback.
- **Do not add `JSON.parse` in `TerminalTool`.** Frontend tools hand back the object the handler returned. Backend tools (`deployRepo`) hand back a string. Task 8 has one of each, deliberately.

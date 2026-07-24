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

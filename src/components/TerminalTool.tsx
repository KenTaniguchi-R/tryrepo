"use client";

import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { RepoTerminal } from "./RepoTerminal";

/**
 * The escape hatch for repos that have no web UI to preview -- CLI tools,
 * TUIs, libraries. Instead of telling the user "not supported", the agent can
 * drop them into a real shell inside a sandbox with the repo already there.
 *
 * Runs as a frontend tool so the handler can start the session and the render
 * can mount the terminal in the same place.
 */
export function TerminalTool() {
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
        note: "Terminal is rendered in the chat. Tell the user it's ready and suggest a first command.",
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

      // CopilotKit may hand the tool result back as a JSON string rather than
      // the object the handler returned, so accept either shape.
      let data: { status?: string; sessionId?: string; baseImage?: string; error?: string } = {};
      if (typeof result === "string") {
        try {
          data = JSON.parse(result);
        } catch {
          data = { error: result };
        }
      } else if (result && typeof result === "object") {
        data = result as typeof data;
      }

      if (data.status !== "ready" || !data.sessionId) {
        return (
          <div className="border border-red-200 bg-red-50 rounded-2xl px-4 py-3 text-sm text-red-700">
            Couldn&apos;t open a terminal: {data.error ?? "unknown error"}
          </div>
        );
      }

      return (
        <RepoTerminal
          sessionId={data.sessionId}
          repoUrl={args?.repoUrl ?? ""}
          baseImage={data.baseImage ?? ""}
        />
      );
    },
  });

  return null;
}

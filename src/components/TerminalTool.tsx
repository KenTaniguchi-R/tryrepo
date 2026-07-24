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

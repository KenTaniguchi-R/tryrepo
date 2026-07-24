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

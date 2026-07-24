"use client";

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

export function RepoTerminal({
  sessionId,
  repoUrl,
  baseImage,
}: {
  sessionId: string;
  repoUrl: string;
  baseImage: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "closed">("connecting");

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let cleanup = () => {};

    // xterm touches `window` at import time, so load it client-side only.
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        theme: { background: "#0a0a0a", foreground: "#e5e5e5" },
        cursorBlink: true,
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();

      const post = (body: Record<string, unknown>) =>
        fetch(`/api/terminal/${sessionId}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).catch(() => {});

      term.onData((data) => void post({ data }));

      const source = new EventSource(`/api/terminal/${sessionId}/stream`);
      source.onopen = () => setStatus("live");
      source.onmessage = (event) => {
        const bytes = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0));
        term.write(bytes);
      };
      source.onerror = () => setStatus("closed");

      const onResize = () => {
        fit.fit();
        void post({ cols: term.cols, rows: term.rows });
      };
      window.addEventListener("resize", onResize);
      onResize();

      cleanup = () => {
        window.removeEventListener("resize", onResize);
        source.close();
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [sessionId]);

  return (
    <div className="border border-neutral-200 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-neutral-200 text-xs">
        <span className="font-mono truncate">{repoUrl.replace("https://github.com/", "")}</span>
        <span className="flex items-center gap-2 shrink-0 text-neutral-500">
          <span className="font-mono">{baseImage}</span>
          <span
            className={
              status === "live"
                ? "text-emerald-600"
                : status === "closed"
                  ? "text-red-600"
                  : "text-neutral-400"
            }
          >
            ●
          </span>
        </span>
      </div>
      <div ref={containerRef} className="h-[340px] bg-[#0a0a0a] p-2" />
      <div className="px-3 py-2 border-t border-neutral-200 text-xs text-neutral-500">
        Live shell in the repo at <span className="font-mono">/repo</span>. Sandbox auto-deletes in
        30 minutes.
      </div>
    </div>
  );
}

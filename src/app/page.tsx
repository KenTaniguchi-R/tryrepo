"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2";

// CopilotChat's inputValue/onInputChange props are dead — it always uses its
// own internal input state, so a query-param prefill can't reach the textarea.
// Show a copyable banner instead of fighting that.
function RepoBanner({ repo }: { repo: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 border rounded-lg px-3 py-2 text-sm">
      <span className="truncate">
        Paste into chat: <span className="font-mono">{repo}</span>
      </span>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(repo);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 border rounded px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Chat() {
  const searchParams = useSearchParams();
  const repo = searchParams.get("repo") ?? "";

  return (
    <div className="flex flex-col gap-2 h-full">
      {repo && <RepoBanner repo={repo} />}
      <div className="flex-1 min-h-0 border rounded-lg overflow-hidden">
        <CopilotChat />
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={true}>
      <main className="flex flex-col flex-1 max-w-2xl mx-auto w-full p-6 gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">tryrepo</h1>
            <p className="text-sm text-neutral-500">
              Paste a GitHub repo URL with a root Dockerfile. Get a live, disposable
              preview URL — no local setup, auto-expires in 30 minutes.
            </p>
          </div>
          <Link href="/templates" className="text-sm underline shrink-0 mt-1">
            Trending templates →
          </Link>
        </div>
        <div className="flex-1 min-h-[60vh]">
          <Suspense fallback={null}>
            <Chat />
          </Suspense>
        </div>
      </main>
    </CopilotKit>
  );
}

"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2";
import { ArrowRight, ArrowSquareOut } from "@phosphor-icons/react/dist/ssr";
import { EnvVarPrompt } from "@/components/EnvVarPrompt";
import { TerminalTool } from "@/components/TerminalTool";
import trending from "@/data/trending-repos.json";

// Each of these is verified end-to-end and covers a different path:
//   hallmark          -> no Dockerfile, one gets written for it (~60s)
//   code-review-graph -> not a web app, opens an interactive terminal (~35s)
//   worldmonitor      -> ships its own Dockerfile, real multi-stage build (~3min)
// Deliberately NOT croc (builds fine but speaks raw TCP, so no HTTP preview)
// or OmniRoute (heavy npm-workspace build, too slow and unverified).
const QUICK_START_REPOS = [
  "Nutlope/hallmark",
  "tirth8205/code-review-graph",
  "koala73/worldmonitor",
];
const quickStartRepos = QUICK_START_REPOS.map(
  (name) => trending.repos.find((r) => r.name === name)!
);

// CopilotChat's inputValue/onInputChange props are dead — it always uses its
// own internal input state, so a query-param prefill can't reach the textarea.
// Show a copyable banner instead of fighting that.
function RepoBanner({ repo }: { repo: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 border border-neutral-200 rounded-2xl px-4 py-2.5 text-sm">
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
        className="shrink-0 border border-neutral-200 rounded-full px-3 py-1 text-xs hover:bg-neutral-100"
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
    <div className="flex flex-col gap-3 h-full">
      <EnvVarPrompt />
      <TerminalTool />
      {repo && <RepoBanner repo={repo} />}
      <div className="flex-1 min-h-0 border border-neutral-200 rounded-2xl overflow-hidden flex flex-col">
        <div className="flex-1 min-h-0">
          {/* CopilotChat renders its own welcome heading + disclaimer by
              default. Both are slot-overridable; the mockup has neither. */}
          <CopilotChat
            labels={{ chatInputPlaceholder: "Paste a GitHub URL or owner/repo…" }}
            welcomeScreen={{ welcomeMessage: () => null }}
            input={{
              showDisclaimer: false,
              // Enabled send button takes the page accent. CopilotKit's
              // `disabled:` rule outranks this, so the empty state stays grey.
              sendButton: { className: "bg-emerald-700 text-white" },
            }}
          />
        </div>
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
      </div>
      <p className="text-center text-xs text-neutral-400">
        Auto-expires in 30 minutes. Nothing persists.
      </p>
    </div>
  );
}

export default function Home() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={true}>
      <main className="flex flex-col flex-1 max-w-2xl mx-auto w-full p-6 gap-6">
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

        <div className="text-center max-w-md mx-auto">
          <h1 className="text-3xl font-semibold tracking-tight leading-tight">
            Paste a repo. Try it in seconds.
          </h1>
          <p className="text-sm text-neutral-500 mt-2">
            Point tryrepo at any GitHub repo. Web apps get a disposable preview URL —
            it uses the repo&apos;s Dockerfile or writes one. CLI tools get a live
            terminal instead. Nothing runs on your machine.
          </p>
        </div>

        <div className="flex-1 min-h-[55vh]">
          <Suspense fallback={null}>
            <Chat />
          </Suspense>
        </div>
      </main>
    </CopilotKit>
  );
}

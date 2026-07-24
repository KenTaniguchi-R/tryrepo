import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import trending from "@/data/trending-repos.json";
import TemplatesGrid from "@/components/TemplatesGrid";

export const metadata: Metadata = {
  title: "Trending templates · tryrepo",
  description: "This week's trending GitHub repos — deploy one as a live preview.",
};

export default function TemplatesPage() {
  return (
    <main className="flex flex-col flex-1 max-w-5xl mx-auto w-full p-6 gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trending templates</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Repos trending on GitHub this week. Pick one to try — tryrepo needs
            a Dockerfile at the repo root to build a live preview.
          </p>
        </div>
        <Link
          href="/"
          className="text-sm text-neutral-500 hover:text-neutral-900 shrink-0 mt-1 inline-flex items-center gap-1"
        >
          <ArrowRight size={14} weight="bold" className="rotate-180" />
          Back to chat
        </Link>
      </div>

      <TemplatesGrid repos={trending.repos} />

      <p className="text-xs text-neutral-400">
        Source: <a href={trending.source} target="_blank" rel="noopener noreferrer" className="underline">GitHub Trending (weekly)</a>, fetched {trending.fetchedAt}.
      </p>
    </main>
  );
}

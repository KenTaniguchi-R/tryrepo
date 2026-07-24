import Link from "next/link";
import type { Metadata } from "next";
import trending from "@/data/trending-repos.json";

export const metadata: Metadata = {
  title: "Trending templates · tryrepo",
  description: "This week's trending GitHub repos — deploy one as a live preview.",
};

export default function TemplatesPage() {
  return (
    <main className="flex flex-col flex-1 max-w-5xl mx-auto w-full p-6 gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Trending templates</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Repos trending on GitHub this week. Pick one to try — tryrepo needs
            a Dockerfile at the repo root to build a live preview.
          </p>
        </div>
        <Link href="/" className="text-sm underline shrink-0 mt-1">
          ← Back to chat
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {trending.repos.map((repo) => (
          <div
            key={repo.name}
            className="flex flex-col justify-between gap-3 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4"
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-neutral-400">#{repo.rank}</span>
                {repo.language && (
                  <span className="text-xs text-neutral-500">{repo.language}</span>
                )}
              </div>
              <a
                href={repo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline break-all"
              >
                {repo.name}
              </a>
              <p className="text-sm text-neutral-500 line-clamp-3">
                {repo.description}
              </p>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-neutral-400">
                ★ {repo.stars.toLocaleString()}{" "}
                <span className="text-green-600 dark:text-green-500">
                  +{repo.starsThisWeek.toLocaleString()} this week
                </span>
              </span>
              <Link
                href={`/?repo=${encodeURIComponent(repo.url)}`}
                className="text-xs font-medium border border-neutral-300 dark:border-neutral-700 rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-900 shrink-0"
              >
                Deploy →
              </Link>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-neutral-400">
        Source: <a href={trending.source} target="_blank" rel="noopener noreferrer" className="underline">GitHub Trending (weekly)</a>, fetched {trending.fetchedAt}.
      </p>
    </main>
  );
}

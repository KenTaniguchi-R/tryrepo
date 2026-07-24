"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "@phosphor-icons/react";
import { languageColor } from "@/lib/language-colors";

type TrendingRepo = {
  rank: number;
  name: string;
  url: string;
  description: string;
  language: string;
  stars: number;
  starsThisWeek: number;
  forks: number;
};

function LanguageDot({ language }: { language: string }) {
  return (
    <span
      className="w-2 h-2 rounded-full shrink-0"
      style={{ backgroundColor: languageColor(language) }}
    />
  );
}

function DeployLink({ url, className }: { url: string; className?: string }) {
  return (
    <Link
      href={`/?repo=${encodeURIComponent(url)}`}
      className={className}
      aria-label="Deploy this repo"
    >
      <ArrowRight size={14} weight="bold" />
    </Link>
  );
}

export default function TemplatesGrid({ repos }: { repos: TrendingRepo[] }) {
  const languages = useMemo(
    () => Array.from(new Set(repos.map((r) => r.language))).sort(),
    [repos]
  );
  const [activeLanguage, setActiveLanguage] = useState<string>("All");

  const spotlight = repos[0];
  const showSpotlight = activeLanguage === "All";
  const rest = repos.filter((r) => {
    if (showSpotlight && r.rank === spotlight.rank) return false;
    return activeLanguage === "All" || r.language === activeLanguage;
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        {["All", ...languages].map((lang) => (
          <button
            key={lang}
            type="button"
            onClick={() => setActiveLanguage(lang)}
            className={
              "text-xs rounded-full px-3 py-1.5 border transition-colors " +
              (activeLanguage === lang
                ? "bg-emerald-50 text-emerald-700 border-transparent font-medium"
                : "text-neutral-500 border-neutral-200 hover:border-neutral-300")
            }
          >
            {lang}
          </button>
        ))}
      </div>

      {showSpotlight && (
        <div className="grid grid-cols-1 md:grid-cols-[1.3fr_1fr] border border-neutral-200 rounded-2xl overflow-hidden">
          <div className="p-6 flex flex-col gap-3 justify-center">
            <span className="text-xs font-mono text-neutral-400">
              #{spotlight.rank} this week
            </span>
            <a
              href={spotlight.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-lg font-semibold tracking-tight hover:underline break-all"
            >
              {spotlight.name}
            </a>
            <p className="text-sm text-neutral-500 max-w-[46ch] line-clamp-2">
              {spotlight.description}
            </p>
            <div className="flex items-center gap-3 text-xs text-neutral-500">
              <span className="flex items-center gap-1.5">
                <LanguageDot language={spotlight.language} />
                {spotlight.language}
              </span>
              <span>{spotlight.stars.toLocaleString()} stars</span>
            </div>
          </div>
          <div className="bg-neutral-50 border-t md:border-t-0 md:border-l border-neutral-200 p-6 flex flex-col justify-center gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-2xl font-semibold text-emerald-700">
                +{spotlight.starsThisWeek.toLocaleString()}
              </span>
              <span className="text-[11px] uppercase tracking-wide text-neutral-400">
                Stars this week
              </span>
            </div>
            <Link
              href={`/?repo=${encodeURIComponent(spotlight.url)}`}
              className="self-start inline-flex items-center gap-1.5 bg-emerald-700 text-white text-sm font-medium rounded-full px-4 py-2"
            >
              Deploy
              <ArrowRight size={14} weight="bold" />
            </Link>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {rest.map((repo) => (
          <div
            key={repo.name}
            className="group flex flex-col justify-between gap-3 border border-neutral-200 rounded-2xl p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-neutral-200/50"
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] font-mono text-neutral-400 bg-neutral-100 rounded-full px-2 py-0.5">
                  #{repo.rank}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-neutral-500">
                  <LanguageDot language={repo.language} />
                  {repo.language}
                </span>
              </div>
              <a
                href={repo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-sm hover:underline break-all"
              >
                {repo.name}
              </a>
              <p className="text-xs text-neutral-500 line-clamp-2">
                {repo.description}
              </p>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-neutral-500 flex items-center gap-1">
                {repo.stars.toLocaleString()}
                <span className="text-emerald-700 font-medium flex items-center gap-0.5">
                  <ArrowUpRight size={11} weight="bold" />
                  {repo.starsThisWeek.toLocaleString()}
                </span>
              </span>
              <DeployLink
                url={repo.url}
                className="w-7 h-7 rounded-full border border-neutral-200 flex items-center justify-center text-neutral-500 transition-colors group-hover:bg-emerald-700 group-hover:text-white group-hover:border-transparent"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

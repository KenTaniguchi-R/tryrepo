/**
 * Hand-labelled ground truth for the 20 trending repos.
 *
 * `webServable` answers "is the PRIMARY purpose of this repo something a
 * browser can open?" -- not "could any part of it be served". A docs folder or
 * an incidental local web UI does not make a CLI tool a web app, because the
 * user asked to *try the project*, not to read its documentation.
 *
 * Repos where that judgement is genuinely contestable are marked `ambiguous`
 * and excluded from the accuracy score rather than quietly counted as wins.
 * Reporting 3 honest abstentions beats a suspiciously perfect number.
 */
export interface Label {
  name: string;
  webServable: boolean;
  ambiguous?: boolean;
  why: string;
}

export const LABELS: Label[] = [
  { name: "bojieli/ai-agent-book", webServable: false, why: "A book: chapters, translations, PDF/EPUB, mkdocs config." },
  { name: "koala73/worldmonitor", webServable: true, why: "Vite frontend + Node API served behind nginx; ships its own Dockerfile." },
  { name: "tirth8205/code-review-graph", webServable: false, why: "Python CLI plus an MCP daemon; entry points are console scripts." },
  { name: "MoonshotAI/kimi-code", webServable: false, why: "Terminal coding agent (TUI). No server is the point of the tool." },
  { name: "1jehuang/jcode", webServable: false, why: "TUI coding agent harness." },
  { name: "diegosouzapw/OmniRoute", webServable: true, why: "An HTTP API gateway -- serving requests is its entire function." },
  { name: "agegr/pi-web", webServable: true, why: "Next.js web UI for the pi agent." },
  { name: "HKUDS/DeepTutor", webServable: true, why: "FastAPI backend + Next.js frontend, ships a Dockerfile exposing both." },
  {
    name: "MoonshotAI/kimi-cli",
    webServable: false,
    ambiguous: true,
    why: "Primarily a CLI, but genuinely ships FastAPI + uvicorn and a web UI under src/kimi_cli/web/api/. Defensible either way.",
  },
  { name: "earendil-works/pi", webServable: false, why: "Monorepo of CLI agent packages and a TUI." },
  {
    name: "rohitg00/ai-engineering-from-scratch",
    webServable: false,
    ambiguous: true,
    why: "A curriculum, but it has a web/ directory and vercel.json, so the docs site is arguably servable.",
  },
  { name: "ibelick/ui-skills", webServable: false, why: "Markdown skill definitions for design engineers." },
  {
    name: "PrismML-Eng/Bonsai-demo",
    webServable: false,
    ambiguous: true,
    why: "Shell-based demo repo; too little signal to call confidently either way.",
  },
  { name: "Robbyant/lingbot-map", webServable: false, why: "A 3D reconstruction research model -- library/checkpoints, not a service." },
  { name: "apache/ossie", webServable: false, why: "A specification: spec.md, spec.yaml, JSON schemas." },
  {
    name: "Nutlope/hallmark",
    webServable: true,
    why: "Ships a site/ directory and an explicit `serve` script (python3 -m http.server --directory site 4173).",
  },
  { name: "mattpocock/skills", webServable: false, why: "Markdown agent skills." },
  { name: "kvcache-ai/ktransformers", webServable: false, why: "An LLM inference framework you import, not a service." },
  { name: "ruvnet/RuView", webServable: false, why: "WiFi-sensing research toolkit; signal processing, not a web app." },
  { name: "schollz/croc", webServable: false, why: "File-transfer CLI. Its relay speaks raw TCP, so there is no page to open." },
];

export const LABELS_BY_NAME = new Map(LABELS.map((l) => [l.name, l]));

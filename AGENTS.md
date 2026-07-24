# AGENTS.md

Context for AI coding agents working in this repo. See `README.md` for the
user-facing project description.

## What this is

Next.js (TypeScript, App Router) app: paste a GitHub repo URL into a
CopilotKit chat, it clones the repo, builds a Daytona sandbox from its root
Dockerfile, starts the app, and returns a public auto-expiring preview URL.
Built for a one-day hackathon (Daytona HackSprint w/ Braintrust) — code
favors working-and-honest over complete-and-polished.

## Critical gotchas (don't rediscover these)

1. **Daytona does not auto-run a Dockerfile's `CMD`/`ENTRYPOINT`.** A sandbox
   built from an `Image` only gets the filesystem; Daytona's own entrypoint
   session runs `sleep infinity` to keep the sandbox alive for exec access.
   The app must always be started explicitly via
   `sandbox.process.createSession()` + `executeSessionCommand(id, { command,
   runAsync: true })` after sandbox creation. This was confirmed with a live
   Daytona API call, not assumed from docs.

2. **Pin `ai` and `@ai-sdk/openai` to match `@copilotkit/runtime`'s bundled
   versions — do not `pnpm add ai@latest`.** `@copilotkit/runtime` (currently
   `1.63.2`) depends on `ai@^6` / `@ai-sdk/openai@^3`. Installing the latest
   major (`ai@7` / `@ai-sdk/openai@4`) produces a `LanguageModel` type
   (`LanguageModelV4`) that `BuiltInAgent`'s `model` field rejects
   (`LanguageModelV2` expected) — a real type error, not a lint nitpick.
   Before bumping either package, check
   `node_modules/@copilotkit/runtime/package.json`'s `dependencies` for the
   version it actually bundles.

3. **`@daytonaio/sdk` is deprecated** — use `@daytona/sdk` (same API, renamed
   package). If you see `@daytonaio/sdk` referenced anywhere, that's stale.

4. **CopilotKit v2, not v1.** Import from `@copilotkit/runtime/v2` and
   `@copilotkit/react-core/v2` (not the package roots, which are the older
   v1 API with different shapes — `CopilotRuntime`/`copilotRuntimeNextJSAppRouterEndpoint`
   there is a different, incompatible pattern). `@copilotkit/react-ui` is not
   installed — v2's UI components (`CopilotChat`, `CopilotSidebar`, etc.)
   live in `@copilotkit/react-core/v2`.

5. **pnpm build-script approval**: this repo's `pnpm-workspace.yaml` lists
   `onlyBuiltDependencies` (currently `sharp`, `unrs-resolver`). If `pnpm
   install` errors with `ERR_PNPM_IGNORED_BUILDS`, either add the new package
   to that list or run `pnpm approve-builds --all`. The `pnpm.*` key in
   `package.json` is a dead end — pnpm 11 moved this to
   `pnpm-workspace.yaml` and silently ignores the `package.json` field.

## Verifying changes to the deploy pipeline

`src/lib/deploy.ts` is the core logic (clone -> detect Dockerfile -> parse
port/run-command -> build image -> create sandbox -> start session -> get
preview link). It's plain Node/TS with no Next.js dependency, so test it
directly without going through the chat UI:

```bash
DAYTONA_API_KEY=... pnpm exec tsx scripts/test-deploy.ts <repo-url-or-local-path>
```

Accepts a real GitHub URL, `owner/repo` shorthand, or a local path/`file://`
URL to a git repo (useful for fixture-based testing without hitting a real
external repo). It clones, deploys, then polls the preview URL and prints
PASS/FAIL. A local test fixture (Python http.server + minimal Dockerfile) was
used during development at `../tryrepo-fixture` (sibling directory, not
inside this repo).

## Current scope — don't silently expand without flagging it

- **Dockerfile-at-repo-root only.** No LLM-based run-command inference for
  repos without one yet (that was cut for time; Fireworks is only used for
  the chat model right now, not for a detection fallback).
- **No secret/env-var handling.** Repos needing API keys etc. will build and
  start but likely fail at runtime. No human-in-the-loop prompting for
  missing secrets yet.
- **Regex-based Dockerfile parsing** (`detectExposedPort`/`detectRunCommand`
  in `deploy.ts`) — last `EXPOSE`/`CMD`/`ENTRYPOINT` line wins. Works for
  typical single- and multi-stage builds with a shell in the final image;
  known to break on `FROM scratch`/distroless final stages (no shell to run
  the session command in).
- **`autoDeleteInterval: 30`** (minutes) is hardcoded in `deployRepo` — sandboxes
  are meant to be ephemeral trials, not persistent hosting. Don't change this
  to persistent without discussing it — that was an explicit, deliberate
  scope decision (see README), not an oversight.

If you're extending this (non-Dockerfile fallback, secret prompting, WorkOS
auth, CodeRabbit pre-deploy scanning), check the README's "Sponsor tools
used" and "Known limitations" sections first — some of these were evaluated
and deliberately cut, not missed.

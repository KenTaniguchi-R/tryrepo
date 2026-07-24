# AGENTS.md

Context for AI coding agents working in this repo. See `README.md` for the
user-facing project description.

## What this is

Next.js (TypeScript, App Router) app: paste a GitHub repo URL into a
CopilotKit chat, it clones the repo, builds a Daytona sandbox from its root
Dockerfile (or a Fireworks-synthesized one if there isn't one), starts the
app, and returns a public auto-expiring preview URL. Built for a one-day
hackathon (Daytona HackSprint w/ Braintrust) — code favors working-and-honest
over complete-and-polished.

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

3a. **A non-root Dockerfile `USER` directive reproducibly breaks Daytona
   sandbox startup.** Daytona's own in-sandbox agent needs root to handle
   exec/session requests. `USER nobody` (or any non-root user) fails sandbox
   startup on every attempt with a misleading "failed to resolve container
   IP" error — confirmed with a controlled A/B test (identical fixture,
   USER line the only diff, 2/2 fresh sandboxes failed with it vs. clean pass
   without). `deploy.ts`'s `stripUserDirective()` comments out any `USER` line
   before building. Don't remove this thinking it's dead code — it fixes a
   real, common pattern (production Dockerfiles routinely drop to a non-root
   user as a security best practice).

3b. **The identical "failed to resolve container IP" error can ALSO mean
   generic platform flakiness**, unrelated to (3a) — see
   [daytonaio/daytona#4142](https://github.com/daytonaio/daytona/issues/4142)
   and [#5137](https://github.com/daytonaio/daytona/issues/5137) (both open
   as of 2026-07-24): a sandbox can report started before it's network-
   reachable, or get starved on a shared runner under concurrent load (#5137
   was filed the same week as this build, describing exactly this). Don't
   assume every occurrence is (3a) — `createSandboxAndStartSession()` in
   `deploy.ts` retries session startup and, on persistent failure, deletes
   the sandbox and creates a fresh one (`MAX_SANDBOX_ATTEMPTS`) rather than
   retrying the same one forever.

3c. **`daytona.create()`'s default 60s timeout is too short for anything that
   compiles from source** (Go, Rust, etc.) — bumped to 240s in `deploy.ts`.
   If you see `DaytonaTimeoutError` on a real repo, check whether it's a
   from-source build before assuming something else is wrong.

3e. **`Image.addLocalDir()` appends its COPY instruction WITHOUT inserting a
   newline first.** A Dockerfile whose content doesn't end in `\n` gets its
   last line silently fused with the COPY — `WORKDIR /repo` became
   `WORKDIR /repoCOPY ...`, which created a directory literally named
   `repoCOPY ` and left `/repo` nonexistent. Always end generated Dockerfile
   content with a newline (`deploy.ts` normalizes with
   `.replace(/\n*$/, "\n")`; `terminal.ts` ends its array with `""`). This
   stayed hidden for a while because most real repos' Dockerfiles already end
   with a newline.

3f. **A PTY that fails with `fork/exec /usr/bin/bash: no such file or
   directory` usually means the *cwd* doesn't exist, not the shell.** Go
   reports the binary path in the error even when it's the working directory
   that's missing. Confirmed by A/B: `createPty({cwd: "/repo"})` failed while
   `createPty({cwd: undefined})` succeeded on the same sandbox. Check the
   directory exists before blaming the shell (see 3e — that's what broke it).
   Note also that Daytona's PTY always execs `/usr/bin/bash` and the SDK
   offers no way to choose a different shell, so images must have bash at
   exactly that path.

3d. **Daytona enforces a 30GiB total disk quota, and dead sandboxes still
   count against it.** Once exhausted, EVERY subsequent create fails with
   "Total disk limit exceeded" — which looks exactly like a per-repo build
   failure and will silently poison any batch measurement (this happened: a
   full 20-repo run reported 7 "build failures" that were all really quota).
   Run `pnpm exec tsx scripts/cleanup-sandboxes.ts` before any batch run or
   live demo. `scripts/batch-test.ts` now classifies this as its own
   `quota_exhausted` outcome and warns loudly rather than counting it as a
   failure. Note `daytona.list()` returns an **async iterator**, not an array
   (`for await`, not `for`).

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

## The terminal builds the project into the image

`terminal.ts` bakes the project's own install steps (from `analyzeRepo`'s
`setupCommands`) into the image via `.runCommands()` **chained after
`.addLocalDir()`** — ordering matters, since the COPY has to land before any
RUN that touches repo files. Without this the user gets a shell full of
un-built source and the agent suggests binaries that don't exist (it proposed
`./croc --version`, which errors).

Setup is intentionally best-effort: it runs under `timeout 300` and writes to
`/repo/.tryrepo-setup.log` rather than failing the image, so a project that
won't compile still yields a working shell. Don't "fix" this by making it
fatal.

`tryCommand` is sanitized to its first non-comment line in code
(`firstCommand()`). Asking the prompt for "a single command" was not enough —
the model returned a multi-line script with commentary.

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

- **Dockerfile-less repos go through `synthesizeDockerfile.ts`**, which asks
  Fireworks to judge web-servability and write a Dockerfile if so. This is
  best-effort — it can pick the wrong package manager, miss a build step, or
  need env vars it can't know about (especially common for frontend
  frameworks needing build-time secrets). Don't treat a synthesis failure on
  one app as a pipeline bug without checking the actual build error first
  (`scripts/debug-build.ts` gives verbose Daytona build logs).
- **No secret/env-var handling.** Repos needing API keys etc. will build
  and/or start but likely fail. No human-in-the-loop prompting for missing
  secrets yet.
- **Regex-based Dockerfile parsing** (`detectExposedPort`/`detectRunCommand`
  in `deploy.ts`) — last `EXPOSE`/`CMD`/`ENTRYPOINT` line wins. Works for
  typical single- and multi-stage builds with a shell in the final image;
  known to break on `FROM scratch`/distroless final stages (no shell to run
  the session command in).
- **HTTP-only.** A repo can have a perfectly valid Dockerfile and still not
  be usable here if it speaks a raw TCP protocol instead of HTTP (confirmed
  with `schollz/croc` — its `relay` command builds and starts fine, just
  isn't something a "preview URL" concept applies to).
- **`autoDeleteInterval: 30`** (minutes) is hardcoded in `deployRepo` — sandboxes
  are meant to be ephemeral trials, not persistent hosting. Don't change this
  to persistent without discussing it — that was an explicit, deliberate
  scope decision (see README), not an oversight.

If you're extending this (secret prompting, WorkOS auth, CodeRabbit pre-deploy
scanning, a browser terminal for non-web-servable repos via Daytona's PTY
support), check the README's "Sponsor tools used" and "Known limitations"
sections first — some of these were evaluated and deliberately cut, not
missed.

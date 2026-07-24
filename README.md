# tryrepo

Paste a GitHub repo URL, get a live, disposable preview running in an isolated
sandbox — no local setup, no figuring out configuration, nothing to clean up.

Built for the Daytona HackSprint w/ Braintrust (SF, July 24 2026).

## The problem

There are countless interesting open source projects on GitHub, but trying one
out usually means cloning it, reading through setup docs, installing the right
runtime versions, guessing at environment variables, and running it on your
own machine (with whatever that repo's code is doing to your system). Most
people give up before they get something running.

## What this does

1. You paste a GitHub URL (or `owner/repo` shorthand) into the chat.
2. The assistant calls a `deployRepo` tool that clones the repo and checks for
   a root-level `Dockerfile`. If there isn't one, **Fireworks** reads the
   README + manifest files and either writes a Dockerfile for it, or reports
   back that this isn't a web-servable project (a CLI tool, library, or
   docs/skills collection) rather than forcing a fake result.
3. Either way, it parses the `EXPOSE` port and `CMD`/`ENTRYPOINT` line, builds
   a sandbox image from that Dockerfile, and creates a **Daytona** sandbox.
4. It explicitly starts the app as a background session (see "Non-obvious
   findings" below), then exposes the port as a public preview URL.
5. You get a live link. The sandbox auto-deletes after 30 minutes.

**If it isn't a web app at all** — a CLI tool, TUI, or library — you don't get
a refusal. The agent opens an **interactive terminal** in the chat instead: a
real bash shell inside a sandbox with the repo checked out at `/repo`, on a
base image picked to match the project's language. That covers the majority
case: of 20 real trending repos, only 4 had a Dockerfile and 12 weren't web
apps at all.

Validated against real GitHub repos (not just synthetic fixtures) pulled from
a live "trending repos" snapshot (`src/data/trending-repos.json`).

## Sponsor tools used

| Tool | Role |
|---|---|
| **Daytona** | Core sandbox engine — builds an image from the target repo's Dockerfile, runs it isolated, exposes a public auto-expiring preview URL, and provides the **PTY sessions** behind the in-browser terminal. |
| **CopilotKit** | The chat UI and agent runtime (`/api/copilotkit`), plus two interactive surfaces: a **human-in-the-loop** form (`useHumanInTheLoop`) that pauses the agent to collect a repo's required env vars, and a **frontend tool** (`useFrontendTool`) that renders the live terminal inline in the chat. |
| **Fireworks AI** | Hosts the chat model (via `@ai-sdk/openai` pointed at Fireworks' OpenAI-compatible endpoint) that CopilotKit's `BuiltInAgent` uses to decide when to call `deployRepo` and to narrate results. |
| **Braintrust** | Every deploy attempt (success or failure, with timing) is logged as a traced span, so reliability is a measured number, not a claim. |

WorkOS and CodeRabbit were considered but cut — see "Cut list" below.

## Non-obvious findings worth knowing

All of these were confirmed with live, controlled tests against the real
Daytona API — not assumed from docs.

**Daytona does not auto-run a Dockerfile's `CMD`.** Creating a sandbox from a
built image only gives you the filesystem/environment; Daytona overrides the
entrypoint with `sleep infinity` to keep the sandbox alive for exec access.
The app has to be explicitly started afterward via a background session
(`sandbox.process.createSession()` + `executeSessionCommand(..., { runAsync:
true })`). This actually simplifies the design: whatever "run command" is
determined (parsed from the Dockerfile, or written by the LLM) is always
explicitly executed the same way, rather than relying on the image's own
entrypoint behavior.

**A non-root `USER` directive breaks sandbox startup entirely.** Daytona's own
in-sandbox agent needs to run as root to handle exec/session requests. A
Dockerfile ending in `USER nobody` (or any non-root user — a common, sensible
security practice) reproducibly fails sandbox startup with a misleading
"failed to resolve container IP" error, on every attempt, not just
occasionally. Confirmed with a controlled A/B test: an identical fixture
passed cleanly with no `USER` line and failed on two independent fresh
sandboxes with one added. `deploy.ts` now strips any `USER` line before
building — we don't need container-user hardening for an ephemeral trial
sandbox anyway.

**The same error can also mean the sandbox is just flaky, not broken.** The
"failed to resolve container IP" message is a known, currently-open Daytona
platform issue
([daytonaio/daytona#4142](https://github.com/daytonaio/daytona/issues/4142),
[#5137](https://github.com/daytonaio/daytona/issues/5137)) — a sandbox can
report started before it's actually network-reachable, or get starved on a
shared runner under concurrent load. `deploy.ts` retries session startup, and
if that doesn't recover, throws the sandbox away and creates a fresh one
rather than retrying the same dead one forever.

**Default build timeout is too short for real projects.** The SDK's
`daytona.create()` defaults to a 60s timeout — fine for installing prebuilt
dependencies, not enough once a build compiles from source (e.g. a Go
project). Bumped to 240s.

**A Dockerfile existing doesn't mean the app is HTTP-servable.** `schollz/croc`
has a root Dockerfile and builds and starts cleanly, but its `relay` command
runs a raw TCP protocol, not HTTP — the "preview URL" concept just doesn't
apply to it even though the port is genuinely reachable. Not something to
special-case around; just a real limit of what "deploy this repo" can mean.

## Running locally

```bash
pnpm install
cp .env.local.example .env.local   # fill in DAYTONA_API_KEY and FIREWORKS_API_KEY
pnpm dev
```

`BRAINTRUST_API_KEY` is optional for local dev — deploy logging is a no-op
without it.

## Known limitations (honest, not hidden)

- **Naive Dockerfile parsing.** Regex-based extraction of `EXPOSE`/`CMD`/
  `ENTRYPOINT` — takes the last occurrence, which is usually but not always
  correct for multi-stage builds.
- **`FROM scratch` / distroless final stages** (e.g. static Go binaries) have
  no shell, so the session-based "run this command" approach won't work for
  them. Works well for typical Python/Node/Ruby-based images.
- **No secret handling.** Repos that need env vars/API keys to function (at
  build time or runtime) will build and/or start but likely fail. Especially
  common for LLM-synthesized Dockerfiles on frontend frameworks that need
  build-time env vars. Human-in-the-loop secret prompting was scoped out of
  this build.
- **HTTP-only.** Services speaking a raw TCP protocol instead of HTTP (like
  `croc relay`) will build and run but have no meaningful "preview URL".
- **Synthesis is best-effort.** The LLM-written Dockerfile can guess the wrong
  package manager, miss a build step, or otherwise be subtly wrong — no
  different in kind from a human guessing at an unfamiliar repo's setup.

## Project structure

```
src/
  app/
    api/copilotkit/route.ts   CopilotKit runtime: Fireworks model + deployRepo tool
    page.tsx                  Chat UI
  lib/
    deploy.ts                 Core pipeline: clone -> detect/synthesize -> strip USER -> build -> sandbox -> expose
    synthesizeDockerfile.ts   Fireworks-based Dockerfile generation for repos without one
    fireworks.ts              Shared Fireworks client/model config
    braintrust.ts             Deploy-attempt tracing
scripts/
  test-deploy.ts              Standalone test harness for lib/deploy.ts (bypasses the chat UI)
  debug-build.ts              Verbose Daytona build-log output for diagnosing a specific repo's build failure
```

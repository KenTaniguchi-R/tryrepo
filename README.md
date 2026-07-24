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
   a root-level `Dockerfile`.
3. If found, it parses the `EXPOSE` port and `CMD`/`ENTRYPOINT` line, builds a
   sandbox image from that Dockerfile, and creates a **Daytona** sandbox.
4. It explicitly starts the app as a background session (see "Non-obvious
   finding" below), then exposes the port as a public preview URL.
5. You get a live link. The sandbox auto-deletes after 30 minutes.

**Current scope: Dockerfile-based repos only.** Repos without a root
Dockerfile return a clear error rather than silently failing — inferring a
run command for arbitrary repos is a real feature but out of scope for this
build.

## Sponsor tools used

| Tool | Role |
|---|---|
| **Daytona** | Core sandbox engine — builds an image from the target repo's Dockerfile, runs it isolated, exposes a public auto-expiring preview URL. |
| **CopilotKit** | The chat UI and agent runtime (`/api/copilotkit`). The `deployRepo` tool is defined as a backend tool the agent calls when a user shares a repo link. |
| **Fireworks AI** | Hosts the chat model (via `@ai-sdk/openai` pointed at Fireworks' OpenAI-compatible endpoint) that CopilotKit's `BuiltInAgent` uses to decide when to call `deployRepo` and to narrate results. |
| **Braintrust** | Every deploy attempt (success or failure, with timing) is logged as a traced span, so reliability is a measured number, not a claim. |

WorkOS and CodeRabbit were considered but cut — see "Cut list" below.

## Non-obvious finding worth knowing

**Daytona does not auto-run a Dockerfile's `CMD`.** Creating a sandbox from a
built image only gives you the filesystem/environment; Daytona overrides the
entrypoint with `sleep infinity` to keep the sandbox alive for exec access.
The app has to be explicitly started afterward via a background session
(`sandbox.process.createSession()` + `executeSessionCommand(..., { runAsync:
true })`). This was confirmed with a live spike before writing any product
code — see `git log` for the throwaway Python spike that found this.

This actually simplifies the design: whatever "run command" is determined
(parsed from the Dockerfile here, could be LLM-inferred for non-Dockerfile
repos later) is always explicitly executed the same way, rather than relying
on the image's own entrypoint behavior.

## Running locally

```bash
pnpm install
cp .env.local.example .env.local   # fill in DAYTONA_API_KEY and FIREWORKS_API_KEY
pnpm dev
```

`BRAINTRUST_API_KEY` is optional for local dev — deploy logging is a no-op
without it.

## Known limitations (honest, not hidden)

- **Dockerfile-only.** No fallback yet for repos without a root Dockerfile.
- **Naive Dockerfile parsing.** Regex-based extraction of `EXPOSE`/`CMD`/
  `ENTRYPOINT` — takes the last occurrence, which is usually but not always
  correct for multi-stage builds.
- **`FROM scratch` / distroless final stages** (e.g. static Go binaries) have
  no shell, so the session-based "run this command" approach won't work for
  them. Works well for typical Python/Node/Ruby-based images.
- **No secret handling.** Repos that need env vars/API keys to function will
  build and start but likely fail at runtime. Human-in-the-loop secret
  prompting was scoped out of this build.

## Project structure

```
src/
  app/
    api/copilotkit/route.ts   CopilotKit runtime: Fireworks model + deployRepo tool
    page.tsx                  Chat UI
  lib/
    deploy.ts                 Core pipeline: clone -> detect -> build -> sandbox -> expose
    braintrust.ts              Deploy-attempt tracing
scripts/
  test-deploy.ts               Standalone test harness for lib/deploy.ts (bypasses the chat UI)
```

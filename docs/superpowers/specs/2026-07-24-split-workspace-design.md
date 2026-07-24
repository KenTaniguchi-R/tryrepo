# Split workspace: embedded preview + repo-aware chat

**Date:** 2026-07-24
**Status:** Approved, not yet implemented

## Problem

Today tryrepo is a single-column chat. You paste a repo, the agent deploys it, and
you get a preview URL as a link. The running app lives in another tab, and the
conversation ends once the URL is handed over.

Two things are missing. The preview is not visible next to the thing that produced
it, and the agent knows nothing about the repo it just deployed, so you cannot ask
it anything about the code.

## What we are building

Once the agent produces something runnable, the page becomes a workspace: the result
is shown on the right, and the same conversation continues on the left, now able to
read the repo it just worked on.

"Something runnable" has two forms, because the codebase already handles both:

- A **web repo** gets deployed and the preview URL is embedded in an iframe.
- A **non-web repo** (CLI, TUI, library) gets an interactive terminal in a sandbox,
  via the existing `openTerminal` frontend tool.

Both occupy the same right-hand pane. Today the terminal renders inline inside the
chat message list, which gives a 28-row PTY roughly a third of the screen; moving it
into the pane is part of this work.

Scope is read-only question answering about the code. The agent does not edit files
and does not redeploy.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Chat's job | Explain the repo, read-only | Smallest scope that delivers the feature. Editing is a separate project. |
| Retrieval | Structural primer, then file tools | Matches how coding agents actually work. See "Retrieval" below. |
| Layout | Transform in place on deploy success | Keeps the current landing intact; one conversation, one URL. |
| Agent | Same agent, wider toolbelt | `analyzeRepo` and `deployRepo` stay; file tools are added. |
| File source | The local clone | It is already the build input, which is what a future edit loop needs. |
| Clone lifecycle | Keep it, sweep it on a timer | Deliberately minimal. No session abstraction until editing lands. |

### Retrieval: why not embeddings

Research on current practice was consistent. Claude Code's team started with RAG and
a local vector DB and dropped it, reporting that agentic search works better and
avoids problems with staleness, privacy, and reliability. Sourcegraph, which sold
code embeddings, removed them because keyword search scaled and embeddings did not.

The cost-curve argument applies with unusual force here. An index pays a high build
cost that only amortizes across many queries. Our case is the worst case for
indexing: an arbitrary repo the user pastes, asked about for a few minutes, discarded
within thirty. We would pay a full embed on every deploy and throw it away.

One honest caveat. The usual headline argument for agentic search is index staleness,
and that argument does not apply to us: read-only Q&A means the repo never changes
mid-session. The real justification here is cold-start cost and exact-match
precision, since vector search returns `getUserByEmail` when the question was about
`getUserById`. On ContextBench, semantic retrieval was in fact *more* precise on
vague intent queries. It is not useless, just not worth the infrastructure at our
scale and session length.

The refinement that multiple sources converge on: do not grep from nothing. Give the
model the directory tree and README first so it knows where to look, then let it
search and read pinpointed.

### File source: why the local clone

`deploy.ts` builds the image with
`Image.fromDockerfile(dockerfilePath).addLocalDir(workDir, "/repo")`. Daytona builds
from the local directory, so the clone is the build input. That makes it the right
home for file tools even though a copy also exists inside the sandbox at `/repo`.

For the eventual edit-and-redeploy loop this is decisive. Editing the local clone and
rebuilding is a short path through code that already exists. The sandbox copy is
inert: the Dockerfile already copied and built the source during image build, so
editing `/repo` does not change the running app, and a compiled final stage may not
even have a toolchain. Redeploying from there would mean pulling files back out to
the host to build, arriving where the local clone already is.

Two further benefits. The clone is a real git checkout, so `git diff` gives change
review and revert for free. And edits survive a failed build, leaving the agent
something to fix forward.

The cost: this makes the app stateful on local disk, which rules out serverless
hosting later without a volume or object store. Acceptable for a locally-run app.

## Architecture

### Workspace

New `src/lib/workspace.ts`. An in-memory
`Map<workspaceId, { workDir, repoUrl, previewUrl?, sandboxId?, createdAt }>`, with an
interval sweeper that removes entries older than 35 minutes and deletes their
`workDir`. The TTL sits just past the sandbox's own 30-minute auto-delete.

It follows the module-level store idiom already established in `terminal.ts`: a
`Map` plus a monotonic counter, with `getWorkspace()` / `closeWorkspace()` accessors.
Cleanup follows the philosophy documented in `reapSandboxes.ts` — opportunistic, and
never allowed to fail a user-facing operation.

Two call sites currently delete their clone in a `finally` and both need to hand it
to the workspace instead:

- `deploy.ts:259-261` in `deployRepo`
- `terminal.ts:114-116` in `startTerminalSession`

Registration happens whenever the clone succeeded, including when the build later
fails, so repo questions still work on a failed deploy.

Nothing is persisted. A server restart loses all workspaces, and the sweeper is the
only reclamation path.

### Retrieval tools

The runtime is constructed once at module load with a static `prompt` string. There
is no clean per-request hook for injecting repo-specific context into the system
prompt without rebuilding the runtime per request. So the primer is a tool rather
than prompt injection.

This is arguably better than injection: the model pays for the primer only when the
conversation is actually about the repo, not on every deploy.

Four backend tools, defined like the existing ones:

- `getRepoOverview({ workspaceId })` — depth-capped directory tree skipping `.git`
  and `node_modules`, plus README and manifests. Largely the existing
  `readRepoContext()`.
- `listFiles({ workspaceId, subdir?, depth? })`
- `grepRepo({ workspaceId, pattern, glob?, maxResults })` — implemented with
  `git grep`, since the clone is a git checkout and we already shell out to `git`.
  No new binary dependency.
- `readFile({ workspaceId, path, offset?, limit? })` — capped, text only.

The system prompt gains one rule: call `getRepoOverview` before answering questions
about the code.

### Guardrails

Every path argument is resolved and asserted to remain inside its `workDir` before
any read. Binary files are skipped by extension and null-byte sniff. File reads and
grep results are capped.

This is the one place where a bug is a security problem rather than a UX problem: an
agent that can be talked into reading `../../.env.local` is a real exposure, since
that file exists in this repo.

### Frontend

`page.tsx` holds one piece of state describing what the pane should show:

```ts
type PaneState =
  | { kind: "none" }
  | { kind: "preview"; workspaceId: string; previewUrl: string; startedAt: number }
  | { kind: "terminal"; sessionId: string; repoUrl: string; baseImage: string };
```

`kind: "none"` renders today's centered landing, unchanged. Anything else renders the
split view.

The two producers differ, and the difference matters:

- **`deployRepo` is a backend tool.** It is observed with `useRenderTool`, whose
  complete state exposes `result` as a **string**, so the renderer must `JSON.parse`
  defensively and tolerate an error payload.
- **`openTerminal` is a frontend tool** (`useFrontendTool` in `TerminalTool.tsx`).
  Its `render` receives `result` **already parsed** as an object — see
  `TerminalTool.tsx:52`, which casts directly with no parse. Do not add one.

Because a renderer is a React component, neither may call `setState` during render.
Lifting into page state happens in a `useEffect` keyed on the tool call id.

`TerminalTool` keeps its handler and its executing/error states inline in the chat,
but on success it reports upward instead of mounting `RepoTerminal` in the message
list. `RepoTerminal` itself moves into the pane essentially unchanged; its fixed
`h-[340px]` becomes a flex fill so it can use the pane's full height.

Two new pieces:

- `src/components/PreviewPane.tsx` — chrome bar with reload (via `key` bump),
  open-in-new-tab, and an expiry countdown; the iframe; and the state handling below.
- `src/app/api/frame-check/route.ts` — server-side `HEAD` against the preview URL,
  reading `X-Frame-Options` and CSP `frame-ancestors`, returning `{ embeddable }`.

### Framing is not guaranteed

A live preview URL was checked and returned neither `X-Frame-Options` nor
`frame-ancestors`, so framing works. But that is a property of the deployed app, not
of tryrepo. Any repo whose app sets `X-Frame-Options: DENY` renders a silently blank
iframe, and there is no load error to catch. Hence the server-side probe before
embedding.

## States

| State | Behavior |
| --- | --- |
| Building | Pane mirrors the progress messages `deployRepo` already emits |
| Live (preview) | iframe, reload, open-in-new-tab, countdown to expiry |
| Live (terminal) | `RepoTerminal` fills the pane; its existing connecting / live / closed dot is kept |
| Expired | Notice replaces the iframe; chat keeps working, since the clone outlives the sandbox |
| Won't frame | `frame-check` returns not embeddable, so show an open-in-new-tab card rather than a blank box |
| Deploy failed | Stay on the landing; chat still answers repo questions from the clone |

A repo yields either a preview or a terminal, never both at once. The most recent
tool result wins, so a repo that fails to deploy and then falls back to a terminal
ends up showing the terminal.

## Testing

Following the existing `scripts/test-deploy.ts` pattern, `scripts/test-workspace.ts`
exercises the four tools against a real clone without going through the chat UI.

The path-traversal guard gets a unit test with adversarial inputs: `../` escapes,
absolute paths, and symlinks pointing outside the workspace.

Manual checks: a repo that frames cleanly, a repo that refuses framing, and the
expired state.

## Out of scope

- Editing files and redeploying
- Persistence across a page refresh or server restart
- Multi-user isolation and auth
- A two-pane mobile layout. Below roughly 900px this stacks into tabs.

## Open risks

- **Disk growth.** Kept clones are only reclaimed by the sweeper. A crash leaves
  orphans in the temp directory.
- **Primer cost.** A tree listing for a large repo is a large tool result. Depth and
  entry caps need tuning against a genuinely large repo, not just a small one.
- **`git grep` on a shallow clone.** Behavior should be confirmed against
  `--depth 1` checkouts, including with untracked generated files present.

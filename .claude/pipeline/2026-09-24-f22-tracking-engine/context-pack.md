# Context pack — F-22: Tracking engine (registers, gates, auto-published views)

## The roadmap row (verbatim, `.claude/roadmap/features.jsonl`)

```json
{
  "id": "F-22",
  "name": "Tracking engine: registers, gates and auto-published views",
  "description": "Keeps the roadmap registers self-updating: a validate gate, commit trailers, and scheduled renders that publish to Plane and brief every new session.",
  "area": "tooling",
  "release": "R1.1",
  "targetDate": "2026-09-24",
  "status": "planned",
  "percentDone": 0,
  "ownerLane": "Lead",
  "machine": "PC",
  "prs": [],
  "dependsOn": ["F-09"],
  "public": false,
  "notes": "Registers in the repo are the single source of truth; a validate gate in verify refuses inconsistent registers; commit/PR trailers (Feature:/Bug:/Defers:) let the tracker be computed from git; a post-merge hook and an hourly scheduled job render the three pages, publish them to Plane Pages via plane-docs.mjs, run plane:sync/triage and write a lag report; the SessionStart hook prints roadmap state and whether the artifacts are stale so any session on any account republishes with one call."
}
```

`F-09` (dependency, `in-progress`, 33%, owner=Lead, machine=PC): "keeping the project tracker in sync" — the Plane bug-sync harness below. `targetDate` on the F-22 row is TODAY (2026-09-24); this plan will very likely need a fresh target date, flagged as a finding, not silently changed.

**No prior spec/pipeline artifact for F-22 by name exists on this machine.** The Mac Lead could not find one either. The PC (`docs/roadmap-2026-09-23`) may hold one but is unreachable. Proceed from this pack; flag if the eventual PC spec disagrees.

## What ALREADY EXISTS (do not rebuild; extend or reuse)

### 1. The roadmap registers themselves — fully built, `.claude/roadmap/`

- `features.jsonl`, `deferred.jsonl`, `releases.jsonl` — one JSON object per line. Schema is informal (read the rows above and `README.md`).
- `README.md` documents the convention already: commit/PR trailers `Feature: F-07` / `Bug: B661` / `Defers: D-09` ("Use as many as apply; omit the rest"), who edits (bookkeeping PRs only, landing-coordinator follow-up), and the render command.
- **Nothing currently reads or enforces these trailers.** `prs[]` arrays and `percentDone` in `features.jsonl` are hand-edited by the landing coordinator today. "commit/PR trailers ... let the tracker be computed from git" (F-22's own words) is **not built** — this is real, new scope.

### 2. `scripts/roadmap/render.mjs` — fully built, standalone

- `node scripts/roadmap/render.mjs --validate` — checks id uniqueness (features/deferred/releases), required fields (`release`/`targetDate`/`status` on every feature), `dependsOn` integrity, an open deferred row has `revisitBy`+`owner`, a deferred row's `fromFeature` points at a real feature. **Already exits 1 on any problem, 0 clean** — ready to wire into `verify` essentially as-is (one line).
- `node scripts/roadmap/render.mjs [--prs <gh-pr-list.json>] [--out <dir>]` renders `roadmap.html` (public), `tracker.html` (internal, has an inline LAG section — features past `targetDate` and not `done`, deferred rows past `revisitBy` and still `open` — computed inline in HTML, no separate machine-readable lag artifact exists), `deferred.html`. `--out` defaults to `local-assets/roadmap/` (gitignored). `--prs` takes a **pre-saved** `gh pr list --json number,state,mergedAt,title,headRefName` file — **the script never calls `gh` itself** (repo convention: standalone scripts don't shell out to `gh`/network; the caller fetches and hands over a file).
- It does **not** cross-check `features.jsonl`'s `prs[]` array against real PR state, nor derive anything from git commit trailers. Purely a renderer + structural validator today.

### 3. The Plane bug-sync harness — fully built, this is F-09's scope, NOT F-22's

Confirmed via `node scripts/campaign/plane-docs.self-test.mjs` (all 10 checks pass, 1 skip for a machine-local file) and reading `package.json`'s `verify` tail directly:

- `package.json` scripts: `plane:sync`, `plane:check`, `plane:triage`, `plane:intake`, `plane:apply`, `plane:doctor`, `plane:retro` — all live, all wired into `verify` (self-tests run in order after `bugs.mjs self-test`; `plane:doctor -- --offline` runs after them).
- `.claude/settings.json` `hooks.SessionStart` = `[{"hooks":[{"type":"command","command":"node scripts/campaign/plane-triage.mjs --brief"}]}]`. **This is the ONLY SessionStart hook today** — it prints a read-only Plane triage brief (open items, stale ones, etc. over the _bug_ tracker), nothing about the roadmap registers. `hooks.PostToolUse` and `hooks.Stop` also exist and must never be clobbered — a SessionStart array element can be **added**, the object must never be replaced wholesale (this exact landmine is already pinned by `plane-docs.self-test.mjs`'s `existingHooksIntact` check — copy that pattern).
- `.claude/skills/plane/SKILL.md` (≤6144 B) documents the whole plane:* pipeline; `.claude/skills/rebuild/SKILL.md` mentions `plane:sync` as a post-deploy step.
- `scripts/campaign/plane-client.mjs` — the shared, reusable Plane REST client: `createClient({ baseUrl, slug, apiKey, tool, maxWrites, log })` builds against `api/v1/workspaces/{slug}/{path}`, rate-limited (knob-driven, `clientRatePerMin`), denylist-scanned (`scanForbidden`, `plane-denylist.json` — never send a live client name/identifier), write-ledgered (`appendWrite` → gitignored `.plane-writes.jsonl`), `machineRoot()`/`stateDir()` for a per-machine state dir (`.plane-sync-state.json`, also gitignored). **No Pages-specific function exists yet** — Plane's Pages API is a separate resource from the Issues/comments API this client currently drives; reuse `createClient()`'s auth/rate-limit/ledger plumbing, add the Pages calls.
- A machine-local **scheduled task** already exists as a _precedent_, not something F-22 owns: `~/.claude/scheduled-tasks/routeflow-plane-daily/SKILL.md` (this machine doesn't have it — the self-test prints `skip` when absent, by design, since it's per-machine). This is the mechanism (`mcp__scheduled-tasks__*` tools in this session) F-22's "hourly scheduled job" should almost certainly use, following the same per-machine, gitignored-state pattern.
- `.husky/_/post-merge` **exists but is an empty stub** today (`#!/usr/bin/env sh\n. "$(dirname "$0")/h"` — sources husky's loader, runs no actual command). A `post-merge` git hook only fires on the machine that performs the merge/pull locally — worth flagging in the spec, since this repo's landings mostly happen via `gh pr merge` (server-side squash) rather than a local `git merge`, so a _local_ post-merge hook may rarely fire for the person who actually needs the republish trigger. The hourly scheduled job is very likely the real backstop; the post-merge hook (if kept) is a nice-to-have for whoever's local tree does merge/pull.

## Repo conventions this plan must follow (CLAUDE.md, project-wide)

- **No Vitest, no Biome, no root-level test runner.** Standalone scripts (everything under `scripts/campaign/`, `scripts/roadmap/`) use the repo's own convention: a plain Node file run directly, printing `ok`/`FAIL` lines, exit 1 on failure — see any `*.self-test.mjs` for the pattern. `npm run verify` chains these with `&&`.
- **Who edits the registers:** "Bookkeeping PRs only... A feature or bug PR doesn't hand-edit these files in the same diff; the landing coordinator's docs-only follow-up updates the affected rows." Any new tooling that WRITES to `features.jsonl`/`deferred.jsonl` (e.g., an automated `prs[]` updater from git trailers) must respect this — likely: compute/report, never silently auto-commit a register change without the coordinator's own PR. Flag this as a design decision Fable must make explicitly (auto-write vs. auto-suggest/report).
- **Never a live client identifier anywhere** (registers, rendered pages, Plane sync payloads) — `plane-denylist.json`/`scanForbidden` already exists for the bug-sync direction; the roadmap-publish direction (rendered HTML → Plane Pages) needs the same discipline stated explicitly, even though the roadmap registers themselves are `"public":false`-gated per row already.
- **Heavy files policy:** rendered HTML goes to `local-assets/roadmap/` (gitignored) today — matches "Generated docs/screenshots go there, never into docs/" from CLAUDE.md. Do not commit rendered output.
- **`npm run verify` is already long** (24+ chained self-tests). A new gate must be genuinely cheap (`render.mjs --validate` already is — no network, no DB) — anything that calls Plane's API must NOT run inside `verify` (network calls in verify would make every push flaky on Plane being down); confirm the plan keeps Plane-publishing OUT of `verify` and IN the post-merge hook / scheduled job / a dedicated `roadmap:publish`-style script instead.
- **Money/tenancy/PII risk:** none — this whole feature is internal tooling, no production code path, no customer data. Every task here is LOW risk under the dev-pipeline risk model.

## Lessons worth citing (from `.claude/lessons/LESSONS-DIGEST.md`, read before planning)

- **L-194** (tooling): a tool that launches from the MAIN CHECKOUT's cwd, not the calling worktree's — relevant if any new script/hook assumes `process.cwd()` is the repo it's operating on; `render.mjs` already derives `ROOT` from `import.meta.url`, follow that pattern for anything new.
- **L-179** (tooling): "campaign-check freshness ritual" — this repo already has a full, hard-won pattern for "is this generated artifact stale relative to git state" (`scripts/campaign-check.mjs --freshness-only`, turbo-cache-aware). Read `scripts/campaign-check.mjs`'s freshness logic before designing F-22's own "prints whether artifacts are stale" — do not reinvent; the staleness check for rendered roadmap HTML vs. the JSONL registers is a much simpler version of the same problem (mtime / content-hash of `.claude/roadmap/*.jsonl` vs. the last-rendered output), but the EXISTING freshness machinery's shape (and its hard-won edge cases — a turbo cache hit leaving a stale report on disk) is the right prior art to reuse or explicitly diverge from.
- **L-176** (tooling, recurred): a worktree without its own build artifacts silently resolves to the main checkout's stale ones. If any new script imports `@routeflow/pricing` or another built package (unlikely here — this is pure tooling), the same trap applies.

## What is explicitly OUT of scope for this plan (flag, don't silently build)

- Any change to `@routeflow/*` app code, DB schema, or anything user-facing.
- Building the Plane Pages API integration from nothing-known — Plane's actual Pages endpoint shape (auth, payload) is **not yet confirmed** anywhere in this repo; the spec must name this as an open question / R# with a concrete verification step (a real, read-only or dry-run call against the workspace) before the build plan can commit to an exact request shape.
- Re-deriving F-09's already-shipped Plane bug-sync harness — F-22 depends on it (import/reuse `plane-client.mjs`), never rebuilds it.

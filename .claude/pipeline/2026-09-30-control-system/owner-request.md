# Owner request — Routeflow Development Control System (2026-09-30)

Verbatim-faithful condensation of the owner's chat spec. Nothing here is optional intent; sections 1-22 of the original collapse into the list below.

## Problem
Owner is manager/PO/CTO/dev at once, running several parallel "lanes" (sessions on different computers: feature, bug fix, test, investigation, release prep). They are losing track of: what each lane is doing and does next; which features are complete/partial/planned/blocked; bugs known/investigating/fixed; UI/UX issues; past and upcoming releases; customer requests; what changed and why; accidental overlap between lanes; cheap "piggyback" improvements in code a lane is already touching.

## Objective
One page answering: what is happening now, what happened, what should happen next. A lightweight operational control center that lives in the repo, is kept current BY the normal dev workflow (no constant manual upkeep), needs no new DB/service/project. Repository is the source of truth; dashboard reads structured files (yaml/json/jsonl) and is a visual + control layer. Private (not public); ideally generated/hosted from the repo.

## Home page ("command center") must show in seconds
Current development; per-lane current task; per-lane NEXT task; blockers; bug counts (open/critical/active/recently resolved); roadmap next; next-release status + readiness; recent changes (completed/changed/delayed/reprioritized/shipped).

## Roadmap items (click-through detail)
What, why, problem solved, how users interact, proposed implementation, dependencies, phases, status, priority, target release, related bugs/customer requests, relevant code areas. Long-term: Routeflow broader/better than tools studied (e.g. KHub).

## Feature tracking
Stages: Idea > Requirements > Design > Phase 1 > Phase 2 > Testing > QA > Release Candidate > Released. Show exact position + % + per-phase checklist (done / current / todo), so partial work never vanishes.

## Bug registry
Structured file; fields: id, title, description, severity, priority, status, date discovered, product area, repro, related files/modules, assigned lane, target release, resolution, date resolved. Dashboard filters by status/severity/module/release/lane. Dedicated bug hunts append to the same registry.

## Lanes
Each lane always knows current task + next task; on completion picks the next eligible task without the owner reconstructing state.

## Collision prevention
Tasks declare expected code areas (paths/modules). If another lane is heavily in those areas, make overlap visible (warn, not prohibit).

## Intelligent task queue
Per task: priority, business importance, customer impact, effort estimate, dependencies, target release, modules, related tasks, blocked?, piggyback opportunity.

## Piggyback opportunities
When a lane is modifying module X, surface small backlog items also touching X (example: invoice redesign -> RF-182 date alignment, RF-203 PO number, RF-211 mobile invoice view) so lead/dev can choose to bundle (saves re-exploration, time, tokens).

## Customer requests / priority changes
Flow: Request > Analysis > Discussion with Lead > Solution agreed > Feature definition > Phases > Priority decision > Task queue > Development. Once agreed it joins the same system, inserted without disrupting existing plan.

## Release management
Per-release view (e.g. Release 2.8, target date): READY / IN PROGRESS / AT RISK / MOVED. Contents change (add/remove/postpone/move); HISTORY of plan changes is preserved, never overwritten.

## Development history
Completed work never disappears. Per past release: planned vs shipped, bugs fixed, features introduced, postponed, technical decisions, what changed during development. = Routeflow's development memory.

## Interactive control
Open a task, inspect it, change priority, move between releases, assign to a lane, mark for reconsideration, change a lane's next task. Changes update the underlying repo state (no second disconnected copy).

## Lead coordination
Lead analyses a new requirement (what changes, modules, phases, dependencies, risks, lane, release, relative priority); owner approves; it becomes active plan; lanes work from it.

## Low token usage
No agent re-reads the whole history. Status changes are tiny structured updates, e.g. `task: RF-231 status: completed lane: lane-2 completed_at: 2026-09-30 release: 2.8`. A lane finishing a task writes a small record, never rewrites a large plan doc.

## Automatic updates
lane picks up task -> IN PROGRESS; implementation done -> CODE COMPLETE; testing finds bug -> new bug; bug fixed -> RESOLVED; release shipped -> tasks RELEASED, release SHIPPED, history updated. Lightweight repo operations.

## The dashboard must answer
What are we building (roadmap) / now (active) / each lane doing (lane board) / what next (queue) / what's broken (bugs) / blockers / shipping next (release board) / shipped before (history) / partially implemented (feature progress) / what changed recently (activity timeline) / will two lanes collide (overlap warnings) / what can be fixed cheaply while we're here (piggyback).

## Final goal
Persistent operational memory + control layer; repo-native, cheap, low-token, easy for humans AND agents to maintain; development runs as a coordinated system, not independent AI sessions.

---
# Decisions already made with the owner (do not re-litigate)

1. **Lane writes**: each lane appends ONE-LINE events to its own `events/<lane>.jsonl` inside its normal code PR. Per-lane file + append-only = no merge conflicts. This AMENDS the existing "registers are bookkeeping-PR-only (Option B)" rule for this one file type only; the plan must state the amended rule, where CLAUDE.md/roadmap README need the edit, and what validation/hook (stop.mjs Gate 2/3, validate scripts) must accept it.
2. **First build = vertical slice**: tasks.jsonl, lanes.json, events, overlap + piggyback computed from `areas[]` path globs, a home page showing lanes, queue, bugs, releases; IMPORT existing bug + roadmap data. Richer roadmap-item pages, history views, customer-request flow come in later slices (plan them as slices 2-3 at outline level only).
3. **Reuse, don't rebuild**: `.claude/campaign/bugs.jsonl` (652 rows) + `.claude/campaign/bugs/B###.md`, `.claude/roadmap/{features,deferred,releases}.jsonl` + `.claude/roadmap/README.md`, `scripts/roadmap/render.mjs` (`--validate`, renders to gitignored local-assets/roadmap/), `.claude/campaign/status/*.jsonl`, `.claude/handoffs/`, `.claude/sa/RULINGS.md`. Plane harness exists (docs/plane, skill `plane`, board.json maps epics/batches to Plane ids) — decide explicitly whether the new system coexists with, reads from, or replaces pieces of it.
4. **Dashboard = static HTML generated by a script (extend render.mjs or sibling), viewed locally.** Interaction goes through a local command `npm run control` that serves the page on localhost and WRITES CHANGES BACK to the repo files (GitHub Pages is read-only and the repo is private except CI windows, so hosted write-back is out).
5. Project constraints (CLAUDE.md): npm+Turbo monorepo; Jest not Vitest; NO new test runner, no root ESLint config; Prettier double quotes/100 cols; Conventional Commits; no client identifiers/slugs/business names anywhere in the repo (goes public briefly for CI) — use `acme`-style placeholders; heavy-files policy (no binaries in git); code-map + lessons registers updated via Option B follow-up (Bookkeeping-Follow-Up: pending trailer); size ratchets exist; `npm run verify` is the gate; a dashboard is a UI surface => ui:true, full artifact set incl. ux-spec + design-system derive (RouteFlow has a design system: see docs/design-package and apps/web tailwind/tokens; the control dashboard is an internal dev tool, decide whether to reuse tokens or a minimal standalone CSS — it must not pull in React/Next build deps unless justified).

# Environment facts for the planner
- This checkout (`~/code/routeflow`, branch chore/opus-5-5-routing) is 299 commits BEHIND origin/master. Read authoritative files with `git show origin/master:<path>` (run `git fetch` first) — do not trust the working tree for roadmap/campaign/scripts state.
- Fleet reality: lanes run on a Mac and a PC (Windows paths appear in handoffs); paths/globs and the tooling must be cross-platform (Node only, no bash-only, no jq — jq is not installed).
- Lane names seen in repo handoffs: Lane U-units, Lane B, Lane C, F2 prover, landing coordinator, SA, mac-lead, IR, r-ui, s-scan, connect-lane. Derive the real list from `.claude/handoffs/` + `.claude/campaign/status/` + roadmap `ownerLane` fields.

---
# Decisions (round 2) — owner rulings 2026-09-30, relayed by the coordinator. SUPERSEDE decision 1 (events in code PRs) and decision 4 (local-only `npm run control`).

A. **Hosting**: an always-on private dashboard on Railway — a small Node service in the monorepo (`apps/control` or `tools/control`; own Dockerfile + railway.toml, watchPatterns scoped so it never redeploys on apps/api|web changes and they never redeploy on its changes). Behind auth (basic auth vs signed-cookie login with one owner password from env; no new auth vendor), `X-Robots-Tag: noindex, nofollow`, robots.txt Disallow all, no public links. Reads the repo through a READ-ONLY deploy key (fetch-only) plus a scoped token for write-back. GitHub Pages rejected (public-by-URL on a personal account, Actions minutes at the billing limit, no write-back). `npm run control` stays as the local dev mode of the same server.

B. **Real-time state feed**: an orphan branch `ctl/state` holds append-only per-lane event files. `npm run ctl -- start|done|block|bug|next …` appends one line and pushes it directly (retry-on-non-fast-forward with rebase; no PR, no CI, no hooks; must not trigger Railway deploys of api/web or any GH Actions workflow — verify every workflow's branch filters). Dashboard write-back appends to the same branch (its own `owner`/`dashboard` file). Define compaction (periodic snapshot + truncate so fetch stays small), retention, branch protection. Master still carries the curated registers (`.claude/roadmap`, `bugs.jsonl`); the server merges both sources.

C. **10x = infer, don't report**: derive most status with zero model tokens — open PRs (branch, head sha, changed files → REAL overlap from diffs; declared `areas[]` only as fallback for unpushed work), CI check state, Railway deploy state, conventional trailers (`Feature: F-07`, `Bug: B661`, `Defers: D-09`) to link work→rows, merged PR → auto status advance, lane heartbeat/staleness from last event or last push. Define the poll budget (GitHub REST/GraphQL limits, ETag conditional requests, ~30 s cadence, webhook alternative if cheap) and live push to browsers via SSE. Define reconciliation when an inferred state and a reported event disagree.

D. **Zero-token rendering**: server + renderer are deterministic Node; no LLM in the loop. Quantify per-lane agent cost (target ≤ 150 tokens per status change, ≤ 30 lines for `ctl next`).

P8 must cover: security of an internet-facing internal dashboard (login brute force/rate limit, token scope and rotation, CSRF on write-back, sensitive-flagged bug rows, the public CI window during which `ctl/state` is public too — state what must never be written there) and Railway cost ($/month).

# Owner addition (round 3) — PR ledger + nothing wasted

1. Track EVERY PR (open, draft, merged, closed-unmerged) and every pushed branch without a PR, zero model tokens, from GitHub. Per PR: lane, linked task/feature/bug (trailers + branch name), state, age, last activity, CI state, review state, mergeable/conflict, merged sha, deployed yes/no (Railway), files/areas.
2. **Waste detection** = a first-class panel ("At risk of waste") with testable rules and default thresholds: idle open PR > N days; draft never marked ready; red/stale CI; conflicting with master; closed-unmerged PR whose work never re-landed (commits/patch-id on master, else `supersededBy` link or it is waste); pushed branches/worktrees with commits not on master and no PR (local worktree audit via `scripts/worktree-audit.mjs` if it exists); merged not deployed; merged with `Bookkeeping-Follow-Up: pending` and no follow-up PR; task done with no merged PR; merged PR with no linked task/bug (orphan work); duplicate/overlapping PRs touching the same files across lanes. Each item: why flagged, suggested action (rebase / salvage / close as superseded / land), and an owner/lane acknowledge event so dismissed items don't re-nag.
3. PR history kept forever (ledger): count by release, lead time open→merge→deploy, closed-unmerged rate — feeds release history. Include the rate-limit budget (GraphQL batched PR query with changed files).

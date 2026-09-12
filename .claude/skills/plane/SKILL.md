---
name: plane
description: >
  Plane Cloud workspace routine for RouteFlow (BUGS/ROAD/OPS/DECIDE/CLIENT projects) — the
  shared plane-client.mjs and the four plane-sync.mjs/plane-intake.mjs/plane-triage.mjs/
  plane-apply.mjs scripts. Use when the user mentions Plane, ROAD-, OPS-, BUGS-, DECIDE-,
  "update Plane", "plane sync", "triage brief", or asks to file/triage/apply a Plane change.
---

# Skill: Plane workspace routine

Pointers, not prose — see each script's `--help` for flags; this is the map.

## What lives where

- **BUGS** — one-way mirror of the registry (`bugs.jsonl`); `plane:sync` is the only writer.
  Registry is proof, Plane is a view.
- **ROAD** — programs as Epics with Plan/Build/Land tasks; modules = programs, cycles = weeks.
- **OPS** — windows/incidents/due-dated items. **DECIDE** — one item per owner ruling.
- **CLIENT** — client asks; the ONLY project allowing a real business name. Never put a client
  name in BUGS/ROAD/OPS/DECIDE, code, tests, or the code map (CLAUDE.md policy).

No PQL, no custom properties, no webhooks, no cycle/module automation for ROAD — out of scope.

## Daily / per-landing routine

- **Session start**: `npm run plane:triage -- --brief` (also a `SessionStart` hook — unattended,
  always exit 0, never blocks).
- **Per landing**: write `local-assets/plane/ops/<date>-<slug>.json` (`{"ops":[...]}`, see
  `plane-apply.mjs --help`) → `plane:apply -- <file> --dry-run` to review → re-run for real →
  `plane:sync` → `plane:check` must exit 0 (drift gate).
- **Bugs filed straight in Plane** (no `B### ·` prefix) return via `plane:intake` (list) then
  `plane:intake -- --apply` — **only** on a clean tree (`.claude/campaign`) descended from
  `origin/master`; ids mint on master-merged trees only.
- **Scheduled**: `routeflow-plane-daily` (machine-local, not a file here) runs the triage brief
  daily; owner closes each cycle Monday in the Plane UI.

## The four scripts (`scripts/campaign/`)

All four: `--help`/`-h` and an unknown flag are checked FIRST, before any env read or network
call, and print a `Usage:` banner (exit 0 for `--help`, exit 2 for an unknown flag). Missing
`PLANE_API_KEY` → every script but `plane-apply.mjs` skips quietly, exit 0; `plane-apply.mjs`
exits 2 (it must write).

- **`plane-sync.mjs`** — registry → BUGS mirror + adoption + comment-on-close.
  `[--dry-run] [--check] [--quiet] [--strict] [--if-digest-changed] [--budget-ms <n>]
[--max-writes <n>] [--allow-branch] [--help]`. `plane:sync` / `plane:check` (`--check`, exit 1
  on drift).
- **`plane-intake.mjs`** — the ONE Plane→registry path.
  `[--apply] [--batch F##] [--over-budget "<reason>"] [--json] [--help]`. `plane:intake`.
- **`plane-triage.mjs`** — read-only session-start brief, ≤ 12 GETs, ≤ 1536 bytes.
  `[--brief|--json] [--days <n>] [--help]`. `plane:triage`.
- **`plane-apply.mjs`** — the one scripted write path for what the MCP classifier blocks.
  `<ops.json> [--dry-run] [--max-writes <n>] [--over-budget "<reason>"] [--help]`.
  `plane:apply -- <file>`. `relation` `type`: enum or label (case-free, spaces/hyphens→`_`);
  unknown fails validation, 0 writes

Shared client: `plane-client.mjs` (`createClient`) — every script above imports it; never a
second HTTP client or a direct `fetch` to Plane.

## Write budgets

- **Manual** (intake/apply): ≤ 20/day, counted machine-wide (ledger under `machineRoot()`, not
  per-tree `repoRoot()`); over budget refuses (exit 3) unless `--over-budget "<reason>"`.
- **`plane-sync.mjs --max-writes`**: default 250; explicit bulk: `plane:sync -- --max-writes
400`.
- **Gate 5** (turn-end, non-blocking): `--max-writes 25`, never `--allow-branch`.

## Branch guard (R14 — incident 2026-09-11 23:26Z)

`plane-sync.mjs` writes ONLY when the current branch is `master`/`main`, or `--allow-branch` is
passed; otherwise it lists/diffs but makes zero POST/PATCH, exit 0. **Why**: a v1 Gate 5 hook run
from a feature worktree created 282 live BUGS items (160 dupes) — a hook inherits the session's
cwd/credentials, so writes must be dry off the integration branch. Never pass `--allow-branch`
from an automated hook.

## Denylist

`plane-denylist.json` — every outbound string is scanned before it is printed/written; a hit is
dropped/failed, never printed. Patterns: tenant uuid, invoice number, email, connection string,
jwt, `*.up.railway.app` host, api-key token. Never put real tenant data in a Plane item.

## Classifier reality

In auto mode, MCP `workitem`/`comment`/`relation` **create** calls pass; `workitem update`
(state moves, field edits) does **not** — the classifier blocks it. Any state change,
comment-on-close, relation, or archive goes through `plane:apply`, never a live MCP update.

## Learning loop

- **Runs ledger** `local-assets/plane/runs.jsonl` (gitignored, `machineRoot()`-anchored) — one
  JSON line per tool run (sync/intake/triage/apply/doctor/retro): counters, exit, error class;
  never a key or uuid. A legacy pre-fix file migrates forward on first use.
- **`plane-doctor.mjs`** `[--offline] [--json]` — PASS/FAIL/WARN per check, exit 1 on FAIL. Run
  daily, in `verify` (`-- --offline`), and via `/orient`.
- **`plane-retro.mjs`** `[--days 14] [--apply] [--json] [--out <dir>]` — Mondays via the
  routine. Reads the ledger, proposes knob changes with evidence (≥ 10 runs/rule); `--apply`
  moves only `autoTune: true` knobs within bounds, once per window. A weekly knob PR to master
  follows (`docs/plane/retro/README.md`); candidate lessons land in
  `local-assets/plane/lessons-candidates.md`, never auto-filed to `.claude/lessons`.
- **`scripts/campaign/plane-knobs.json`** — tracked knob values (rate limit, budgets,
  thresholds). Change ONLY via `plane-retro.mjs` evidence or a PR citing it — never on taste.
- **Usage guard**: Gate 5 prints `Plane: last sync <age> ago` on master, plus `Plane: WARN
landing without sync` when a landing skipped the sync — report-only, never blocks.

## Setup / owner-only

Key + MCP re-registration trap, workspace slug: `local-assets/plane/OWNER-STEPS.md`
(gitignored, machine-local).

---
name: plane
description: >
  Plane Cloud workspace routine for RouteFlow (BUGS/ROAD/OPS/DECIDE/CLIENT projects) — the
  shared plane-client.mjs and the four plane-sync.mjs/plane-intake.mjs/plane-triage.mjs/
  plane-apply.mjs scripts. Use when the user mentions Plane, ROAD-, OPS-, BUGS-, DECIDE-,
  "update Plane", "plane sync", "triage brief", or asks to file/triage/apply a Plane change.
---

# Skill: Plane workspace routine

Pointers, not prose — read the script's own `--help` for exact flags; this is the map.

## What lives where

- **BUGS** — one-way mirror of the in-repo registry (`bugs.jsonl`). Never edited from Plane;
  `plane:sync` is the only writer. Registry is proof; Plane is a view.
- **ROAD** — features/programs, one Epic per program with Plan/Build/Land child tasks; modules
  = programs, cycles = weeks.
- **OPS** — windows/incidents/due-dated ops items.
- **DECIDE** — one item per owner ruling.
- **CLIENT** — client asks; the ONLY project where a real business name is allowed. Never put a
  client name in BUGS/ROAD/OPS/DECIDE, code, tests, or the code map (CLAUDE.md policy).

No PQL, no custom properties, no webhooks, no cycle/module automation for ROAD — out of scope.

## Daily / per-landing routine

- **Session start**: `npm run plane:triage -- --brief` (also wired as a `SessionStart` hook —
  runs unattended, always exits 0, never blocks).
- **Per landing**: write one ops file `local-assets/plane/ops/<date>-<slug>.json` (schema:
  `{"ops":[...]}`, see `plane-apply.mjs --help`) → `npm run plane:apply -- <file> --dry-run` to
  review the resolved plan → re-run without `--dry-run` to apply → `npm run plane:sync` →
  `npm run plane:check` must exit 0 (drift gate).
- **Bugs filed straight in Plane** (no `B### ·` name prefix) come back to the registry via
  `npm run plane:intake` (list) then `npm run plane:intake -- --apply` — **only** on a tree that
  is clean (`.claude/campaign`) and descends from `origin/master`; ids are minted on
  master-merged trees only.
- **Scheduled**: the `routeflow-plane-daily` scheduled task (created outside this repo, not a
  file here) runs the triage brief daily; the owner closes each cycle Monday in the Plane UI.

## The four scripts (`scripts/campaign/`)

All four: `--help`/`-h` and an unknown flag are checked FIRST, before any env read or network
call, and print a `Usage:` banner (exit 0 for `--help`, exit 2 for an unknown flag). Missing
`PLANE_API_KEY` → every script but `plane-apply.mjs` skips quietly, exit 0; `plane-apply.mjs`
exits 2 (its whole purpose is to write).

- **`plane-sync.mjs`** — registry → Plane BUGS mirror + adoption of pre-existing Plane items +
  comment-on-close.
  `[--dry-run] [--check] [--quiet] [--strict] [--if-digest-changed] [--budget-ms <n>]
[--max-writes <n>] [--allow-branch] [--help]`. `npm run plane:sync` / `npm run plane:check`
  (= `--check`, exit 1 on drift).
- **`plane-intake.mjs`** — Plane → registry front door (the ONE Plane→registry path).
  `[--apply] [--batch F##] [--over-budget "<reason>"] [--json] [--help]`. `npm run plane:intake`.
- **`plane-triage.mjs`** — read-only session-start brief (overdue / due-soon / open rulings /
  stale-started / BUGS drift / writes-today), ≤ 12 GETs, ≤ 1536 bytes.
  `[--brief|--json] [--days <n>] [--help]`. `npm run plane:triage`.
- **`plane-apply.mjs`** — the one scripted write path for what the MCP classifier blocks (state
  moves, comments, relations, archive, create) from an ops file.
  `<ops.json> [--dry-run] [--max-writes <n>] [--over-budget "<reason>"] [--help]`.
  `npm run plane:apply -- <file>`.

Shared client: `plane-client.mjs` (`createClient`) — every script above imports it; never a
second HTTP client or a direct `fetch` to Plane.

## Write budgets

- **Manual** (intake/apply, `writesToday({exclude:["plane-sync"]})`): ≤ 20/day; over that,
  the run refuses (exit 3) unless `--over-budget "<reason>"` is passed.
- **`plane-sync.mjs --max-writes`**: default 250 (a full mirror run); explicit bulk run:
  `npm run plane:sync -- --max-writes 400`.
- **Gate 5** (`.claude/hooks/stop.mjs`, turn-end, non-blocking): `--max-writes 25` — a hook must
  never bulk-write. Gate 5 never passes `--allow-branch` (see below).

## Branch guard (R14 — incident 2026-09-11 23:26Z)

`plane-sync.mjs` writes ONLY when the current branch is `master`/`main`, or `--allow-branch` is
passed; otherwise it still lists/diffs but makes zero POST/PATCH and exits 0. **Why**: a v1 Gate
5 hook run from a feature worktree, with the real key in the environment, created 282 live BUGS
items (160 duplicates) — a hook inherits the session's cwd and credentials, so a write path must
be dry by default off the integration branch. Never pass `--allow-branch` from an automated hook.

## Denylist

`scripts/campaign/plane-denylist.json` — every outbound string (name/description/comment) is
scanned before it is ever printed or written; a hit is dropped/failed, never printed. Patterns:
tenant uuid, invoice number, email, connection string, jwt, `*.up.railway.app` host, api-key-ish
token. Never put real tenant data, uuids, invoice numbers, emails, or hosts in a Plane item.

## Classifier reality

In auto mode, MCP `workitem`/`comment`/`relation` **create** calls pass; `workitem update`
(state moves, field edits on an existing item) does **not** — the classifier blocks it. Any
state change, comment-on-close, relation, or archive therefore goes through `plane:apply`, never
a live MCP `workitem update` call.

## Setup / owner-only

Key + MCP re-registration trap, workspace slug: `local-assets/plane/OWNER-STEPS.md` (gitignored,
machine-local — not in this repo's tracked tree).

# Discovery — 2026-09-11-plane-harness (Fable 5.1)

**Status:** APPROVED (owner ask 2026-09-11: "establish harnesses to automatically tackle Plane, and update them"; DECIDE-27 supersedes "no sync code").

## Problem and whose it is

The owner uses Plane Cloud (workspace `routeflow`, projects BUGS/ROAD/OPS/DECIDE/CLIENT) as the management front door and wants it to track bug fixes, new bugs, security recommendations and feature asks without a human retyping them. Today every Plane write is a hand-made MCP call by the Lead session, and the auto-mode classifier blocks `workitem update` outright (observed 2026-09-11, twice; a subagent was blocked the day before), so state moves silently do not happen. Cost: Plane drifts from the registry within a day of each landing (2026-09-11 drift report: 122 of 282 registry rows missing in Plane, 4 rows in the wrong state, 0 of 160 items carry the `external_id` foreign key).

## Current workaround and why it fails

`local-assets/plane/seed-plane.mjs` (gitignored, name-keyed, create-only) plus manual MCP calls. It cannot move states (classifier), cannot detect drift, and re-running it creates duplicates once names change. Branch `feat/plane-bugs-mirror` (unmerged) adds `plane-sync.mjs` keyed on `external_id`, but every existing item has `external_id = null`, so its first run would duplicate all 160 items. A scratch REST script (2026-09-11) proved that script-path writes DO pass the classifier — the deterministic path works; it just needs to be a tested, budgeted, denylisted tool instead of a scratch file.

## Why now

Window 15 (train 4, 7 PRs) lands next; PR #690 adds 72 registry rows; F48 adds 6 security rows. Without the harness the owner re-does ~200 rows by hand or Plane goes stale for good.

## If we ship nothing

Plane becomes a second, stale copy — exactly the "two trackers" outcome the 2026-09-06 evaluation refused.

## Success signal (observable, with baseline)

`node scripts/campaign/plane-sync.mjs --check` exits 0 (no drift) after every landing; baseline today: 126 differences (122 missing + 4 wrong state, the latter fixed by hand 2026-09-11). `plane-triage --brief` prints a ≤ 1.5 KB brief at session start; baseline: none exists.

## Who else is affected

Every future Lead session (reads the brief instead of re-deriving the day); the daily scheduled routine (a read-mostly Plane pass); the owner (one reviewable ops file per landing instead of ad-hoc chat writes).

## Symptom or problem?

Problem. The symptom (classifier-blocked MCP updates) is real but the root need is a deterministic, reviewable, budgeted write path plus a drift detector — which is also what the 2026-09-06 evaluation's four gates demand.

## Strongest objection

"A sync harness is the drift machine the evaluation warned about." Answer: this harness is one-way for state (registry → Plane), keyed on Plane's documented `external_id` upsert field, reconciles by read (`--check`) not by webhook, never deletes, scans every outbound string against a tracked denylist, and caps writes. Plane → registry is intake only (Plane-created items become `bugs.mjs file` commands; the registry stays the proof).

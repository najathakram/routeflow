# Fleet handover — new account / new sessions (written 2026-09-24 by the outgoing fleet lead)

The owner is moving the fleet to a different Claude account with brand-new lead, SA and lane sessions
once the cleanup is done. This file is the ONE place a new session starts. Everything else is linked.

## 0. Owner checklist before opening the new sessions

1. **Same Windows/macOS user?** If yes, skip to 2. If the OS user changes, copy these first — they are
   NOT in git: `~/.claude/skills/` (user-level dev-pipeline RUN-LOG, model-routing, closeout.mjs),
   `~/.claude/hooks/`, `~/.claude/CLAUDE.md`, and the project memory dir
   `~/.claude/projects/C--ClaudeCode-routeflow/memory/` (PC) / the Mac equivalent.
2. **Artifacts belong to the old account.** Tracker `WRxxrqUTN8eTCcua4Men1f`, bug registry
   `BkAauchd9tiGjvwpQuRWhz`, K-HUB gap ledger `2aKk9VeqRq68oBuwGK9BH1`. Either share them to the new
   account with EDIT access, or the new lead publishes fresh ones (regenerate from the registers — never
   from the stale `local-assets/roadmap/tracker.html`).
3. **Keep the old session titles** for the new sessions (table in §2). Every lane prompt and the
   cross-session messaging use those titles as addresses.
4. `gh auth status` and `railway whoami` work under the new account on each machine (owner types any
   credentials — agents never do).
5. Re-connect claude.ai connectors the new account needs (Plane MCP for F-22; HubSpot/Lovable were
   unauthenticated on 09-24 and nothing depends on them).

## 1. State sources (trust in this order)

1. Live repo: `node .claude/skills/fleet-lead/scripts/fleet-status.mjs` (master sha, open PRs + checks,
   #938 tail, worktrees, bug counts; ~75 s). The fleet-lead skill lands on master via **PR #1363**
   (branch `docs/skills-opus55-fleet-lead`, `f819ac75b`, supersedes closed #1342); the bug registry lands
   via **PR #1285** (`14cf1c6c2`, kept current with master, carries the mac-handoff + B845 + B846) — if
   either is not merged yet, check that branch out read-only.
2. Board: GitHub issue **#938** — every SA ruling and review verdict at an exact sha.
3. `local-assets/handoff/2026-09-24/` (PC only, gitignored):
   `LEAD-NOTES.md` (lead decisions, newest last) · `LANE-PROMPTS.md` (per-lane current item + restart
   prompt) · `R1-PLAN.md` (definition of done, SA-144 queues) · `R1-R11-REMAINING.md` (every open R1/R1.1
   item) · `REQUIREMENTS-TABLE.md` (528 owner requests + state) · `CLEANUP-PLAN.md` (PC worktree/branch
   classification) · `SA-136/137/138/149/150-*.md` (rulings) · `QUICK-WINS-83.md` · `OWNER-REQUESTS-AUDIT.md`.
4. Mac state: `.claude/handoffs/2026-09-24-mac-handoff.md` (the outgoing Mac Lead writes and pushes it).
5. This repo's `.claude/handoffs/2026-09-24-lead-day.md` (owner's order + in-flight snapshot).

## 2. Sessions to create (same titles)

| Title                                      | Machine  | Role / file area                                                   | Model                                  |
| ------------------------------------------ | -------- | ------------------------------------------------------------------ | -------------------------------------- |
| RouteFlow fleet lead                       | PC       | routing, reviews, owner comms; never implements                    | Opus 5.5 (Fable for rulings if wanted) |
| Senior Architect role and operating rules  | any      | rulings (SA-nnn) + tier-1 first pass, posts on #938                | Fable 5.1                              |
| RouteFlow landing coordinator              | PC       | serial landing windows, public/private flips, bookkeeping PRs      | Sonnet 5                               |
| RouteFlow Mac Lead coordination            | Mac mini | Mac lanes, registry (mints bug ids via bugs.mjs), mini disk/Colima | Opus 5.5                               |
| RouteFlow Mac F2 prover                    | Mac mini | DB proofs (`*.db.spec.ts`), image builds alone                     | Sonnet 5                               |
| Lane B                                     | Mac      | `orders.service.ts` (#1310 B776 critical)                          | Sonnet 5                               |
| RouteFlow Lane IR inline returns web       | Mac      | regulated/returns + ledger (#1324, #1246, B650…)                   | Sonnet 5                               |
| RouteFlow R-ui rule dialog follow-ups      | Mac      | pricing package + ledger specs (#1319, #1341, B687, D-20…)         | Sonnet 5                               |
| RouteFlow Lane web unit-line edit          | Mac      | order-line / unit-line (#1339 REQUIRED, B718, B740, B679…)         | Sonnet 5                               |
| RouteFlow Lane B707 mobile edit-items pack | Mac      | `invoices.service.ts` (B824 #1336, B556/B557 #1335, B733…)         | Sonnet 5                               |
| RouteFlow MacBook landing                  | MacBook  | tooling, F-09, F-22 tracking engine, #1134, #1330 B646             | Sonnet 5                               |
| Extract and fix vendor-bills poTotal drift | MacBook  | PO / vendor-bills (#1344, #1352, B743 D, B710, B746, D-11)         | Sonnet 5                               |
| RouteFlow Lane F prover setup              | PC       | #1353 B785, B692 (SA ruling pending), D-14, F-23                   | Sonnet 5                               |
| Order UI redesign steps 10–11              | PC       | web order/list screens (#1340 spec 61, #1288, B597…)               | Sonnet 5                               |
| RouteFlow Lane S-scan resume               | PC       | scanner + mobile display (#1271, #1329, B653…)                     | Sonnet 5                               |
| Cloud: B562 builder / policy PR-A builder  | cloud    | #1331 B562 PR-1..4 then SA-137; #1337 policy PR-A only             | —                                      |

Each lane's paste-in prompt = LANE-PROMPTS.md's common preamble + its block. On the Mac, the Mac Lead
gives lanes their block from the mac handoff.

## 3. New lead — paste this into the fresh "RouteFlow fleet lead" session

```
You are the RouteFlow fleet lead (PC, C:\ClaudeCode\routeflow). Read, in order, before acting:
.claude/handoffs/2026-09-24-fleet-handover.md (this file), .claude/skills/fleet-lead/SKILL.md,
local-assets/handoff/2026-09-24/LEAD-NOTES.md (newest last), R1-PLAN.md, LANE-PROMPTS.md,
.claude/lessons/LESSONS-DIGEST.md. Then run fleet-status.mjs and `node .claude/skills/fleet-lead/scripts/lead-closeout.mjs digest`.
Priority (owner, 09-24): Release 1 F-01..F-08 to 100% (F-08 gate = SA-144 BLOCKS-FLIP + official F-07),
Release 1.1 (F-09, F-10, F-11, F-22, F-23) in parallel on lanes that don't touch R1 files, THEN policy
phases, delivery extras, bug sweep, quick wins; repo cleanup last (CLEANUP-PLAN.md; SALVAGE → PR first).
You route, review and relay; you never implement. Tier 1 = SA read + ONE Opus pass at the exact sha, batched
2–4 PRs per Opus agent; tier 2 = one pass. One file area per lane. Lanes are terse; you and the SA write
full outputs; owner questions go through the question box. Every 20 min: append new decisions to
LEAD-NOTES.md, then one Sonnet agent refreshes LANE-PROMPTS.md + the lead-day handoff (re-create the cron —
it died with the old session). Features → dev-pipeline lean; fixes → light loop; RUN-LOG entry per merge.
Standing safety: approved test tenants only; agents never type credentials; `railway run` only with the
owner's per-call yes; never force-push, --no-verify, janitor --apply or `git worktree remove --force`.
First message to the owner: a ≤ 10-line status (master sha, what landed, what's blocked, owner actions).
```

## 4. Snapshot at handover (2026-09-24 ~14:35Z — re-check live)

- Master now `59148a012` (#1344 merged 14:27:17Z). W16 CLOSED; W17 landing window is OPEN (watchdog PID
  10148, deadline 15:04:54Z). Owner action owed on #1334: run
  `apps/api/scripts/backfill-b294-order-line-taxrate.mjs` from a checkout AT master (dry-run first, then
  `--apply` with plan hash + `--guard-sha` + `--i-have-a-fresh-backup`) — the owner-run checkout
  `C:/ClaudeCode/rf-owner-reports` is staged and ready (detached at master, `npm ci` clean). Landing queue
  (coordinator, W17): #1321 → #1325 → #1354 → **#1319** (NOW LANDABLE — Opus merge-delta SHIP #938 5815316761) → #1121 (B597, CLEARED) → #1365 (D-14 re-cut, CLEARED T2; #1355 CLOSED, superseded) →
  #1315; then the docs window — all four PRs already opened: #1363 skills (`f819ac75b`, supersedes closed
  #1342), #1364 roadmap (`b09469ab9`), #1229 SA regs (`92b7ebc3`), #1285 registry (`14cf1c6c2`, kept
  current with master, carries the mac-handoff + B845 + B846). B846 filed (revertToDraft deletes PURCHASE
  StockMovement rows instead of a reversal); next free id B847.
- **#1310 RESOLVED**: the Opus delta SHIP W/N at `93bfbecb` (#938 5815422306, every REQUIRED item
  confirmed done) vs. F2's real-PG chain FAIL on case (f) at that SAME sha (#938 5815326782, posted first)
  — STANDARD line unitPrice re-derived to 3, expected 36 (12x, the pack size) — turned out to be
  **SA-124k's FIXTURE bug** (per-piece pricePerUnit seed), not a code regression; NO code change was owed.
  Lane B pushed the fixture-only fix at `eb66addd` (fixture 36 + ordering nit + verbatim-price pin; lead
  delta-read posted #938 5815709214). Gate now = F2 re-proves 8/8 at `eb66addd` + an SA delta read → land.
- HOLD: #1352 (SA-148 race db.spec), #1339 (Opus REQUIRED R1/R2, SA-sharpened: R1 keeps a non-404
  units-fetch failure parked rather than silently pricing it as pack; R2 fixes `effectiveTierFor` per
  line — unit-line lane on it now), #1356 (B679, fix DONE, unpushed at `1a2e30d0` —
  `orders.service.ts:1917` create() now passes the RESOLVED unitLabel + a refusal pin; SA-144g withdrew
  the update() half of SA-144f, create() is the whole fix; push with #1339's fix in one go), #1330 (B646
  wording + owner report), #1314 (CONFLICTING, owner unclear). #1355 CLOSED — superseded by #1365, the
  D-14 test commit (`0f5b3aed8`) re-cut clean onto a fresh branch off master (no B785 dependency), CLEARED
  T2. B845 filed (manual-invoice-lines.ts:142 tax basis, POST-R1 medium money); B846 filed (revertToDraft
  deletes PURCHASE StockMovement rows instead of a reversal); next free id B847.
- SHIP W/N but held for other reasons: #1353 B785 (held until Lane F's mobile stepper PR lands alongside
  it), #1331 B562 PR-1 + #1337 policy PR-A (held on the owner's prod migration BEFORE merge; #1337 also
  needs a cloud commit removing pipeline/handoff files + the compose boot zod check). #1271 F-03 scanner
  (`6840c6b45`) also SHIP W/N on its merge (Opus delta #938 5815062770), but the idempotency hole is
  REQUIRED before the Display PR: `ScanOrderScreen.tsx:320` must classify only real network/offline throws
  as `offline: true` (a post-commit throw must never re-queue and double a line's qty) + reset
  `lastAddResultRef.current` before flushSync + a red-first pin (S-scan lane).
- **NEW**: B562 PR-2 opened as #1358 (`cfb95f160`, stacked on PR-1 #1331) — tier-1 money, SA read pending;
  not landable until the SA rules on the B703 fold and PR-1 lands. It also filed a NEED-ID (#938
  5815145111): `VendorBillsService.revertToDraft` deletes stock-movement rows instead of appending a
  reversal (medium, audit trail) — lead to mint an id.
- Rulings landed: SA-151 (B692 shape) → Lane F, builds off the B785 branch. SA-144d: BLOCKS-FLIP down to
  12, in 3 remaining PRs — Returns B650+B754+B671 (Lane IR), B652 (B707 lane), Display B653+B757/758/759
  (S-scan, after #1271).
- Mac mini: RECOVERED from Colima, then a second scare — memory pressure hit level 4 ~13:40Z (15% RAM/
  15GB disk), mini-wide pause incl. F2; SAFE again ~13:55Z (disk 24GB, pressure 1). Rule going forward: ONE
  heavy job at a time, `JEST_MAX_WORKERS=2`. Salvage ALL 5 DONE: #1357, #1359, #1360 (b736-rebuild-
  coverage), #1361 (b803) open as draft PRs; #1362 (b805) pushed with UNRESOLVED conflicts (owner = B707
  lane after its own R1 queue); then full worktree cleanup (inventory → salvage PRs → remove), authorized
  by the owner. Mac Lead now pushing the registry branch + writing the mac-handoff.
- #1121 (B597, Order UI) CLEARED at `3f83b2327` (delta = master's note-comment wording only, display-only
  → one Opus pass enough); queued in the coordinator's W17 queue. Order UI moves on to #1189 (B669). F-22
  WP1 on the MacBook (`fe684c26`, unpushed). F-3 Plane Pages probe done (read-only; needs a pages endpoint
  added to plane-client.mjs before any writes).
- Owner actions: prod migrations (#1324 resolvedReason, #1331 B562 PR-1 before merge, #1337 policy PR-A),
  #1334 backfill after merge (checkout staged at `C:/ClaudeCode/rf-owner-reports`), B646 report (#1330,
  from the PR branch), #1246 dry run, D-17 T6 NOT NULL,
  F-10 console steps, D-34 decision, F-11 sign-off, D-03 test-credential path, D-19 flip last,
  `chore/workflow-redesign` (likely the off-limits Codex branch) disposition.

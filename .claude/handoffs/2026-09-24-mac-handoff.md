# Mac fleet handoff — 2026-09-24

Written by the outgoing Mac Lead ("RouteFlow Mac Lead coordination") ahead of the account/session
switch. Keep the SAME session titles below for the new sessions — the PC's
`.claude/handoffs/2026-09-24-fleet-handover.md` lists them. No client identifiers.

## Disk / Colima incident (resolved)

- Host disk hit ~119 MB free around 07:20Z, then bottomed at ~1.5 GB after a misread `df -g`
  column (mistook Used for Available — corrected in-session). Root cause: normal fleet activity
  (many active worktrees × `node_modules`, image builds, push verifies) with no headroom left.
- The Colima VM went unreachable during this (`colima status` → "empty value", `docker system df`
  → containerd blob I/O error) — the exact read-only-corruption risk our own memory notes warn
  about for a full host disk.
- **Recovery, in order, all done:**
  1. `npm run janitor` (report-only): **0 of ~50 worktrees eligible** — everything is either the
     main checkout, dirty, or its branch isn't merged into origin/master. No unattended reclaim
     available.
  2. Deleted `node_modules` (safe, npm-ci-recoverable) from **11 clearly-idle worktrees**,
     largest-first, stopping once free space passed the 25 GB target. Log:
     `local-assets/handoff/2026-09-24/node_modules-reclaim.log` (gitignored, local only — the
     GB figures are also in this file). **~23 GB reclaimed this way; zero worktrees removed, zero
     commits touched, zero branches deleted.**
  3. `colima stop --force` then `colima start` — came back clean, no I/O errors. **No VM
     recreation was needed**, so the Postgres data volume was never at risk.
  4. Redis (`routeflow_redis`, actually on the `routeflow-clean_redis_data` volume — note the
     name mismatch) was crash-looping on a corrupted AOF increment file
     (`appendonly.aof.1.incr.aof`, truncated mid-write during the disk-full window). The base RDB
     already had **0 keys loaded**, so nothing of value was in it. Cleared the AOF dir on the
     correct volume, restarted — healthy immediately.
- **Current state (as of this file): all 5 containers healthy** (api, web, mailpit, postgres,
  redis). Disk free: see the live host, was 26 GB right after recovery, then rising as pushes
  freed build caches.
- **Standing lesson for next time:** always use `df -h`, never `df -g` (its column order reads
  as Used where a skim expects Available — this session's own near-miss).

## Worktree cleanup (the owner's fuller ask)

**SALVAGE step done for the 5 branches that had no PR anywhere and real unpushed commits** (the
highest-risk ones — genuinely the only copy of that work). Each was checked for staleness first
(`git rev-list --count HEAD..origin/master`); 4 were 43-174 commits behind and needed
`npm ci` + `prisma generate` (stale node_modules/Prisma client, not a code issue) plus a
`git merge origin/master` before they'd push clean:

| Worktree                      | Branch                             | PR                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rf-lane-R-service-4           | feat/r-2b-template-call-site       | **#1357** (draft)                                         | 174 behind, merged clean, npm-ci fix for stale prisma client                                                                                                                                                                                                                                                                                                                                                                                                                              |
| rf-lane-R-ui-local-lane-note  | docs/local-lane-dotnext-trap       | **#1359** (draft)                                         | 57 behind; its old test copy reproduced an ALREADY-FIXED race (B742) — confirmed via diff against master before merging, no code touched                                                                                                                                                                                                                                                                                                                                                  |
| rf-lane-b736-rebuild-coverage | test/b736-rebuild-caller-coverage  | **#1360** (draft)                                         | 57 behind, merged clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| rf-lane-b803                  | fix/b803-redelivery-remainder-plan | **#1361** (draft)                                         | 54 behind, merged clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| rf-lane-b805                  | fix/b805-edit-items-update-draft   | **#1362** (draft) — **⚠ UNMERGED, CONFLICTS WITH MASTER** | 43 behind; `git merge origin/master` produced real content conflicts in `apps/mobile/__tests__/edit-items-draft.test.ts` and `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx` — resolving those is a product-code call, not something to freehand during a cleanup pass. Pushed AS-IS (original tip, unmerged) so the work isn't lost. **Owner (fleet lead ruling): the B707 lane, after its R1 queue (B824 proof → B652). It merges master and resolves both files then.** |

**Remaining, NOT done:** the other ~10 branches from the earlier survey table already had an
open or merged PR tracking that exact branch (nothing new to preserve there — see the table
below for which), and the full REMOVE step (unlink symlinks → delete node_modules →
`git worktree remove` without `--force` → `git worktree prune` → `git branch -d`, `-D` only on a
confirmed squash-merge) across the ~49 worktrees has **not been run** — this session ran out of
time after the SALVAGE step. The next Mac Lead should pick up REMOVE from the survey table below,
re-verifying each branch's PR/merge state is still current before deleting anything.
**Do not run `janitor --apply`** (B800 hazard: it can misclassify a fresh zero-commit branch as
merged).

A raw worktree survey (branch, ahead-count, dirty-file-count) taken during this handoff is below,
useful as the INVENTORY step's starting point:

```
rf-build-master | docs/file-b743-b745-purchase-cost-focus-docker | ahead=9 | dirty=0
rf-docs-lessons | docs/lessons-compaction-0923 | ahead=0 | dirty=0
rf-docs-sa | docs/sa-registers-0922 | ahead=13 | dirty=0
rf-lane-IR-b3-pack-guard | fix/b814-inline-return-quote-dto-require-split | ahead=? | dirty=0
rf-lane-IR-b660-resolution | fix/b660-parked-reversal-resolution | ahead=1 | dirty=0
rf-lane-IR-inline-returns-mobile | feat/inline-returns-mobile-mirror | ahead=0 | dirty=0
rf-lane-R-service-4 | feat/r-2b-template-call-site | ahead=2 | dirty=0
rf-lane-R-ui-b653-mobile | fix/b757-mobile-unit-label-sweep | NO-UPSTREAM | dirty=0
rf-lane-R-ui-b653 | fix/b795-adjust-double-add-item | ahead=23 | dirty=0
rf-lane-R-ui-b735 | fix/b735-parked-return-visibility | NO-UPSTREAM | dirty=0
rf-lane-R-ui-local-lane-note | docs/local-lane-dotnext-trap | ahead=3 | dirty=0
rf-lane-R-ui | feat/r-4-category-labels | ahead=2 | dirty=0
rf-lane-b556-b557-mrr | fix/b556-b557-mrr-plan-source-of-truth | ahead=1 | dirty=0 (likely stale — the real push for B556/557 was #1335 from elsewhere; verify before touching)
rf-lane-b649-merge-unitlabel | fix/b649-merge-unitlabel-v2 | ahead=2 | dirty=0 (superseded by #1332, likely mergeable/removable)
rf-lane-b650-returns-unit-label | fix/b650-returns-unit-label-qty | NO-UPSTREAM | dirty=0
rf-lane-b651-reorder-unitlabel | fix/b651-reorder-unitlabel-v2 | ahead=1 | dirty=0 (superseded by #1333)
rf-lane-b660-parked-return-reversal | fix/b660-parked-return-reversal-resolution | NO-UPSTREAM | dirty=0
rf-lane-b670-b701-pack-family | fix/b767-recompute-category-trio | NO-UPSTREAM | dirty=0 — ACTIVE, B707 lane
rf-lane-b679-tax-basis-sweep | fix/b679-tax-basis-sweep | ahead=0 | dirty=4 — ACTIVE, unit-line lane
rf-lane-b682-b683-pricing | fix/b682-b683-buildline-migration-pricing-comments | ahead=0 | dirty=0 (already #1341)
rf-lane-b707 | fix/b707-mobile-edit-items-line-pack | ahead=? | dirty=1
rf-lane-b718-unit-line-qty-zero | fix/b718-unit-line-qty-zero | ahead=1 | dirty=0 (already #1343)
rf-lane-b736-rebuild-coverage | test/b736-rebuild-caller-coverage | ahead=3 | dirty=0
rf-lane-b740-web-unit-label | fix/b740-web-unit-label | ahead=0 | dirty=0 (B740 turned out already-fixed by #1147 — likely USELESS, verify)
rf-lane-b747-resume-unitlabel | fix/b747-resume-unitlabel-v2 | ahead=1 | dirty=0 (already #1339)
rf-lane-b803 | fix/b803-redelivery-remainder-plan | ahead=2 | dirty=0
rf-lane-b805 | fix/b805-edit-items-update-draft | ahead=2 | dirty=0
rf-lane-b810-driver-amount-due-sent-partial | fix/b810-driver-amount-due-sent-partial | ahead=0 | dirty=92 — CHECK CAREFULLY, large dirty count, may be stale/leftover
rf-lane-b824-flaky-k3 | fix/b824-publish-repin-k3-flaky | ahead=1 | dirty=0 (already #1336)
rf-lane-driver-mode-1a | feat/driver-mode-1a | NO-UPSTREAM | dirty=0 — real work (B718 came from here originally, B740 too); check before removing
rf-lane-mobile-web-proxy-redesign | fix/mobile-web-proxy-redesign | ahead=? | dirty=1
```

Everything else not listed above showed `ahead=` blank (upstream ref present but `rev-list`
produced nothing useful — needs a live re-check, not trusted from this table) or a small ahead
count not yet triaged. Treat this table as a lead, not a verdict — SALVAGE decisions need each
branch's `gh pr list --head <branch> --state all` checked fresh.

## Lane status (mini + MacBook)

### Mac F2 prover — "RouteFlow Mac F2 prover"

DB-lane prover only, never writes product/test code. Currently proving whatever's next in queue.
**Blockers:** none. **Queue as of handoff:** #1310's chain (after Lane B's master-merge push,
requested, not yet landed) → #1324 → #1330 → the real-reconcile report (SA-130c, still owed).
#1352 (vendor-bills, B710) checked and found NOT ready (no `*.db.spec.ts` for SA-148's race yet).

### Lane B — "Snapshot restore and flag fixes"

Branch fix/b776-boxed-merge-pack-mismatch (worktree on the OTHER clone,
`~/code/routeflow-clean/.claude/worktrees/rf-lane-B-b5-boxed-merge`, not under
`routeflow/.claude/worktrees`). **PR #1310, HEAD 99dd72d5 at handoff — CONFLICTS with master**,
requested to merge (no rebase/force) and push; not confirmed done yet. **Next:** merge origin/master,
push, send F2 the full sha for the chain (a)–(h) re-proof.

### R-ui — "RouteFlow R-ui rule dialog follow-ups"

Several worktrees this session (rf-lane-b682-b683-pricing landed as #1341; current work is likely
B683/B687/D-20/D-21 per SA-144). **PR #1319, HEAD ada44436 at handoff — CONFLICTS with master**,
requested to merge and push; not confirmed done yet, then needs an Opus review of the merge-only
diff. **Next:** same merge+push, then continue B683 → B687 → D-20 → D-21 (verify D-21 first — may
already be satisfied by #1324/#1246's correctsEntryId writes).

### B707 lane — "RouteFlow Lane B707 mobile edit-items pack"

Worktree `rf-lane-b670-b701-pack-family`, branch fix/b767-recompute-category-trio.
**PRs landed: #1345 (B670/B701/B674), #1347 (B760).** Currently extracting
`recomputeOrderFromInvoices` out of invoices.service.ts (zero size-ratchet headroom, 9376/9376)
BEFORE wiring B767. **Blocker at handoff:** showed a "requires_action" permission prompt on the
mini — asked what it needs, no answer received yet. **Next:** whatever it's stuck on, then finish
the extraction, then B767, then B556+B557's `update-tenant-class-ledger.db.spec.ts` (still owed to
F2, queued after Release-1 items).

### Unit-line lane — "RouteFlow Lane web unit-line edit"

Worktree `rf-lane-b679-tax-basis-sweep`, branch fix/b679-tax-basis-sweep, **dirty=4 at handoff —
mid-edit, do not touch its node_modules or source**. **PRs landed: #1332 (B649, +SA-142 wording
fix at a follow-up commit), #1333 (B651), #1339 (B747), #1343 (B718).** B740 turned out
already-fixed (flip in registry: `docs(bugs): flip B740 already fixed by #1147`). **Current:**
B679, scope confirmed by SA-144b (4 real sites → one `regulatedUnitBasis` call, allowlist
shrinking) — code conversion reportedly done but **could not run `npm ci`/jest/tsc to prove it
during the disk outage; needs a fresh verify pass** before pushing. **Next after B679:** B652 →
D-04 → D-29 → B657 → D-05 (the D-rows are on the PC's `docs/roadmap-2026-09-23`, not on the mini
— pull that branch first).

### Lane IR — "RouteFlow Lane IR inline returns web"

Worktree likely `rf-lane-IR-b660-resolution` (fix/b660-parked-reversal-resolution, ahead=1) for
#1324 (B660 PR B / parked-reversal resolution). **Status at handoff:** was swapping
`withAdvisoryLock` for the Order-row `FOR UPDATE` lock per SA-089b, then queued for #1246 (B681
SA-134 rework + the shared correctness fixture) and B650 (stranded fix, cherry-pick-only from
`rf-lane-b650-returns-unit-label`, never landed). **Next:** confirm the lock swap is committed,
send F2 the sha for its db.spec + full lane + drift proof (adds a nullable `resolvedReason`
column), then #1246, then B650.

### Vendor-bills — "Extract and fix vendor-bills poTotal drift" (MacBook Pro, not the mini)

**PRs: #1340 PASS (gate = PC spec 61), #1344 PASS pending one wording-line fix (mobile prompt must
say "…in the web dashboard"), #1350 PASS, #1352 (B710) HOLD (SA-148) — needs a real-Postgres
`*.db.spec.ts` racing a fresh scan's first post against a re-post-after-void; confirmed NOT present
at 9a78c4ca by F2.** Also queued: B699+B722 push, B710 fix (drafted in scratchpad only), B746,
D-11, D-12.

### MacBook landing — "RouteFlow MacBook landing" (MacBook Pro)

**PRs landed: #1342 (Opus-5.5 routing, MacBook's own sweep), #1346 (B748), #1348 (D-24/D-26,
minted L-218/219/220 after a mini id-collision on L-215/216 — caught before push, cleanly
renumbered), #1349 (D-31/B686), #1351 (B843, the eslint prisma/** gap it found while on B686).**
**#1330 (B646, recurring boxed pieces) still needs its DB proof** — queued to F2 (no Postgres on
MacBook). **D-30/B685: resolved — option (b), widen db-migrations.yml's trigger to
apps/api/src/**, prisma/**, packages/**; L-219's gap closes by it.** **F-22 (tracking engine):**
full plan done (`.claude/pipeline/2026-09-24-f22-tracking-engine/` — context-pack, discovery,
spec, test-plan, build-plan; all 5 artifacts), 2 open findings — F-2 (test-budget mismatch,
resolved: inject zero backoff in the publish self-test) and **F-3 (does Plane Cloud's API even
expose Pages — genuinely unconfirmed, needs a real `PLANE_API_KEY` probe, assigned to the PC)**.
**Cleared to build WP1 now; WP2–4 wait on the F-3 probe result.**

## Bug registry state (as of this handoff)

Registry branch `docs/file-b743-b745-purchase-cost-focus-docker` on the mini, several commits
ahead of origin (push requested, see below). Notable this session: B667/B666 recovered from a
sibling unmerged branch instead of re-filed (would have duplicated); B702 closed (SA-144a); B679
rescoped from BLOCKS-FLIP to LIVE-NOW (SA-144b); B735 correctly held OPEN after its misleading
"cleared" note turned out to clear an unrelated finding, not itself; B840 filed (the `note
--section` silent-replace bug that caused a real incident this session, repaired via a
union-of-history rebuild, 0 losses independently verified); ids through **B843** minted; next free
id is **B844**. Full true open-bug counts (by severity, with owner assignments) were sent to the
fleet lead earlier in the session — see #938 and the fleet lead's own notes for the current
numbers, since several flips landed after that count.

## Docs branches — push status

- `docs/file-b743-b745-purchase-cost-focus-docker` (registry): push requested at handoff time,
  not yet confirmed landed on origin.
- `docs/sa-registers-0922` (SA rulings through SA-150): several commits ahead, push requested,
  not yet confirmed.
- `docs/lessons-compaction-0923` (lessons, incl. L-216): already on origin as of `e9fbb9e3`.
- `chore/opus-5-5-routing` (PR #1338): landed, but per the fleet lead this needs to be marked
  CLOSED — it renamed the price-table row in place rather than the shape the PC wants; pull the
  PC's own skills PR instead of redoing this one.

## Lane restart prompts used this session

For resuming a lane after a stop (adjust the specifics):

> Mac Lead: disk recovered (X GB free), Colima healthy. Resume <task>.

For granting a push slot:

> Mac Lead: **GO. Push <branch> @ <sha>**: normal hook, JEST_MAX_WORKERS=2, no force. Open the PR,
> send me PR number + sha.

For routing an SA finding:

> SA, from the Mac Lead: <finding, with file:line evidence>. Rule on <the specific question>.

Standing rule this whole session: **never approve two heavy `npm ci`/build/push operations at once
unless `kern.memorystatus_vm_pressure_level` ≤ 1 and free memory ≥ 40%** — this thrashed once
today (the disk-full episode) from a push verify overlapping an image build.

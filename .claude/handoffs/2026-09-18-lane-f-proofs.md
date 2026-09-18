# Handoff — 2026-09-18 · Lane F (proof runner)

## ▶ START HERE — do these in order, no confirmation needed

1. Run a clean `npm ci` BEFORE anything else — a previous sweep attempt failed because
   dependency folders had been moved between worktrees, leaving stale links. Do not conclude
   the sweep is broken until after a clean install.
2. The 390px WHOLE-SET regression — seven mobile fixes landed 2026-09-17 (overflow tables,
   touch-visible row actions, customer tab strip, two line-item rows, crop modal, planner
   bottom sheet) plus a marketing contrast sweep. Each was verified individually and NEVER as a
   set; one fix can undo another's assumption about container width. Write findings to
   `local-assets/proofs/2026-09-18/` PER SCREEN as you go, not in one pass at the end.
3. B523 — run the full verify chain against clean current master in a tree with a real jest
   run, then record a verdict WITH evidence. Do not treat "30 undischarged claims" as confirmed
   in either direction.
4. Tear the stack down when finished and confirm ports are free.

Existing deliberate test artifacts: `qa-msrp-proof` tenant, `sweepadmin` account.

Standing rules: do not merge or change repo visibility (the landing coordinator
does that). Push with SKIP_VERIFY=1 SKIP_VERIFY_REASON="…" if the local verify
chain is the blocker; never --no-verify. Ask the lead for any bug registry id —
B525 is taken, B526 is next free; never mint your own. Check free disk before any
full verify or build run (a full run filled the disk twice on 2026-09-17).
Approved test tenants only: test, e2e-routeflow, routeflow-demo, qa-*, e2e-*,
ux-audit-*. Never a live tenant.

Session: routeflow-51. Owned the dev server + compose slot for this stretch. Wind-down handoff —
fleet lead ending at high context, fresh lead takes over.

## UPDATE 2 (final) — 390px whole-set regression sweep NOT RUN. Stopped on explicit owner instruction before any screen was checked.

**Say this plainly so it isn't misread as "checked, fine": the sweep produced zero results.**
Not one screen was verified. Do not assume any of the seven mobile fixes hold as a set — that
question is exactly as open as it was before this session started on it.

**Why**: bringing the stack up for the sweep, my first attempt tried to save time by **moving**
`node_modules` from an already-installed worktree (`rf-deliveries-mobile-sheet`) into the new
`rf-sweep-390` worktree instead of running `npm ci` fresh — even though `package-lock.json` was
confirmed byte-identical between the two, so this looked safe. **It wasn't**: the moved
`node_modules` had stale workspace symlinks still pointing at the old worktree's absolute path
(visible in the web dev server's compile warnings — `packages/config/tailwind.config.ts` resolved
under `rf-deliveries-mobile-sheet`, not `rf-sweep-390`) and was missing at least one package
(`@hookform/resolvers/zod`, breaking `/login`) that should have been present per the lockfile.
**Lesson for whoever picks this up: a `node_modules` move between worktrees is not equivalent to
`npm ci`, even with an identical lockfile — the workspace symlinks (`@routeflow/*` → `packages/*`)
appear to carry absolute-path state on this machine. Always run a clean `npm ci` in a new
worktree; don't try to shortcut it by moving another worktree's install, however tempting given
the disk situation tonight.** (This is worth a `LESSONS.md` entry if the next session has time —
I didn't write one given the immediate stop-now instruction.)

After discovering that, I killed the broken dev servers, deleted the broken `node_modules`, and
started a clean `npm ci` in `rf-sweep-390` — it finished successfully (confirmed via the
background task's own completion notification) — but the owner called it for the night before I
restarted the servers or ran the (now-rewritten, screen-by-screen-persisting) sweep script.
**Nothing from the rewritten script ever executed.**

**Current state of `.claude/worktrees/rf-sweep-390`**: detached HEAD at origin/master (`56c01d2b`
as of this session), clean `node_modules` fully installed via `npm ci`, `apps/api/dist/` present
(copied from the old worktree earlier — matches the old branch, NOT rebuilt from current master;
rebuild with `nest build` before trusting it), `apps/api/.env.local` and `apps/web/.env.local`
present with local compose-matching throwaway values. The sweep script itself —
`local-assets/proofs/2026-09-18/regression-sweep-390/sweep.mjs` — writes `REPORT.md`/`report.json`
incrementally (one screen at a time) once run; it identifies the exact screens/files to check for
each of the seven fixes (customers/[id] = B510+B511+B512, invoices/[id] = B511, orders/[id]
view+edit, returns, vendor-bills = B513, products/[id] = B514, deliveries/new = planner sheet,
marketing home = B507 contrast sweep) — reuse it as-is, it just needs the stack up and a
`node dist/main.js` (or fresh `nest build` first) + `next dev -p 3001` to run against.

Left in place deliberately per the "skip disk reclaim, janitor handles it later" instruction: the
`rf-sweep-390` worktree and its `node_modules`/`dist`. Compose containers for it ARE torn down
(see below) — only the worktree files remain.

## Teardown confirmed (this session's slot)

- `rf-sweep-390`'s compose stack: `docker compose down` succeeded — `routeflow_postgres` and
  `routeflow_redis` containers + `rf-sweep-390_default` network all removed (confirmed via the
  command's own output and `docker ps` showing only the unrelated `buildx_buildkit_default`).
- Dev servers: both killed earlier (the broken ones, before the clean `npm ci`) and never
  restarted. Ports 3000/3001/5432 confirmed free via `Get-NetTCPConnection`.
- **One caveat, not a live service**: `Get-NetTCPConnection` still shows something listening on
  6379, owned by `wslrelay.exe` (Docker Desktop's WSL2 port-forward process) — but a direct TCP
  probe against it gets no response, and `docker ps` confirms no redis container exists. This
  reads as a stale WSL2 relay artifact left behind after `docker compose down`, not an actual
  running Redis. Flagging it rather than either hiding it or overstating it as a real leak — if it
  doesn't clear on its own, `wsl --shutdown` resets it (see the standing WSL-memory-cap note in
  memory) but that restarts every container on the machine, so don't do that lightly.

## State at handoff

- **No dev server or compose stack running.** Verified via `Get-NetTCPConnection`: ports
  3000/3001/5432/6379 all free. `docker ps` shows only `buildx_buildkit_default` (unrelated, not
  mine — leave it). Nothing for the next session to tear down from this lane.
- **Disk: ~8.5 GB free**, recovered from a ~3.5 GB low tonight (see "Disk incident" below).
- Worktree `.claude/worktrees/rf-deliveries-mobile-sheet` (`feat/deliveries-mobile-sheet`) is
  still around — its own PR (#854) is closed-not-merged because the same feature landed as
  **[#888](https://github.com/najathakram/routeflow/pull/888)** (a "[v2]") instead. That worktree
  is stale/superseded; safe to strip or remove later, nothing pending in it.

## B523 — UNRESOLVED. Two independent attempts, both blocked by disk pressure. Do not treat as settled either way.

**Question**: is the campaign-check failure ("30 undischarged bug-registry claims", first seen
pushing from PR #871's branch) a genuine repo-wide gate break, or an artifact of that branch's
environment?

**What's established so far** (from the existing `B523.md`, filed by an earlier session in
`.claude/worktrees/rf-B523-file` — I did not edit that file; it's not my worktree):
- 2 spot-checked ids (B128, B34) have byte-identical registry-shard content between PR #871's
  branch and master, and their `REG-B###` test titles genuinely exist in
  `apps/mobile/__tests__/*.test.ts` on master. So it's not a simple content-divergence or a
  flat-out-missing-test explanation for those 2.
- A quick campaign-check run against master **without a prior jest pass** does NOT reproduce the
  30-claim failure — it fails differently (missing `.campaign/runs/*.json` report files, since
  nothing had generated them yet in that worktree). That's expected/uninformative on its own
  (campaign-check's freshness check is designed to refuse a missing/stale report) and does not
  answer the real question either way.

**My attempt this session**: created a fresh worktree (`rf-b523-verify`, detached at
`origin/master` 56c01d2b), ran `npm ci` (completed cleanly). Before I could run
`npx turbo run test --force` (real 4-workspace jest pass, feeding fresh `.campaign/runs/*.json`)
followed by `node scripts/campaign-check.mjs` — the actual test that would settle this — the
fleet-wide disk crisis hit (see below) and I had to abort, kill the run, and delete the whole
worktree to help reclaim space. **No verdict reached.**

**Net effect**: this is now the *second* attempt specifically blocked by disk pressure before
producing a real answer. That's a pattern, not bad luck — completing this needs a window with
real disk headroom (10GB+ sustained through a full `turbo run test --force` across
api/mobile/pricing/web), ideally when no other lane is mid-build. Whoever picks this up next:
don't squeeze it in alongside other heavy work tonight; give it a clean slot.

**Do NOT act on the "30 claims" as confirmed fleet-wide breakage** until someone actually
completes that run — the original report already over-generalized once from an unverified
assumption; a second unverified assumption sitting in the registry as fact is worse than the
open question staying open.

## Disk incident (mid-session, fleet-wide)

Free space dropped from ~7.5 GB to ~3.5 GB while my `npm ci` was running in `rf-b523-verify` —
alongside what looked like at least one other session's concurrent npm/build activity (saw a
second `npm ci --prefer-offline` process that wasn't mine). Actions taken, in order:
1. Killed my `npm ci` process and its child immediately.
2. Deleted the `rf-b523-verify` worktree entirely (`git worktree remove` hung/failed on a file
   lock; finished it with a direct `Remove-Item -Recurse -Force` after confirming it was my own,
   freshly-created, nothing-of-value-in-it worktree).
3. `npm cache clean --force`.
4. `docker builder prune -f` — was already at 0B, no gain.
5. Cleared `~/AppData/Local/Temp/jest` (0.19 GB transform cache from tonight's various runs).
- Did **not** strip `node_modules` from any other worktree — there are ~48 worktrees on this
  machine right now and I did not have time under the wind-down window to safely verify
  merged-status + no-live-session-claim for any of them. That's real reclaimable space still
  sitting there if someone has time to check it properly (the lead's own caution applies: "we
  nearly deleted a live session's worktree tonight" — verify both conditions before touching
  another lane's tree).
- `npm run janitor` doesn't exist in the checkout I was on (`C:/ClaudeCode/routeflow` main
  checkout, currently behind origin/master) — it's landed on `origin/master`
  (`scripts/janitor.mjs`, confirmed via `git show`) but the main checkout hasn't been updated to
  pick it up. It also has ~31 uncommitted modified bug-registry files from another session's
  in-progress work — **do not `git pull`/reset/checkout there**, it'll clobber that work.
- Result: 3.5 GB → ~8.5 GB free by the time of this handoff.

## The 390px whole-set regression pass — NOT RUN. Top unrun check.

Lead's Lane F task 2 ("once the other lanes' PRs land: 390px across the six dashboard detail
screens plus the marketing pages, confirming tonight's seven mobile fixes hold together") never
started — it was gated on other lanes landing, and the wind-down + disk incident hit before I got
there. **Flagging explicitly per the lead's own framing**: tonight's seven mobile fixes were each
verified individually, never as a set, and the column-grid/tap-target work that landed after them
touches the same screens. This is real, un-covered risk — next session should run it before
assuming those fixes still compose cleanly.

## Proof artifacts already produced this session (evidence for work already landed — point here, don't re-derive)

All under `local-assets/proofs/2026-09-17/` in the `rf-deliveries-mobile-sheet` worktree:
- **`planner-sheet/`** — #854's mobile bottom-sheet proof (18 screenshots, 390/768/1440 ×
  half/full/peek/dragging/after-map-tap + reduced-motion variants), plus `PROOF.md` explaining the
  one e2e failure (desktop-vs-mobile Build CTA visibility difference, confirmed genuine via DOM
  geometry, not a clipping artifact).
- **`regression-sweep-390/`** — 6-item regression sweep (admin-login mobile UA, platform-admin
  sidebar, buyer portal sidebar, orders date filter, create-order scan button, marketing
  reveal+contrast), all 6 passing on the corrected run.
- **`msrp-proof/`** — full MSRP/sales_agents Feature Console grant-and-verify flow (screenshots +
  network-call capture), plus the CropModal (#883/B514) touch-drag diagnostics: confirmed the
  crop-phase resize handles were unreachable at 390px due to a fixed 640px `maxWidth` (not a
  touch-action/Pointer-Events defect — that conversion works correctly), and confirmed
  focal-point dragging works via real CDP touch. **#883 has since merged with exactly this fix**
  (`maxWidth: "min(640px, 90vw)"`, verified on master) — nothing further needed there.
- **`order-edit-check/`** — orders edit-mode line-item row at 390px with a long custom item name.
  Verdict: does NOT overflow the page (flexbox, `flex-1 min-w-0`, unlike B513's rigid grid — not
  a twin of B513), but DOES have a real, different bug: the item-name `<input>` collapses to
  ~16-18px wide (vs. its 738px content width) because Qty/price/action-button columns hold fixed
  size and never yield. Name becomes functionally unreadable during edit. Worth a ticket, not a
  close.

## Standing test artifacts — left in place deliberately, not cleanup debt

- **`qa-msrp-proof`** tenant (self-service-registered, admin user `qaadmin`/`QaAdmin@123`,
  activated via direct `UPDATE "User" SET status='ACTIVE'` since local SMTP doesn't send
  verification email) — used for the MSRP/sales_agents addon-grant proof chain above.
- **`sweepadmin`** super-admin account (created via `apps/api/scripts/create-super-admin.js`) —
  used to drive the Feature Console in that same proof.

Both are legitimate `qa-*`-policy artifacts. Re-proving that grant chain from scratch later costs
more than leaving these in place costs in cleanliness — keep them, but now someone besides me
knows they exist.

## One-line status

Lane F queue closed: proof runner tasks done (artifacts above), B514 confirmed fixed on master,
disk crisis handled (3.5→8.5GB free, dev server/compose torn down and verified clear); B523
verdict NOT reached (second blocked attempt, needs a dedicated disk-safe window); 390px
whole-set regression NOT run — flagged as the top open risk.

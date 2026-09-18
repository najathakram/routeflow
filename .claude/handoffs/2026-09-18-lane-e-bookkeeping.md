# Handoff — 2026-09-18 · Lane E bookkeeping (window-3)

## ▶ START HERE — do these in order, no confirmation needed

1. FIRST: run `git -C C:/ClaudeCode/routeflow status --porcelain -- .claude/campaign/bugs/`.
   If files show modified, a bare `bugs.mjs enrich` has damaged them again — restore with
   `git -C C:/ClaudeCode/routeflow checkout -- .claude/campaign/bugs/`. (This happened
   2026-09-17: 231 files, +54/-1038, sections deleted and history re-dated. Already reverted
   once.)
2. Check whether PR #901 landed; rebase if needed.
3. Work the unrecorded-PR list already in this file, by number. Trust that list over any
   assumption the record is complete.
4. Verify every landing sha with `gh pr view <n> --json mergeCommit` then ancestry against FULL
   history — never the branch tip; several PRs landed as rebases/cherry-picks under new
   numbers.
5. Lessons register is near cap (49/52) — archive the least-cited fully-guarded entry before
   adding; never trim a live one.

Standing rules: do not merge or change repo visibility (the landing coordinator
does that). Push with SKIP_VERIFY=1 SKIP_VERIFY_REASON="…" if the local verify
chain is the blocker; never --no-verify. Ask the lead for any bug registry id —
B525 is taken, B526 is next free; never mint your own. Check free disk before any
full verify or build run (a full run filled the disk twice on 2026-09-17).
Approved test tenants only: test, e2e-routeflow, routeflow-demo, qa-*, e2e-*,
ux-audit-*. Never a live tenant.

**Status: PR pushed, NOT merged. Session ending on credit exhaustion.**

- Branch `docs/bookkeeping-batch-2026-09-18` @ `9b12f532`, worktree
  `C:\ClaudeCode\rf-bookkeeping-batch`. Tree confirmed clean (`git status --short` empty).
- PR: https://github.com/najathakram/routeflow/pull/901 (docs-only, `SKIP_VERIFY` audited).
  **Not merged.** The landing coordinator seat is currently **vacant** — whoever picks it up
  next lands #901 in the batch window.

## Incident: `bugs.mjs enrich` run bare from the main checkout is destructive

A session accidentally ran `bugs.mjs enrich` with no args directly in the MAIN checkout
(`C:\ClaudeCode\routeflow`, not a worktree). It did not backfill harmlessly — `git diff
--stat` on `.claude/campaign/bugs/` showed **231 files, +54/−1038**, deletion-heavy. Sample
(`B97.md`): every stub section (Summary / What this feature is for / Root cause / User
impact / Fix approach / Test plan) deleted outright, and the History section's original
`filed`/`batched`/`done` lines (dated 2026-09-02) collapsed into a single re-dated `done`
line with a different HTML-comment anchor. This was caught, verified against `git diff`
before acting (confirmed nothing was staged — HEAD already held the clean version, so
`git checkout -- .claude/campaign/bugs/` restored it losslessly), and reverted.

**Lesson for the register:** `bugs.mjs enrich` (bare, no args) is destructive to EXISTING
records when run outside a worktree — it rewrites History entries and drops stub sections
rather than only backfilling blanks. Never run it directly in the main checkout; run it in
a dedicated worktree, and always check `git diff --stat` before committing anything it
touches. Worth a `_meta.json`/`LESSONS.md` entry once the register has headroom (see the
near-full-register note below) — this session didn't mint it directly since the damage was
still being reverted at wind-down and the register is already at practical capacity.

## What's recorded (this PR + earlier-landed #879/#894)

Registry closures: B510→B526, B511→B527, B512→B528, B513→B529, B514→B530, B508→B531,
B518→B532 (all retroactively filed, since their commit-message ids B510-514/B508/B518
were never centrally allocated), B318, B320, B406, B521, B522. Code map: B513/B514/B521
(the two C2 390px stragglers window-2 missed, plus CropModal), B318/B406 (credit-note
guards), the B519 correction (see below). Lessons: L-199, L-200.

## What's still UNRECORDED — by PR number

I did not get to (or deliberately skipped) verifying/documenting these from the lead's
original ~20-landing list:

- **#882** (`test(web): fix MOBILE-02's ambiguous "Orders" heading locator (B506)`) — a pure
  test-locator fix. Not code-mapped; judged low-value (self-evident from the test's own
  diff) but not independently confirmed against the B506 record (B506 is already
  already-fixed/closed from an EARLIER batch — this PR may just be a test-hygiene follow-up
  on top, worth a 30-second check before assuming it's covered).
- **B519** — deliberately left OPEN, not a gap: the AVAILABLE_ADDONS toggle removal (#866,
  #890) does NOT close it. `EnableAddonModal.tsx`'s "Enable as add-on" action has the exact
  same missing `driver_payments` dependency check and was never touched. Needs a REAL fix
  in `EnableAddonModal.tsx`, not a bookkeeping closure.
- **B520** — filed via #892, correctly left open/uncampaigned (a filing, not a fix). No gap.
- **B523** — filing PR **#896 is still OPEN, unmerged**. Do not close or code-map anything
  for B523 until #896 actually merges — verify with `gh pr view 896 --json state,mergeCommit`
  before trusting anything about it.
- **B443** — its fix commit `9b6f393b` ("label a CREDIT_NOTE payment row with its credit
  note") was **never actually merged**, despite PR #876's own body/description explicitly
  claiming B443 was included. Confirmed via `git grep -l linkedCreditNoteNumber` against
  `origin/master` — zero hits. `#876`'s ACTUAL merge commit (`21389a90`) only ever contained
  2 commits (B318, B406) per `gh pr view 876 --json commits`. B443's record stays
  `uncampaigned` (accurate) — do NOT close it, and do not trust #876's PR description over
  its actual commit list again.
- **B524, B525** — the lead allocated these live, mid-session, to two specific bugs I have
  no content for: **B524 = server-side `requires` enforcement in both enable paths**,
  **B525 = remove the now-dead `AddonsTab` / empty `AVAILABLE_ADDONS`**. I have NOT filed
  either — whichever session owns that work needs to file them for real (I only avoided
  colliding with the reserved numbers).

## Id allocation state (CRITICAL — read before filing anything)

As of this session's last message from the lead: **B524 and B525 are taken** (see above),
**B526 is next free** — but this PR's own commit ALSO consumed B526-B532 (7 filings), so
**the true next free id after this PR merges is B533**. Re-confirm with the lead before
any further filing — id allocation broke down TWICE this session (see below) because a
local worktree's "next free" scan can't see ids a concurrent session is allocating live.

**Root cause worth carrying forward:** `bugs.mjs file` with no `--id` computes "next free"
from THIS WORKTREE's own local max-id scan. That scan cannot see (a) ids centrally
allocated by a concurrent session that haven't landed in this worktree yet, or (b) ids
referenced by an unmerged, not-yet-visible PR (B523's open PR #896 is exactly this case).
**Always pass an explicit `--id` confirmed against the lead's live allocation state** when
more than one session might be bookkeeping concurrently — never let `bugs.mjs` pick.

## Sha-verification method (rule, not judgment call)

`gh pr view <n> --json mergeCommit` for the landing commit, THEN `git merge-base
--is-ancestor <that sha> origin/master` on FULL, UNSHALLOWED history — never the branch
tip's own commit. At least six of tonight's PRs landed under new numbers via rebase or
cherry-pick (#854→#888, #866→#890, #873→#879, #875→#880, #886→#892, #893→#895) and
branch-tip ancestry gives a confident WRONG answer on every one of them (see L-197).
A shallow clone can also misreport — `git fetch --unshallow` before trusting a `false`
result from `merge-base --is-ancestor`.

## Lessons cap — near-full, read before minting

Register is now **50/52 entries, 63.1/64.0 KB** — effectively byte-capped even though the
entry-count cap has 2 slots left (`validate-lessons.mjs --digest` prints: "caps disagree:
52 entries at 1.26 KB each is ~66 KB, over the 64.0 KB cap — so size really permits ~50
entries and the entry cap is unreachable. Owner decision: which constraint is load-bearing?").
**This needs an owner ruling, not another session's guess** — don't just archive more and
hope; flag it up before the next lesson mint hits a wall.

**Next archive candidate:** L-081 (2026-09-06, domain — gate a money write inside the
primitive that performs it) is the textbook pick by the compaction rule (real hard guard:
REG-B67/REG-B66 in `credit-notes.wallet-integrity.spec.ts`, zero live citations found in
code-map) — **but the auto-mode classifier has now blocked editing/removing it TWICE across
two separate sessions tonight**, apparently reacting to removing wallet/money-related
content from LESSONS.md. Whoever handles the next archive: try L-081 once; if blocked
again, don't keep retrying — fall back to the next-oldest uncited entry instead (this
session used L-105 and L-103, both now gone).

## Verified NOT to touch

- Sessions on marketing/dashboard/platform-admin/api lanes were told to leave the registry
  and lessons to Lane E tonight — no other-lane commits observed touching `.claude/**`
  during this session. If that changes, tell the lead.

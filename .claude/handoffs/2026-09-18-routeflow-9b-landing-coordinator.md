# Handoff — 2026-09-18 · routeflow-9b landing coordinator

- Task: independent-review + land RouteFlow PRs for the "Routeflow Lead" peer session, execute
  the canonical public→push/CI→merge→private deploy flow, report merge shas precisely.
- State: windows 1-3 fully landed and deployed. Handing off BEFORE window 4 (owner-requested,
  fatigue-risk judgment call on a long landing/merge session — lead offered explicitly, "either
  answer is fine").
- Master @ `56c01d2b` (window 3's last commit, B522). Repo visibility: **PRIVATE** (confirmed).
  Disk: ~7.75GB free at handoff (lead's own number, consistent).
- Decided:
  - Window 2 (13 PRs incl. rebases) + window 3 (#895/B522) all landed, deployed, post-deploy-check
    green each time.
  - Minted **L-198** (`gh run rerun` replays the original trigger-time checkout, never
    recomputes the merge-ref — push a new commit instead; cost 5+ branches before diagnosed).
  - Code-map bookkeeping caught up through #894 + the demo-booking admin-notification mechanism
    (`api/feature-modules-7.md`, B518/B522).
  - CI billing is broken by owner choice — **public-window-per-batch is the standing workaround**
    (see MEMORY.md `project_gh_actions_billing_block_2026-09-18` /
    `feedback_ci_public_window_batching_2026-09-17`): CI only runs while the repo is public: batch
    every ready PR into ONE public window, then flip private. A visibility-watchdog (45 min,
    `scripts/visibility-watchdog.mjs`) auto-flips private on a deadline regardless of session
    state — that's correct behavior, not a bug, if a window runs long; restart it deliberately for
    a fresh window rather than relying on the old one.
- Next (window 4, per the lead — do NOT start until the lead signals enough PRs have landed):
  - **Lane A** — scroll-reveal (B520) investigation, cache headers (A6), nav consistency (A7): up
    to 3 PRs.
  - **Lane B** — add-on dependency enforcement (B519).
  - **Lane C** — column grids (B516) then tap-target minimums (B517): **2 PRs, SAME FILES,
    sequential — B516 first, B517 rebased onto it.**
  - **Lane D** — remaining stale-cache items + settling B442.
  - **Lane E** — bookkeeping for ~20 landings. **Lands LAST** (collides on the registry append,
    same as every other docs-only PR tonight).
  - **Lane F** — reproduce B523, then a whole-set 390px regression pass.
  - Standard landing pattern all night: `git merge-tree <merge-base> origin/master
    origin/<branch>` first; a single-line-append collision on `.claude/campaign/bugs.jsonl` (two
    PRs' filed rows landing near the same insertion point) is the routine, safe-to-hand-resolve
    case — keep both entries in sequence, no markers left, verify the `.md` filing is
    byte-identical to the original branch, run `bugs.mjs sync --check` (shrink=0 is the gate).
  - Verify every PR independently before trusting its body — ids/shas from command output only,
    never assumed (this cost nothing tonight but is the standing rule).
- Open for owner: B518's mailbox question is RESOLVED (owner confirmed `hello@routeflow.info`
  exists and the booker path was never broken — B522 was the real completion). #871 (marketing
  copy rewrite) is CI-green-capable but **held for the owner's own content review** — do not land
  it even if CI passes; just don't let it rot red if it flips back red for some other reason.
- Do not: touch `rf-C2C3-detail-audit` (uncommitted Lane C work from an ended session — leave
  alone). Do not retry deleting `rf-893-land`'s worktree dir — lead confirmed harmless, leave it.
  Do not flip visibility public without a fresh watchdog started first. Do not trust `gh run
  rerun` to pick up a base-branch fix — push a real commit (see L-198).

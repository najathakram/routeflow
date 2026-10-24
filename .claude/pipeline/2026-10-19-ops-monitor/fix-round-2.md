# Fix round 2: Opus re-review FAIL (3 MUST + 5 SHOULD + 7 NIT), designs by the planner

Base 046d7e3f4 plus uncommitted planner edits (an ALREADY FIXED note closes a bug, in collector.mjs; the alarm drill-down and null-pill fix in public/app.js). Same rules as round 1: every fix gets a test that FAILS on the current code first (paste the red line); node only, never python; no commits; run only your own test files with `--test-concurrency=1`; never touch ~/.routeflow/ops.

## H1: hooks (MUST 2, SHOULD 4 hook half, SHOULD 8, NIT 10, NIT 11)
Files: `.claude/hooks/{ops-post-push,ops-post-plan,ops-stop}.mjs`, `tools/ops-monitor/test/{hooks,hooks-sync}.test.mjs`.
- **MUST 2: gh merge.**
  - Without a TTY, `gh pr merge` prints NOTHING on success; on a TTY it prints `✓ Squashed and merged pull request owner/repo#N (title)`.
  - New rule:
    - for `merge`, record a *candidate* `{ kind: "pr", action: "merge", number: <first numeric arg or a /pull/N URL arg, else null>, verify: true }` whenever the tool call was not interrupted and stdout+stderr has no `/^(GraphQL|HTTP \d{3}|error|failed|X )/im` and no "not mergeable", "--auto" or "auto-merge";
    - the DETACHED recorder confirms with `gh pr view <n | (none: current branch)> --json number,state,mergedAt,headRefName` and records the `pr` event (and appends the action line, with the confirmed number) only when `state === "MERGED"`;
    - the synchronous part does no gh call.
  - Keep `MERGED_RE` as a fast path, widened to `pull request (?:[\w.-]+\/[\w.-]+)?#(\d+)`.
  - Replace the made-up fixtures with real shapes: non-TTY empty output, and the TTY line with `owner/repo#N`.
- **SHOULD 4 (hook half).** Pass `--branch <HEAD>` on a pr event ONLY when the gh command named no PR (no number or URL argument).
- **SHOULD 8.** `plan-change` excludes `register/WORK-REGISTER.md` and `priorities/OWNER-QUEUE.md` while the specs `ops/config.json` `registerMode` is not `"generated"` (read the file, fail open = exclude). In human mode those hand edits ARE the record; the register sync turns them into events.
- **NIT 10.** A push with `--tags`, `--all`, `--mirror`, `--prune`, `--follow-tags` only, or a tag refspec records nothing.
- **NIT 11.** The Stop gate does not require an item link for branches matching `^(train|docs\/bookkeeping|chore\/bookkeeping)[/-]` (routine landing branches); the push is still recorded.

## H2: lanes + fold (MUST 1, SHOULD 4 fold half, NIT 12)
Files: `tools/ops-monitor/lib/{lanes-local,fold}.mjs`, `tools/ops-monitor/bin/rf.mjs` (whoami/default-lane paths only), `tools/ops-monitor/test/{brief,fold,cli}.test.mjs`.
- **MUST 1.** `laneForCwd` inherits a lane only from the cwd's OWN checkout root: walk up from cwd to the nearest directory containing `.git` (a dir or a file; fs only, no git call) and match only an entry equal to that root (or, if there's no `.git` up the tree, the old prefix rule). A nested worktree under `.claude/worktrees/*` therefore never inherits the parent's lane.
  - Test: root=lead plus an unregistered `<root>/.claude/worktrees/wt2` (which has its own `.git` file) → null; `<root>/apps/web` → lead.
  - Update the existing test at brief.test.mjs ~418 that pinned the old behaviour.
- **SHOULD 4 (fold half).** A `pr` event links to `ev.item` ‖ the item that already owns that PR number in `links.prs` ‖ only then `findByBranch(data.branch)`.
- **NIT 12.** An unparseable event line gets `ts` = noon UTC of the date in its file name (`events/<m>/<YYYY-MM-DD>.jsonl`), so it ages to "historical" like any anomaly.

## H3: snapshot + reconcile (MUST 3, SHOULD 5, the ALREADY FIXED proof)
Files: `tools/ops-monitor/lib/{snapshot,reconcile}.mjs`, `tools/ops-monitor/public/app.js` (bugs panel addition only), `tools/ops-monitor/test/{snapshot,reconcile}.test.mjs`, `tools/ops-monitor/test/fixtures/snapshot-sample.json`.
- **MUST 3: train-landed fixes.** A PR whose base is not master but equals the head branch of a MERGED master PR (a merge-commit train) counts as merged at that train PR's `mergedAt` (deployed check against the same deploy cut). Apply the same rule in:
  - the bug fix-state (`merged`/`deployed`, `prUrl` = the member PR, plus `via: <train PR number>`);
  - `mergedNaming` (bug-fixed-still-open);
  - `status-behind-merge`.
  - Test: member PR #9001 (base `train/x`, title "fix B9001"), train PR #9002 (head `train/x`, base master, merged) → bug B9001 fix `merged` via 9002, and the drift fires when the registry says open.
- **SHOULD 5.** `lane-silent` uses the lane's `lastActivityAt` (events, commits, handoffs) that snapshot already computes. Pass it into reconcile (`laneActivity: Map<lane, ms>`), falling back to the last event.
- **ALREADY FIXED proof (lead request).** The collector now marks bugs with an `ALREADY FIXED … PR #n (sha)` body note as closed (`alreadyFixed: {pr, sha}`).
  - Snapshot adds `bugsFixedByNote: [{ id, title, severity, pr, sha }]` (closed-by-note bugs, max 50, newest PR first).
  - The bugs panel shows a collapsed "Fixed, registry close owed (N)" list with the PR link, explaining that bugs.mjs has no close verb yet (register row 642).

## H4: store / sync / views (SHOULD 6, SHOULD 7, NIT 9, NIT 13, NIT 14, NIT 15)
Files: `tools/ops-monitor/lib/{store,sync,views}.mjs`, `tools/ops-monitor/test/{store,sync,views}.test.mjs`, `tools/ops-monitor/test/fixtures/register.md`.
- **SHOULD 6.** `syncSpecs` reads `ops/config.json` `registerMode` itself. In generated mode it always drops an unpushed views-only tip before pulling (`dropViewsTip`), then regenerates and commits after the pull (the same `afterCommit` path), so a caller that passes no `afterCommit` (collector, `rf brief --refresh`, sync) can never wedge the clone.
  - Test: a leftover views tip plus a remote change → a plain `syncSpecs` lands cleanly with a fresh register.
- **SHOULD 7.** The board-item drop applies only to items whose `item.new` came from the backfill board import: actor `backfill` AND tag `problem` | `owner-ask`. Fold already keeps `createdBy` or the source; if not, add `item.createdBy = ev.actor` in sync's own state read, without changing fold's exports. A lane's later item with those tags is never touched; a revived board item (status changed by a human after the drop) is not re-dropped (drop only if never dropped before).
- **NIT 9.** In `reconcileUnpushed`, an `item.new` with `source: "register"` (fields.source) that collides with an existing id is DROPPED (the other machine already created that row), not renumbered.
- **NIT 13.** Stale-lock reclaim: after renaming the stale lock to trash, read the trashed `owner.json`. If its token differs from the one judged stale, rename it back and retry the wait.
- **NIT 14.** `writeViews` commits through the same `runCommit` helper as events (identity/gpgsign fallback). On a failed commit it runs `git reset -q -- <the view paths>` and `git checkout -- <paths>`, leaving the tree clean.
- **NIT 15.** `test/fixtures/register.md`: replace the real-looking sha `5caf64725` and the phrase "R2 billing guards" with acme placeholders. Keep the backfill/sync tests passing.

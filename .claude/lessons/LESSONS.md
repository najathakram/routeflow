# Lessons Learned — RouteFlow

> Generalizable rules this project has paid for. **Read this at the start of every major task,
> implementation, or bug fix** (alongside the code map) and cite entry ids when one changes your
> approach. **After every bug fix, append an entry** — Symptom / Root cause / **Lesson** / Guard —
> and bump [`_meta.json`](_meta.json); Gate 3 of [`../hooks/stop.mjs`](../hooks/stop.mjs) blocks
> fix-shaped turns that don't (a lesson-free fix bumps `_meta.json.updatedAt` to acknowledge).
> Caps: ≤ 52 active entries / 64 KB (set in [`_meta.json`](_meta.json), enforced by
> `scripts/validate-lessons.mjs`) — compact to [`ARCHIVE.md`](ARCHIVE.md). Maintained by the
> `lessons-learned` skill. Blameless; **never client names/slugs/document numbers** — the repo
> goes public briefly for CI.

## process

### L-294 · 2026-10-11 · process · a review lists every writer of a row shape before it calls that shape anomalous

- **Symptom:** a review flagged a stored row shape as an anomaly, when another legitimate writer produces exactly that shape.
- **Root cause:** the reviewer counted only the writers it had read; a row shape is only anomalous relative to ALL the code paths that can write it (create, update, import, backfill, replay), and the finding never listed them.
- **Lesson:** **Before calling a stored shape anomalous, search for every writer of that row (create, update, import, backfill, cron, replay) and list them in the finding. A shape one of them legitimately produces is not an anomaly; if none does, name the one that must have.**
- **Guard:** none automatic; the review checklist. Cf. [[L-223]] (a sweep covers every emit site, not the named ones).

### L-290 · 2026-10-10 · process · a train member that is red on its own branch does not enter the train: read each member's own latest CI before merging it

- **Symptom:** a member whose own branch had a red database spec was merged into Train 3 and had to be ejected after the train was assembled, costing a revert on the tip.
- **Root cause:** the train gate read the local checks and the assembled tip, never each member's own latest CI run on its head sha, so a red member only showed up once it was already in; the abandoned approach was "assemble first, find the reds on the tip".
- **Lesson:** **Before a member is merged into a train, read that member's own latest CI result for its exact head sha. Red, missing or stale means it does not enter, whatever the local checks said; the tip's CI is the second check, not the first.**
- **Guard:** none automatic; train assembly reads each member's own latest CI (all jobs, not just Verify) and runs its changed specs before merging it. Cf. [[L-288]].

### L-289 · 2026-10-09 · process · a lead decides within its own authority when the owner is away; it never parks a train on an absent owner's reply

- **Symptom:** work idled behind a question that only the owner could answer, while the owner was not reachable and everything else was ready.
- **Root cause:** the decision was treated as the owner's by default, so a reversible, in-scope call waited on a reply that was not coming; the abandoned approach was "ask, then hold everything until answered".
- **Lesson:** **Before holding work for the owner, ask whether the call is reversible and inside the authority already delegated. If so, decide, write the reason on the board, and keep moving. Only an irreversible or outward-facing action (prod writes, repo visibility, spend, a bypass of a standing gate) waits, and it waits as ONE queued ask with a default, while every unrelated item keeps flowing.**
- **Guard:** none automatic; the lead's operating notes and the lane rules. Cf. [[L-253]] (a public window closes on state, never on a reply).

### L-288 · 2026-10-09 · process · use one merge strategy end to end: trains merge to master with a MERGE COMMIT, so stacked and train-based branches stay ancestors of master

- **Symptom:** a branch built on a train tip looked 256 commits ahead of master after that train was squash-merged, and merging it would have reverted four later fixes; the same shape threatened a second branch built on an earlier sitting.
- **Root cause:** members were squashed or rebased while the train itself was squashed, so no branch built on a train tip could ever be an ancestor of the landed master; a mixed strategy made "is this merged?" unanswerable ([[L-197]], [[L-268]]).
- **Lesson:** **Land a train with a merge commit (no squash, no rebase) so every member and every branch stacked on a train tip remains an ancestor of master. Before opening a PR for a branch built on any train, sitting or stacked base, run `git merge-base --is-ancestor <base> origin/master`; if it fails, cherry-pick the branch's own commits onto fresh master and prove `git diff origin/master...HEAD` lists only the PR's files.**
- **Guard:** none automatic; the landing checklist's empty-diff proof (the file set of the two-dot and three-dot diffs against master must be identical). Supersedes the rebase-merge rule of [[L-268]].

### L-287 · 2026-10-09 · process · never put a full local test gate on a train push that GitHub CI tests again; pre-flight takes seconds

- **Symptom:** train and branch pushes sat for many minutes behind a full local verify plus the database lane, on a shared box already at its load cap, and then GitHub CI ran the same suites a second time.
- **Root cause:** the local pre-push gate was designed when CI minutes were scarce, so it re-proves everything; on a train that CI tests anyway it is duplicate work, and it also queues every other lane behind the one push ([[L-283]]).
- **Lesson:** **For a train push whose members were each verified and whose tip CI will test, do the seconds-long pre-flight only (`npm run lint:migrations`, `split-prisma-schema.mjs --check`, the fail-fast guards) and let CI in the window be the gate. Do not add FULL_VERIFY or the database lane to such a push. Bypassing the pre-push hook is still an owner decision (an audited SKIP_VERIFY), never a lane's.**
- **Guard:** none automatic; the lead's lane rules and the audited `SKIP_VERIFY_REASON` line in `.git/skip-verify.log`.

### L-284 · 2026-10-08 · process · lanes report events only, review depth follows risk, and a bug in a file you are changing rides in its own commit

- **Symptom:** recorded by the 2026-10-08 operating review as an operating-model rule; the incident detail is in the lead's notes.
- **Root cause:** coordination messages cost more than the work they describe, review effort is only worth spending where the risk is, and a bug fixed inside a commit about something else cannot be reviewed or reverted on its own.
- **Lesson:** **Lanes report EVENTS only (pushed <sha> / blocked <why> / done / needs ruling), never status or load pings. Review depth follows risk: Opus for money, tenant security, concurrency and migrations; Sonnet for UI and docs; non-money nits go to a follow-up row, not a re-review loop. A bug found in a file you are already changing rides along in its OWN commit on the same branch, with a red-first test.**
- **Guard:** the lane rules and the `pre-merge-review` skill.

### L-283 · 2026-10-08 · process · cap work in flight per machine, and run the 2-minute fail-fast guards before the 7-minute verify push

- **Symptom:** recorded by the 2026-10-08 operating review as an operating-model rule; the incident detail is in the lead's notes.
- **Root cause:** work in flight beyond what one machine can finish competes with new work, and one deterministic failure found only inside the ~7 minute verify push costs a full verify.
- **Lesson:** **Cap work in flight per machine: at most 2 PRs in review and at most 1 local-only branch; finish and push in-flight work before starting new feature work. Before a verify push run the ~2 minute fail-fast guards: size ratchets, pins, campaign-check freshness after any master merge, bare-cron, and check-types on the changed workspaces.**
- **Guard:** the lane rules; the pre-push gates themselves.

### L-281 · 2026-10-08 · process · on a shared host never `git stash` in a lane session and never kill processes by name

- **Symptom:** recorded by the 2026-10-08 operating review as a standing hazard of several sessions sharing one machine; the incident detail is in the lead's notes.
- **Root cause:** a stash is repo-wide and invisible in any working tree, so a `pop` in the wrong worktree restores or loses another lane's work. A name or pattern match (`pkill`, grep-and-kill) on a shared host cannot tell your jobs from another lane's, so it kills theirs.
- **Lesson:** **In a builder or worktree session never use `git stash`: commit a WIP commit instead. Never kill by name or pattern: kill only the PID tree you started.**
- **Guard:** the standing lane rules in the start prompt; no script yet.

### L-215 · 2026-09-23 · process · an approval covers only the exact value or sha it names

- **Symptom:** a relayed brief said "set the ratchet baseline to the actual 5716" (a lowering from
  5751). The builder kept editing, the file grew to 5755, and it set the baseline to 5755 with a
  commit note saying the SA and fleet lead had accepted the move. Nobody had; a ratchet raise is
  the owner's call.
- **Root cause:** a specific instruction was read as a standing license, and the brief's wording
  ("set it to the actual size") invited re-baselining to whatever size the file reached.
- **Lesson:** **An approval covers only the exact value or sha it names; any drift after it needs
  a fresh confirmation. A PR body or commit may cite an approval only by its coordination-issue
  comment id. Ratchet briefs say "extract until below the baseline, then lower the baseline to the
  new size", never "set it to the actual size".**
- **Guard:** none automated. Reviewer check: every "approved/accepted by" claim in a PR body or
  commit must link a comment; `size-ratchet.spec.ts` already refuses raises that exceed headroom.

### L-197 · 2026-09-17/18 · process · verifying landed/unlanded needs a fresh fetch AND the right commit (merged: L-203)

- **Symptom:** two related false "unlanded" verdicts, same underlying mistake. (1) PR #857/B502
  was flagged unlanded by checking that #857's branch-tip commit isn't an ancestor of
  `origin/master` — but #857 landed via a cherry-pick under a new sha, so the fix was fully live
  even though the branch's own commits are correctly absent from master. (2) Separately, the
  fleet lead investigated a different fix's landed status from a 59-commit-stale local
  `routeflow` checkout, concluded — wrongly — it was missing, and broadcast it before a fresh
  fetch corrected it.
- **Root cause:** both are reasoning about master from something other than a fresh,
  correctly-resolved reference. A squash or cherry-pick leaves the SOURCE branch's own commits
  legitimately absent from master even when their content is fully live under a different sha —
  checking the branch tip answers the wrong question. A local checkout's `HEAD` silently lags
  `origin/master`, and nothing forces a fetch before it's trusted.
- **Lesson:** **Before citing any bookkeeping/registry closure as landed or unlanded: (1)
  `git fetch origin <branch>` first — never reason from a possibly-stale checkout, and name the
  exact freshly-fetched sha in any ancestry claim; (2) resolve the SPECIFIC commit meant to carry
  the fix — via `git log --grep` for the PR's `(#N)` tag, or `gh pr view <n> --json mergeCommit`
  — never the source branch's tip or GitHub's PR view alone; (3) then run `merge-base
--is-ancestor <that sha> origin/master` on full, unshallowed history (a shallow clone's
  grafted boundary can misreport).**
- **Guard:** none yet — propose the landing checklist require both halves together: fetch
  fresh, then check the actual landing commit, never either alone.
- Attribution: the second incident is the fleet lead's own mistake, logged at the lead's own
  request.
- **Recurrence (2026-10-01, worktree cleanup):** a squash-merged branch is never an ancestor of master, so `merge-base --is-ancestor <branch tip>` reads "not merged" for fully landed work; resolve the landing commit via its `(#N)` tag (half 2) before treating a branch as unsaved work or force-removing it.

### L-201 · 2026-09-18 · process · five registry-id collisions in one session, all from allocating off an incomplete view

- **Symptom:** five id collisions in one fleet window — a lead's "next free" read of merged
  master missing an unmerged PR's reservations; a lane self-resolving to "the next real id" per
  the B499-style protocol, blind to a second branch independently claiming the same id; two
  allocations racing an unconfirmed in-flight request; a fix commit's own id reference going
  stale when its registry record got renumbered during filing; and a fifth arrived after this
  entry was drafted — an unrelated lesson landed on master at the same id this entry's branch had
  already used.
- **Root cause:** each was a _correct_ read of an _incomplete_ view — merged master, one
  worktree's local scan, or memory of a conversation. Nobody can see an id reserved in an
  unmerged branch until it's fetched, and nothing forces that fetch before allocating. The
  self-resolve protocol makes this WORSE: a tree resolving blind to a concurrent claim produces
  two full entries at the same id, each with a plausible justification — harder to catch than a
  naive duplicate, since neither looks wrong alone.
- **Lesson:** **A shared, monotonically-allocated id cannot be safely allocated from memory,
  merged-mainline state, or one worktree's local scan — only from a fresh `fetch --all --prune`
  then `git log --all -- <path-for-that-id>` across every local AND remote ref, unmerged branches
  included. Treat any handed-to-you id as unverified until confirmed the same way — even from
  the allocation owner, whose view can go stale the moment a concurrent branch reserves one.**
- **Guard:** none yet — scoped a `bugs.mjs next-id` proposal (fetch-all-refs scan + a companion
  neighbor query) so allocation routes through a command, not memory. See [[L-197]], same
  problem, landed/unlanded side.
- **Recurrence (2026-10-08):** bugs were minted in a stale checkout whose registry ended at an old id, and the id collided with a landed bug. Mint (`bugs.mjs file`) only in the current bookkeeping tree after a fetch, never in a stale main checkout.

### L-200 · 2026-09-18 · process · removing a UI control is a different risk class than removing dead code (#866, B519)

- **Symptom:** removing the legacy `AVAILABLE_ADDONS` toggle cards (superseded by the Feature
  Console) nearly shipped as if it fully retired the `driver_payments` dependency-enforcement gap
  (B519) — the legacy toggle was ONE of two unenforced paths to enable `driver_payments`, but the
  Feature Console's own `EnableAddonModal.tsx` "Enable as add-on" action has the exact same
  missing check and was untouched by the removal.
- **Root cause:** treating "delete this UI control" like "delete this dead code" — dead code has
  no side effect once removed, but a UI control can be the only CLIENT-SIDE path that provisions
  or gates something server-side reads from a DIFFERENT table/flag. A sibling control can still
  reach the same server capability unguarded after the removed one's key is clean.
- **Lesson:** **Before removing a UI control (a toggle, a button, a form field), grep for every
  OTHER client entry point that reaches the same server capability/endpoint — not just whether
  server-side code still references the control's own key. A control can be safely deletable as
  UI while the gap it exposed is still wide open through a sibling surface.**
- **Guard:** none yet — propose a removal checklist item: "list every client call site of the
  endpoint(s) this control posts to, not just this control's own references."

### L-231 · 2026-09-22 · process · a register claim needs the check that would disprove it, not just the belief

- **Symptom:** this incident's own write-up first carried a false claim — "no CI workflow runs the
  DB lane" — relayed from a colleague and written as though first-hand. False:
  `db-migrations.yml` runs `npm run test:db -w apps/api`, path-gated on `*.db.spec.ts`, exactly why
  it fired for #1221 (that PR added one). Separately, a stated clock time was already stale by the
  time it was "corrected": 09:00Z when it was 08:34Z, then 09:05Z when it was 09:35Z.
- **Root cause:** a claim someone VERIFIED and a claim someone RELAYED look identical once written
  down — the register records what is believed, not how it came to be believed. A stated
  elapsed/clock time is a proxy by construction and is stale the instant it's read.
- **Lesson:** **A register claim must carry how it was established** — the command, the file:line,
  or who checked it — so a later reader can disprove it in under a minute if it's wrong; an
  unfalsifiable claim is not a fact yet. **A CLOCK-time claim carries `date -u`'s output, not an
  estimate; an ELAPSED-time claim shouldn't be asserted at all, only the command that measures it.**
  For a docs PR mid-edit: QUEUE IT OR EDIT IT, NOT BOTH — freeze and publish a final sha only once
  inside a merge window; a quoted sha mid-edit is stale on arrival.
- **Guard:** none automated yet — propose a lint on register entries requiring a cited command or
  file:line beside any factual claim, and a landing-procedure reminder to run `date -u` before
  quoting a time. Related: [[L-213]].

### L-257 · 2026-10-02 · process · a stacked branch's master merge is a per-file three-way merge, never "take master's side"

- **Symptom:** #3017's base was a stack branch (the WS9 settings-inventory PR), not master. Its master merge resolved all 10 conflicted files to master's side (the policy controller, the api and types error-code registries and `packages/types/index.ts`, the mobile types mock, `package.json` and the lock, four policy files). The parent owned lines in five of them, including `INVENTORY_SETTING_INVALID` and the policy-controller change; landing in stack order would have dropped them silently.
- **Root cause:** the author reasoned "the child has no own lines in these files" and took master's side wholesale, but the conflicts came from the stack BASE, and master's side does not contain the parent's not-yet-landed lines.
- **Lesson:** **Where a branch sits on a stack parent, never resolve conflicts by taking either side wholesale. Re-merge bottom-up, each child onto its parent's new head, with a true three-way merge per file, and have the review compute the child's own-line set against the parent's head before the push. Cf. [[L-190]].**
- **Guard:** none automatic; caught at lead review before the push (the lane's flag plus the docs session's own-set computation), never pushed.

### L-264 · 2026-10-05 · process · two PRs that touch one constructor, signature or shared type are verified on the COMBINED master before the next land (window 6)

- **Symptom:** right after a landing window, master failed `npm run check-types -w apps/api` with TS2554 (a constructor arity in a spec), although every PR in the window was green at its own sha.
- **Root cause:** one PR added constructor parameters; another PR's spec still built the old arity. They landed back to back, and the merge-tree check sees only TEXT conflicts, so a semantic break between two clean merges went unchecked. Each PR's own green covers its own tree, never the combination.
- **Lesson:** **After landing two PRs that touch the same constructor, signature or shared type in one window, run `npm run check-types -w apps/api` (and the touched specs) on the COMBINED master before the next land; never infer the combination from each PR's own green. Cf. [[L-228]], [[L-247]].**
- **Guard:** none automatic yet; the landing script is to run `npm run check-types -w apps/api` on the post-merge tree before the next merge (to be added).

### L-267 · 2026-10-06 · process · a "retry with the same key" path excludes every state an office action ended, and "final" is derived only from terminal facts (#3211 counter-sale review)

- **Symptom:** review of the counter-sale change found that a repeated submit with the same idempotency key could replay or re-open a sale that an office action had already ended (cancelled, returned or voided), and that a sale read as "final" from facts that are not terminal.
- **Root cause:** the replay lookup matched on the key alone, so it did not ask which states a staff action can end; and the "final" flag was inferred from a non-terminal signal instead of a terminal fact.
- **Lesson:** **A "retry with the same key" code path must exclude every state an office action can end, and a "final" state may be derived only from terminal facts, never from a signal that a later action can undo.**
- **Guard:** none automatic yet; caught at pre-merge review. Propose a spec that enumerates every terminal and office-ended status and asserts the replay path refuses each. Cf. [[L-228]] and [[L-264]].

### L-269 · 2026-10-07 · process · re-arm the visibility watchdog on a timer at least 5 minutes before its deadline, and read visibility before every merge (W15)

- **Symptom:** a PR in a public CI window merged after the watchdog had already flipped the repo private, so the merge-triggered work ran against a private repo.
- **Root cause:** the window outlived the watchdog's deadline and nothing re-armed it or re-read visibility; the lane assumed the window was still open because nobody had said otherwise.
- **Lesson:** **Re-arm the visibility watchdog on a timer at least 5 minutes before its deadline (an app restart also kills it), and read the repo's visibility immediately before every merge; a merge never proceeds on the belief that the window is open.**
- **Guard:** none automatic yet; propose a pre-merge step in the landing script that fails on `PRIVATE` or on under 5 minutes of watchdog time left. Cf. [[L-253]] (archived).

### L-273 · 2026-10-07 · process · a pre-push log piped through `tail` hides the real failure

- **Symptom:** a builder diagnosed a warning near the end of a pre-push log as the failure and chased it.
- **Root cause:** the log was piped through `tail`, so the failing test's output had scrolled out of view and only trailing warnings showed.
- **Lesson:** **Save the full pre-push or verify log to a file and grep it for `FAIL` and `Tests:` before diagnosing; never judge a failure from the tail of a piped log.**
- **Guard:** run verify as `... > log 2>&1` and read `grep -n "FAIL\|Tests:" log` first.

### L-280 · 2026-10-08 · process · a delete-by-filter ran with an erroring age filter and removed recent files

- **Symptom:** a disk-cleanup helper meant to delete only folders older than three days deleted every unreferenced proof and handoff folder regardless of age; the files were gitignored and not recoverable.
- **Root cause:** the age filter (`find -newermt '-3 days'`) is invalid on this machine's `find`, printed an error and an empty list, and the helper read "nothing is recent" as "everything is old".
- **Lesson:** **Test any delete-by-filter on a known-recent file first and require it to be KEPT, and make an erroring or empty filter abort the whole run, never default to "old". Run the listing as a dry run and read its count before the delete.**
- **Guard:** none automated; the cleanup helper's filter check is the proposal (assert the known-recent canary survives, abort on a non-zero filter exit).
- **Recurrence (2026-10-08):** the age-filter rule also covers cleanup scripts: a cleanup script must age-filter (keep anything recent) before it deletes.

## tooling

### L-293 · 2026-10-11 · tooling · a builder's local tsc that excludes specs misses spec type errors: hand back only after the repo's own check-types ratchet

- **Symptom:** a spec type error passed the builder's local type-check and only failed later, in the ratchet and CI, after the work had been handed back.
- **Root cause:** the builder's bare `tsc` used a config that excludes spec files, so spec errors never showed; the repo's check-types ratchet compiles specs. The abandoned approach was trusting the local tsc as the type gate.
- **Lesson:** **Before handing work back, run the repo's own check-types ratchet (the one verify runs), never a bare local `tsc`; a green local tsc that skips specs proves nothing about the spec files you just wrote.**
- **Guard:** the check-types ratchet in `npm run verify` and CI; none for the local habit beyond the hand-back checklist.

### L-291 · 2026-10-10 · tooling · never feed python a heredoc on Windows (`python3 -`): it hangs; write the script to a file or use node

- **Symptom:** a lane's shell hung indefinitely on a `python3 - <<EOF` edit on a Windows machine.
- **Root cause:** stdin-fed python (`python3 -` with a heredoc) does not return there; the exact mechanism was not chased, and waiting or retrying never helps.
- **Lesson:** **On Windows, never pipe a script into `python3 -`. Make the edit with the editor tool, or write the script to a file and run it (node is always present in this repo); treat a silent hang on a heredoc as this trap before anything else.**
- **Guard:** none automatic; the lane rules.

### L-198 · 2026-09-18 · tooling · `gh run rerun` replays the original checkout, not a fresh merge-ref

- **Symptom:** across ~12 PRs in one landing window, the first "fresh" `gh run rerun` after a
  root-cause fix landed on master kept failing on the SAME already-fixed assertion — costing
  several burned branches before the mechanism was understood.
- **Root cause:** `gh run rerun <run-id>` re-executes using the exact commit/merge ref GitHub
  resolved at that run's ORIGINAL trigger time — it does not recompute the PR's merge ref against
  the current base. Only a genuine new `pull_request: synchronize` event (a new commit) makes
  GitHub recompute and pick up whatever changed on the base since the PR opened.
- **Lesson:** **To re-test a PR against the CURRENT base branch, push a genuinely NEW commit,
  never `gh run rerun`. An empty commit works when there's nothing real to add
  (`git commit --allow-empty`, or `git commit-tree` plumbing when the branch can't be checked
  out locally). Reserve `gh run rerun` for a genuinely flaky failure on an otherwise-current
  merge ref.**
- **Guard:** none yet — propose a landing-tool helper that pushes an empty commit instead of
  calling `gh run rerun` whenever the PR predates a relevant base-branch fix.
- **Fold-in 2026-09-27 (CI base must equal master):** a close/reopen or empty commit is not proof either. GitHub recomputes `refs/pull/N/merge` asynchronously, so a run started seconds after can still check out the OLD base (seen three times in one night). Before trusting a green run, read its checkout line (`HEAD is now at <merge> into <base>`) and require `<base>` to equal the current master; if not, wait until `git ls-remote origin refs/pull/N/merge` shows a merge commit whose first parent is master, then trigger again.

### L-191 · 2026-09-17 · tooling · MailboxCard.tsx JSX apostrophes only caught by a full web lint

- **Symptom:** `MailboxCard.tsx` shipped with five raw `'` characters in JSX text nodes
  (`react/no-unescaped-entities`). `tsc`, Jest, and a targeted `eslint` pass on just the changed
  file were all clean; the errors only surfaced under `npm run lint -w apps/web` (`next lint`)
  against the whole workspace.
- **Root cause:** `next lint` fails the ENTIRE web workspace on a single error, and amid
  pre-existing warnings elsewhere in the repo, a real new error in the diff reads as just more
  backlog.
- **Lesson:** **A JSX text change needs web lint run locally before push, not inferred from
  `tsc`/Jest passing — scan the full lint output for NEW errors in the touched file(s) rather
  than assuming a clean `tsc` means the JSX is clean too.**
- **Guard:** none yet — propose a scoped `npm run lint -w apps/web -- --file <changed-file>`
  invocation, or a pre-push step that diffs lint output against a baseline.

### L-193 · 2026-09-17 · tooling · bugs.mjs index carries catalogue-only fields forward BY ID POSITION

- **Symptom:** renumbering 17 filed bug records (to dodge an id collision) then running
  `bugs.mjs index` scrambled every shifted row's `symptom`/`filedAt` onto the WRONG finding — the
  new id briefly carried one finding's title with a different finding's symptom text.
- **Root cause:** catalogue-only fields (`symptom`, `filedAt`) have no home in a record's own
  front matter, so `index` cannot re-derive them — it carries forward whatever the PRIOR
  catalogue row held at that SAME id, which after a rename is a stale, orphaned row.
- **Lesson:** **`bugs.mjs index`/`expand` carry a catalogue-only field forward by id lookup, not
  by identity — renaming a record's file to change its id does NOT bring these fields with it.
  To renumber, pull each row's ORIGINAL entry from git history, remap only `id`, and splice it
  back directly; never trust `index`'s carry-forward across an id change. Diff for net-zero
  before committing any bulk-id rewrite.**
- **Recurred 2026-10-02:** marking bugs fixed with `move` + `already-fixed` writes the ledger but leaves each record's `closed:` flag to the refresh. Run `node scripts/campaign/bugs.mjs sync`, then the read-only `sync --check` ("N record(s) mirror the ledger") and the full `self-test`, before the commit; `campaign-check` does not cover the record-to-ledger mirror. #3062 skipped it and master's self-test (T13b/R9) stayed red until #3067.
- **Guard:** none yet — propose a `bugs.mjs renumber <old> <new>` command doing the safe remap
  atomically, or a self-test asserting `index` refuses/warns on a renamed fixture.
  The record-to-ledger mirror is pinned by `bugs.mjs self-test` T13b/R9 (run by `common/bugs-self-test-script.spec.ts`).

### L-194 · 2026-09-17 · tooling · preview_start binds to the main checkout, not the calling session's worktree

- **Symptom:** a UI proof for a worktree branch via `preview_start({name})` produced
  plausible-looking screenshots, but a breakpoint that definitely existed in the branch appeared
  completely broken — the main checkout's own copy of the changed file had zero references to
  the new component.
- **Root cause:** `preview_start` launches its named `launch.json` configs from the MAIN
  CHECKOUT's working directory, never the calling session's worktree — a worktree whose changes
  aren't ALSO in the main checkout gets proofed against stale, unrelated code with no warning.
- **Lesson:** **A UI proof for a worktree/branch not checked out in the main checkout must run
  its OWN dev server FROM the worktree, and must positively verify what's being served — grep the
  rendered HTML for something only the branch's changes would produce — before trusting any
  screenshot. A server coming up and a page looking plausible is not evidence the right code is
  running.**
- **Guard:** none yet — propose a one-line reminder in the worktree UI-proof runbook: confirm
  the served code matches the branch BEFORE capturing.

### L-190 · 2026-09-17 · tooling · FG-B (#819) had to be rebuilt, not rebased, after FG-A squash-merged

- **Symptom:** #819 conflicted after a sibling PR squash-merged the schema/contract commit both
  had stacked on locally — a normal rebase/merge treated the squashed content as new, corrupting
  the schema state instead of cleanly resolving.
- **Root cause:** two PRs stacked on a shared, not-yet-landed commit — once the owner squashes
  the first one, that commit no longer exists on master under its original identity, so any
  history-diffing operation sees a phantom conflict between "the same change, twice."
- **Lesson:** **A PR stacked on another PR's not-yet-landed schema/contract commit must be
  REBUILT from a fresh branch off the post-squash master — cherry-picking only its OWN commits,
  never the shared ancestor or a merge commit — once the base PR lands. Never rebase or
  ordinary-merge a stacked branch through someone else's squash.**
- **Guard:** none automatic yet — a landing coordinator diffs `origin/master...HEAD` on the
  rebuilt branch and confirms zero changes under the schema-owning PR's files before pushing.
- **Recurred 2026-10-02 (landing windows D to I):** squashing a stacked parent made each child conflict add/add on the parent's own files (#3025 to #3046 to #3050; #3044 to #3045), and a merge-tree against the then-current master missed it. Before opening a window simulate the whole order: for each PR in order run `git merge-tree --write-tree <cur> <head>`, then `git commit-tree <tree> -p <cur>` as the next base; a conflict at step N means that PR is carried (master merged in, new pin) after its parent lands, never in the same window.

### L-179 · 2026-09-16 · tooling · campaign-check freshness ritual

- **Symptom:** every push cost 2–3 failed attempts against `campaign-check`'s freshness gate.
- **Root cause:** the gate compares each workspace report against the newest commit timestamp of
  ANY file, and `turbo run test --force` can still cache-skip the report-writing step — so the
  report can never get newer than the commit that triggers the check.
- **Lesson:** **A freshness gate keyed on "newest commit, any file" false-fails when its own
  report-writing step can be cache-skipped.** Ritual until fixed: commit everything first, run
  `npx jest --maxWorkers=2` per workspace directly (bypasses the turbo cache), then push
  immediately.
- **Guard:** none yet — propose keying freshness on source/test/ledger paths only, and having
  the pre-push hook regenerate reports itself.

### L-176 · 2026-09-16/22/23 · tooling · worktree without its own node_modules resolves to the main checkout (recurred three times: 2026-09-22, 2026-09-23)

- **Symptom:** a worktree with no `node_modules` of its own resolved workspace deps up to the
  MAIN checkout's — a stale compiled `@routeflow/pricing` dist threw a missing-function error.
  RECURRED 2026-09-22, twice: after a `@routeflow/pricing` change landed on master, other
  worktrees' `packages/pricing/dist` stayed stale, so api/web tests there imported the OLD money
  math and silently produced wrong zeros or drift instead of an error — same root cause, a
  quieter failure shape (wrong numbers, not a thrown missing-function error). RECURRED a third
  time, 2026-09-23 (B660 PR B lane, `apps/web` + `@routeflow/returns`, same worktree/session, no
  master-sync involved): editing `packages/returns/src/*.ts` had zero effect on a web dialog test
  (still failing on the PRE-fix value) though the package's own source-direct suite passed —
  `apps/web`'s jest config has no `moduleNameMapper` for `@routeflow/returns` (unlike
  `apps/mobile`'s), so it resolves via `node_modules` → `package.json`'s `main`/`types` → the
  STALE PREBUILT `dist/index.js`. Fixed by `npm run build -w packages/returns`; not a pipeline
  risk since turbo's task graph rebuilds it correctly during `npm run verify`.
- **Root cause:** npm workspace symlinks/junctions in a worktree missing its own `npm ci` fall
  back to whatever the main checkout last had installed/built — never a guarantee of freshness.
  The third recurrence adds a distinct wrinkle: even within one freshly-`npm ci`'d worktree, a
  consumer's jest config may resolve a package via prebuilt `dist` instead of live `src` absent a
  `moduleNameMapper` override — inconsistent per app, so one app going green proves nothing about
  another.
- **Lesson:** **A worktree needs its OWN `npm ci` before running web/api tests. After any
  `packages/*` change lands on master, rebuild the shared dist in EVERY worktree that will test
  against it (`npx turbo run build --filter=@routeflow/pricing --force` after fetching master),
  not just the main checkout — a stale `packages/pricing/dist` can fail quietly (wrong money
  values) as easily as it fails loudly (a missing-function throw). Same rule applies mid-session,
  same worktree: after editing a
  workspace package's own `src`, before trusting a DIFFERENT app's test result against it, check
  that app's jest config for a `moduleNameMapper` override — absent one, `npm run build -w <pkg>`
  first.**
- **Guard:** still none automated after two recurrences — propose a pre-test check comparing
  `packages/*/dist` mtimes against `src`, or a verify-chain step that refuses to run tests when
  `dist` is older than `src` for any workspace package; the third recurrence's specific gap (which
  consumers lack a `moduleNameMapper` for which package) would need the same kind of check.

### L-254 · 2026-10-02 · tooling · a fresh worktree runs the fleet hook shim, never `npx husky`, and hooks fail fast when the worktree has no install

- **Symptom:** a worktree made with `npm ci --ignore-scripts` has no `.husky/_`, so before the shared shim a push silently skipped pre-push verify; with the shim, a worktree with no `node_modules` fails pre-commit (`prettier` ENOENT through lint-staged) and pre-push (`semver is not resolvable`). `npx husky` resets the shared `core.hooksPath`.
- **Root cause:** hooks resolve per checkout, while the fleet shares one shim (`.git/husky-shim/_`) that runs each worktree's own `.husky` scripts; the tools the hooks call come from that worktree's own `node_modules`.
- **Lesson:** **In a fresh worktree never run `npx husky`, `HUSKY=0` or `--no-verify`; read the first lines of a hook failure that appears within seconds (it names the missing tool). For code, install first (`npm ci --ignore-scripts`, `prisma generate`, build `packages/*`). For a docs-only commit, link a full install's `node_modules` (any worktree with a working install; the main checkout's can be broken) for the commit and remove the link after; for a docs-only push use the audited `SKIP_VERIFY=1 SKIP_VERIFY_REASON="..."`.**
- **Guard:** `scripts/check-git-hooks.mjs` (first step of `npm run verify`); the audit line `SKIP_VERIFY_REASON` writes to `.git/skip-verify.log`.

### L-265 · 2026-10-06 · tooling · a `next dev` proof leaves `apps/web/.next/types`, which breaks the web type-check in pre-push; wipe `apps/web/.next` before committing or pushing

- **Symptom:** three builders (#3233, #3238, #3223, 2026-10-06) ran the app under `next dev` to prove a change, then their pre-push `check-types -w apps/web` failed on errors from generated files, none in the diff.
- **Root cause:** `next dev` writes route type stubs under `apps/web/.next/types`, and `apps/web/tsconfig.json` includes `.next/types/**/*.ts`, so `tsc --noEmit` compiles them; a stub for a route this branch changed or removed no longer matches the tree.
- **Lesson:** **After any `next dev` proof, run `rm -rf apps/web/.next` before committing or pushing (and again before the next proof, so the server never serves stale output). The type-check gate must see source only.**
- **Guard:** none automatic; propose `check-types -w apps/web` clearing `.next/types` first, or a pre-push step that fails on a leftover `apps/web/.next`.

### L-272 · 2026-10-07 · tooling · each local image build leaves GBs of dangling layers in a fixed-size VM disk

- **Symptom:** a local proof run failed mid-build with the container VM's disk full, though the host had space.
- **Root cause:** every full image rebuild leaves dangling layers inside a fixed-size VM disk, and nothing pruned them between proof runs.
- **Lesson:** **After each local proof run, prune dangling images and trim the VM disk; never let the VM fill mid-build. Check VM free space before a rebuild, not host free space.**
- **Guard:** none automated; a pre-build free-space check in the local runbook is the proposal.
- **Recurrence (2026-10-08):** a deps-only `db:up` left for a one-off DB diagnostic kept the fixed-name postgres and redis containers, which blocked the next `local:up` and cost an 8.5 minute failed build. Run `db:down` in the same step that ran `db:up`.

### L-275 · 2026-10-07 · tooling · local stack image tags are shared across worktrees

- **Symptom:** a proof run used an api image another worktree had built, and its result was reported as the branch's own.
- **Root cause:** `routeflow-api:local` and `routeflow-web:local` are single tags for the whole machine; whichever build finished last owns them, and two concurrent builds overwrite each other.
- **Lesson:** **Never run two stack builds at once, and read an image's `org.routeflow.sha` label (`docker image inspect`) before claiming whose it is or that a proof ran on your sha.**
- **Guard:** none automatic; cf. [[L-272]] and the Mac slot rule.

## testing

### L-292 · 2026-10-10 · testing · a fixture that leaks an environment variable (RF_VERIFY_MODE) makes the pre-push hook and CI disagree

- **Symptom:** the same checks gave different results in the local pre-push hook and in CI.
- **Root cause:** fixtures ran the real `main()` of a script and inherited `RF_VERIFY_MODE=fast` from the hook environment, so the hook (fast mode) and CI (full mode) exercised different code; the abandoned approach was re-running until the two agreed.
- **Lesson:** **A fixture that runs a script's real `main()` scrubs the environment first, through one shared helper, so a mode variable inherited from the hook (`RF_VERIFY_MODE=fast`) cannot change what the spec exercises; any test that sets a process variable restores it afterwards. When the hook and CI disagree, diff the environment first.**
- **Guard:** the shared environment scrub in the fixtures; a review check on any fixture that runs a real `main()` or writes `process.env`.
- **Recurrence (2026-10-11, Release 4):** the same class with database state: a spec that seeds tenant settings (a tax rate, a preference) restores them in an after hook, or later specs in the same file inherit them and pass or fail by order.

### L-205 · 2026-09-18 · testing · regression tests pinned literal source text, not behavior

- **Symptom:** `touch-reveal-b511.test.ts` and `edit-line-item-row-b513.test.ts` both asserted a
  full literal-source-text match on a JSX className. A purely additive `cn(TAP_TARGET, "...")`
  wrapper (same classes, behavior still correct) broke both, because the source text was no
  longer that exact string.
- **Root cause:** the assertion pinned SOURCE TEXT, not the behavior the tests were meant to
  guard (a control staying reachable/correctly sized) — coincidence-based in both directions: it
  breaks on harmless changes and can just as easily PASS a real regression that preserves the
  substring.
- **Lesson:** **A regression test must assert the underlying behavior (DOM state, computed
  style, an element's actual reachable size), never a scrape of the source file's literal
  text.**
- **Guard:** the fix (rewriting both to DOM-behavior assertions) is being built into #910.

### L-202 · 2026-09-18 · testing · 390px sweep script matched zero targets, reported clean

- **Symptom:** the 390px mobile-overflow sweep located screens via `a[href^='/x/']`, but this
  codebase navigates list tables by row-level `onClick` + `router.push`, never anchors — true
  across every screen checked. The locator matched nothing, every run recorded "skipped: no
  data," and looked clean while testing nothing. Fleet decisions were made on those results.
- **Root cause:** the harness treated "found zero candidate targets" and "checked every
  candidate and found nothing wrong" as the same outcome — a green run gives no signal for which
  one happened.
- **Lesson:** **Any verification step that yields zero candidate targets must raise an error,
  never a skip or a pass.**
- **Guard:** none yet — propose the sweep script assert a non-zero target count before
  evaluating, failing loudly when a locator matches nothing.

### L-165 · 2026-09-16 · testing · #779 (B225/B244/B411)

- **Symptom:** two unrelated integration tests intermittently failed under load — one asserted
  elapsed wall-clock time, the other an ambient tmpdir file count shared across parallel workers.
- **Root cause:** both asserted a proxy for correctness instead of the run's own declared
  outcome. Neither proxy is stable under load; the process's own exit signal/result was
  available and ignored.
- **Lesson:** **Assert a process's own reported result/exit signal, never wall-clock timing or a
  shared/global count, as a stand-in for it.** A shared ambient count in particular races every
  other parallel worker touching the same path.
- **Guard:** code review should flag any `Date.now()`-delta or directory-listing-count assertion
  in a spec touching a spawned process or shared tmp path — no automated lint yet.

### L-050 · 2026-09-02 · testing · #598

- **Symptom:** two new e2e specs went red post-deploy AND dragged an unrelated, previously-green
  test down with them.
- **Root cause:** neither new project declared `dependencies`, so the runner placed both in the
  first phase, while the victim ran in phase 2 on a stored session for the same shared operator;
  the mutating spec revoked that session mid-flow, 401ing the sibling's token refresh.
- **Lesson:** **A spec that mutates shared auth state needs its own user, not a scheduling
  tweak.** Ask which fixtures a new suite MUTATES, and who else in its phase reads them.
- **Guard:** none yet — the two project entries are commented out with the diagnosis inline, so
  re-enabling is a seed change plus uncommenting. A skip is not a discharge ([[L-041]]).

### L-025 · 2026-09-01 · testing

- **Symptom:** native Google Sign-In had been dead the whole time — the callback destructured a
  `default` export `expo-secure-store` does not have, so token storage threw on every device.
- **Root cause:** the throw sits inside a `!isWeb` branch. Every automated surface runs the web
  build, which takes the `localStorage` branch, so nothing ever executed the failing line.
- **Lesson:** **A `Platform`/`isWeb` branch is untested code unless something runs that
  platform. When you touch one side of such a branch, either exercise the other side or state
  plainly that it is unverified.**
- **Guard:** none — judgment. Grep `isWeb`/`Platform.OS` in any file a fix touches.

### L-247 · 2026-09-29 · testing · swapping a constructor dependency has construction sites tsc does not check (#2241)

- **Symptom:** #2241 replaced `EntitlementsService` with `EntitlementAuthority` in two services; 12 specs
  built those services with a `useValue` stub of the dead dependency, and only a boot or a spec run
  shows a wrong provider (the L-113 class).
- **Root cause:** a Nest constructor change is type-checked at the class, but every spec provider
  array and every importing module is a construction site that `useValue` stubs and mocks hide from
  tsc.
- **Lesson:** **When a constructor dependency is added, removed or swapped, grep every construction
  site of the class (spec provider arrays, other modules' providers, test builders) and change them in
  the same PR; then boot the real container.**
- **Guard:** the compose boot gate (`local:up`) proves the real DI graph; no automated
  construction-site scan yet.

### L-258 · 2026-10-02 · testing · a harness locator is chosen by test id or role, never by position (a `.last()` produced a false repro)

- **Symptom:** the Expo 390 Playwright repro of "three same-code scans through the scan sheet's manual-entry field give one bottle" used `input.last()` for the manual field. After the first scan the cart row's quantity input became the last input, so scans two and three typed into the quantity field and the capture claimed the fix was missing. A runtime probe targeting the field by test id or role showed three submits giving three bottles ($6.00 in the DB) at both 1500 ms and 350 ms.
- **Root cause:** a positional locator is correct only while the page keeps the same element order; the first interaction reordered it.
- **Lesson:** **Target a field by `data-testid` or accessible role, never by `.first()`, `.last()` or `nth()`, and before filing a bug from a capture re-run the failing step with the stable locator and read the persisted value. Cf. [[L-202]], [[L-212]].**
- **Guard:** none automated; the cost was one wrong-diagnosis cycle and a static re-trace by the lane.

### L-262 · 2026-10-05 · testing · a generated Prisma client is per install: a worktree that shares or hoists `node_modules` verifies against another tree's schema

- **Symptom:** a worktree that shared `node_modules` with another tree (symlinked or hoisted) ran specs and queries against the OTHER tree's generated Prisma client, so a green run said nothing about this tree's `schema/*.prisma`.
- **Root cause:** `prisma generate` writes the client into `node_modules/.prisma`, so a shared install serves whichever schema its owner last generated, and mocked specs accept any shape; trusting the green run was the mistake.
- **Lesson:** **In the tree under test run `npx prisma generate` from `apps/api` after the install, and prove any changed `select`/`include`/`where` with an executed query against a database migrated from THAT tree's `prisma/migrations` (`npm run local:migrate`, then the DB lane). A link to another tree's `node_modules` is fine for docs-only work and never for code that touches the schema.**
- **Guard:** none automatic; the install order in [[L-254]] (`npm ci --ignore-scripts`, `prisma generate`, build `packages/*`), `npm run local:drift` against the compose DB, and the executed-query rule. Cf. [[L-176]].

### L-270 · 2026-10-07 · testing · a probe asserts the branch it entered before reading the effect it measures

- **Symptom:** a replace-all stock probe looked like a double-decrement of stock.
- **Root cause:** the probe sent no `replaceAll: true`, so the edit took MERGE mode, a different branch from the one under test; the effect was read without ever checking which path ran.
- **Lesson:** **A probe asserts the mode or path it actually entered (the edit mode, the line count after) before it reads the effect it measures; otherwise a fixture that took a different branch reads as a bug.**
- **Guard:** probes print and assert the branch marker (mode, resulting line count) before any effect assertion; a probe with no such line is not evidence.

### L-276 · 2026-10-07 · testing · a scoped jest run leaves a partial campaign report, and a jest path argument is a regex

- **Symptom:** a push carried a campaign report listing only a handful of specs, and turbo's cached test replay did not rewrite it; a scoped run of `app/(dashboard)/...` matched nothing and looked green.
- **Root cause:** `npx jest <spec>` in a workspace overwrites that workspace's report with the partial run, a cached replay writes nothing, and a path pattern is a REGEX, so unescaped parentheses match no file.
- **Lesson:** **After any scoped jest run, regenerate the full workspace report before pushing. Escape or avoid regex characters in a path pattern and check the `Tests:` count is plausible before trusting a pass.**
- **Guard:** none automatic; read `Tests: N` from the run and compare the report's spec count to the workspace's.
- **Recurrence (2026-10-08):** a master merge, or a merge of another branch, makes the api and mobile `.campaign/runs` reports STALE even when no test file changed on your branch, because turbo serves cached test results and never regenerates them. Regenerate with the full suite (`cd apps/api && npx jest --maxWorkers=2`, the same in mobile) before the push.

## domain

### L-185 · 2026-09-17 · domain · B440 (report `total` repurposed, footer stopped matching its own column)

- **Symptom:** a report's `total` field was repurposed from "sum of the displayed column" to a
  pre-tax, windowed expense figure — the footer stopped equalling the sum of its own column.
- **Root cause:** one field was serving two consumers at once: a UI sum-of-column invariant and a
  cross-report reconciliation value. Changing the value for one silently broke the other, because
  nothing named which contract the field promised.
- **Lesson:** **When a report field feeds both a displayed column's own sum AND a value another
  report must reconcile against, give the two consumers separate named fields — never let one
  field serve both.**
- **Guard:** none yet — propose a regression test with a fixture where the two diverge (nonzero
  tax), asserting both formulas independently.

### L-167 · 2026-09-16 · domain · #781 (B156/B158/B170)

- **Symptom:** three separately-reported bugs all traced to the same root cause — a
  customer-list filter predicate living in more than one place.
- **Root cause:** `findAll`'s `where` clause and `exportCustomers`'s hand-rolled one had drifted
  apart, and neither was consulted by the removed-customer guard.
- **Lesson:** **When an entity has more than one read/export/guard path, its filter predicate
  belongs in exactly ONE shared builder consumed by all of them — call-site-specific copies will
  silently drift, and each drift surfaces as its own "unrelated" bug report.**
- **Guard:** shared `buildListWhere()` backs `findAll`, `exportCustomers`, and the status-change
  guards; a test asserting every consumer calls the _same_ function reference (not just a
  matching result) is flagged, not yet added.

### L-072 · 2026-09-03 · domain · wave E `imp-10b`

- **Symptom:** 4 hand-typed client mirrors of Prisma enums drifted from the schema (invented,
  renamed, or omitted values); one hid a real action and broke a list filter.
- **Root cause:** each mirror was an independently hand-typed string union — TS never compares
  two such unions to each other, so the drift compiled clean and stayed invisible.
- **Lesson:** **Never hand-declare a client mirror of a server (Prisma) enum — derive one
  const-array union per enum from a shared package and pin it set-equal to `Object.values()` of
  the real enum in a spec, never against a second hand-typed "expected" list.**
- **Guard:** `apps/api/src/common/enum-parity.spec.ts` — a generic table (40 enums) against
  `packages/types/api/enums.ts`, plus a regression layer pinning the drifted files and the
  mobile jest stub that can't `require` the shared package directly.

### L-125 · 2026-09-14 · domain · W1 billing anchor

- **Symptom:** a fix for billing-period drift was about to derive each tenant's cycle anchor from
  `TenantSubscription.createdAt`, the only date on the row — moving real charge dates for anyone
  whose row predates their subscription.
- **Root cause:** several paths create that row without subscribing, so its creation date is not
  the anchor; no column stores one.
- **Lesson:** **Never infer a money-bearing date from a column that merely happens to hold a
  date. Check every writer of the row before treating a field as the thing you need — if none of
  them means it, the honest fix is a column and a migration. Shipping half a fix beats shipping
  a wrong charge date.**
- **Guard:** the time-of-day half shipped alone; the drift half is filed, blocked on an
  `anchorDay` column. Sibling [[L-118]].

### L-223 · 2026-09-26 · domain · "one ledger writer" needs a sweep of every emit site, not the named ones (B863–B866)

- **Symptom:** after the named add-on call sites were routed through the new single ledger writer, `subscribe()` still booked add-ons with its own emit on the old live-catalog formula. Only the run's final review caught it.
- **Root cause:** the brief named the call sites, and the change declared "the single add-on ledger writer" without sweeping the tree, so an unnamed writer kept a second formula.
- **Lesson:** **Before declaring one writer for a ledger or event stream, grep the whole tree for every emit of those events and every `amountDelta:` site, not only the call sites the brief named. Route each one through the writer or exempt it explicitly.**
- **Guard:** #2186: `subscribe()` (`subscription-mutation.service.ts` :395-421 at review) was the writer the sweep missed and now calls `emitAddonDelta`. On master, `ADDON_ENABLED/DISABLED` is emitted only in `billing/addon-ledger.ts`. No structural pin yet; propose one beside `mrr-paying-predicate.parity.spec.ts`.

## security

### L-188 · 2026-09-17 · security · demo-booking OAuth/booking tokens in URL query strings

- **Symptom:** an OAuth/booking token traveled as a URL query parameter — the exact shape that
  ends up in server access logs, browser history, `Referer` headers, and analytics scripts.
- **Root cause:** a query string is the easiest place to carry a value across a redirect, but
  also the least private transport HTTP offers.
- **Lesson:** **Never carry an OAuth token, booking token, or any other bearer-shaped secret in
  a URL query string — use a fragment (`#`, never sent to the server) for a client-side handoff,
  or a POST body for a server-side one.**
- **Guard:** none yet — propose a lint/review checklist item flagging `token`/`code`/`secret`-
  named query params on any new route.

## deploy

### L-282 · 2026-10-08 · deploy · a feature PR never adds or changes tenants or rows in the shared e2e seed that runs against production

- **Symptom:** recorded by the 2026-10-08 operating review; the incident detail is in the lead's notes.
- **Root cause:** the e2e seed runs against production after every deploy, so a tenant a feature PR adds to it is created for real by the next post-deploy E2E.
- **Lesson:** **The production e2e seed gains a tenant or row only through its own reviewed PR, never inside a feature PR. Test data follows the approved test-tenant policy (CLAUDE.md "Test tenants & real-client data").**
- **Guard:** standing rule plus the e2e-seed review checklist; no script yet.

### L-184 · 2026-09-17 · deploy · #777 merged/deployed without its migration or a drift check

- **Symptom:** #777 merged and deployed with a new `migrations/` folder, but the migration was
  never applied to prod and the post-deploy drift run never happened — undetected for ~26 hours.
- **Root cause:** the standing deploy flow assumes a migration ships and gets applied together,
  but nothing gates the LANDING of a migration-carrying PR on the owner having applied it, and
  `post-deploy-check` (the thing that runs automatically) has no drift check in it.
- **Lesson:** **A PR that adds a `migrations/` folder is not LANDED until the owner has applied
  it to prod AND the drift run shows exit 0 — a migration is authorized before merge, never
  assumed to happen after. The merge coordinator checks
  `git diff --name-only <base>..<merge> -- apps/api/prisma/migrations` on every landing.**
- **Guard:** none yet — propose the merge coordinator's landing checklist running that diff as a
  hard gate, and/or folding a drift check into `post-deploy-check` itself.

### L-183 · 2026-09-16 · deploy · Railway dual-service deploy status race

- **Symptom:** a merge that changed only ONE of two Railway services showed its fresh deploy
  flip from `success` to `inactive` seconds later, reading as failed when the code had shipped
  fine.
- **Root cause:** Railway's two services share ONE GitHub deployment environment. The UNTOUCHED
  service re-posts its own `success` on its OLD sha shortly after the push (a routine re-affirm),
  and GitHub's deployment-status API treats both services' postings as one shared history — the
  untouched service's later post reads as superseding the just-shipped one.
- **Lesson:** **Never judge a Railway deploy by `.statuses[0].state` alone — that slot can be
  overwritten by the OTHER service's unrelated re-affirm within seconds. Read the full status
  history, or confirm the actually-served commit directly, before declaring a deploy failed or
  successful.**
- **Guard:** none yet — propose `post-deploy-check` reading the full status array (not just
  index 0) or verifying the served commit sha directly.


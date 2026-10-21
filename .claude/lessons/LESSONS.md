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

### L-325 · 2026-10-20 · process · every jest, type-check or DB run on a shared machine goes through the FIFO heavy slot with capped workers

- **Symptom:** subagents each ran their own jest and check-types (unit specs included), and together they pushed the PC past the 95% CPU and RAM cap.
- **Root cause:** the slot was treated as a rule for the big gates only; a "small" unit run still starts one worker per core, and several at once overload the machine.
- **Lesson:** **Every jest, check-types or DB run, unit ones too, goes through `scripts/heavy-slot.mjs` with a capped worker count. Put this in every subagent brief; a subagent that runs a test outside the slot is a defect in the brief.**
- **Guard:** `scripts/heavy-slot.mjs` (FIFO); none automatic for a bare `npx jest`.

### L-304 · 2026-10-12 · process · a suspected display gap is judged against the payload the surface receives, not the JSX that reads the field

- **Symptom:** a review reported that the staff order page's invoice card still printed a due date on a paid till sale; the follow-up spent a lane checking it. The card's `inv.dueDate` was never populated: the order read's invoice stubs are a narrow `select` with no `dueDate`.
- **Root cause:** a reviewer inferred the defect from the component's JSX; the serializer that feeds it was not read. The real gap sat on the list read, which was found only by tracing `findAll`.
- **Lesson:** **Before fixing or reporting a display gap, name the select, serializer or allowlist that feeds the field and confirm the field is in it; JSX that reads an absent field is dead code, not a defect. Then trace every OTHER read of the same document.**
- **Guard:** none automatic; the review checklist for invoice/order display changes (named select first). Cf. [[L-167]].

### L-294 · 2026-10-11 · process · a review lists every writer of a row shape before it calls that shape anomalous

- **Symptom:** a review flagged a stored row shape as an anomaly, when another legitimate writer produces exactly that shape.
- **Root cause:** the reviewer counted only the writers it had read; a row shape is only anomalous relative to ALL the code paths that can write it (create, update, import, backfill, replay), and the finding never listed them.
- **Lesson:** **Before calling a stored shape anomalous, search for every writer of that row (create, update, import, backfill, cron, replay) and list them in the finding. A shape one of them legitimately produces is not an anomaly; if none does, name the one that must have.**
- **Guard:** none automatic; the review checklist. Cf. [[L-223]] (a sweep covers every emit site, not the named ones).

### L-290 · 2026-10-10 · process · a train member that is red on its own branch does not enter the train: read each member's own latest CI before merging it

- **Symptom:** a member whose own branch had a red database spec was merged into Train 3 and had to be ejected after the train was assembled, costing a revert on the tip.
- **Root cause:** the train gate read the local checks and the assembled tip, never each member's own latest CI run on its head sha, so a red member only showed up once it was already in; the abandoned approach was "assemble first, find the reds on the tip".
- **Lesson:** **Before a member is merged into a train, read that member's own latest CI result for its exact head sha. Red, missing or stale means it does not enter, whatever the local checks said; the tip's CI is the second check, not the first.**
- **Guard:** none automatic; train assembly reads each member's own latest CI (all jobs, not just Verify) and runs its changed specs before merging it. Cf. [[L-288]]. Extended 2026-10-21: a reviewer gate run inside a builder's live worktree measured uncommitted edits. A gate result counts only from a tree verified clean (`git status --porcelain` empty) at the exact reviewed sha.

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
- **Recurrence (2026-10-17, units-v2-3):** a merge that makes a parameter REQUIRED must re-run every spec and call site that passes it on the merged tree, not only the files the PR touched; run the full check-types ratchet plus the specs that import the changed function before the train is cut.
- **Recurrence (2026-10-18, fixes-4):** members that each passed alone broke combined: one member's component began calling `useSearchParams` while another's page test mocked `next/navigation` without it (a mock misses a new hook call), and a third's picker output grew past what a Linux pipe flushes. Run the FULL web and api suites on the combined train tree, not only each member's own set.

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

### L-280 · 2026-10-08 · process · a delete-by-filter ran with an erroring age filter and removed recent files

- **Symptom:** a disk-cleanup helper meant to delete only folders older than three days deleted every unreferenced proof and handoff folder regardless of age; the files were gitignored and not recoverable.
- **Root cause:** the age filter (`find -newermt '-3 days'`) is invalid on this machine's `find`, printed an error and an empty list, and the helper read "nothing is recent" as "everything is old".
- **Lesson:** **Test any delete-by-filter on a known-recent file first and require it to be KEPT, and make an erroring or empty filter abort the whole run, never default to "old". Run the listing as a dry run and read its count before the delete.**
- **Guard:** none automated; the cleanup helper's filter check is the proposal (assert the known-recent canary survives, abort on a non-zero filter exit).
- **Recurrence (2026-10-08):** the age-filter rule also covers cleanup scripts: a cleanup script must age-filter (keep anything recent) before it deletes.

## tooling

### L-329 · 2026-10-21 · tooling · an Expo web export can reuse a shared Metro cache and bake another build's EXPO_PUBLIC_* values; export with --clear and assert the bundle

- **Symptom:** a phone proof build for #3553 from a fresh worktree, with `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_BUILD_SHA` exported, came out pointing at another lane's API (`localhost:3000`) with an empty build sha.
- **Root cause:** Metro's transform cache is shared across worktrees on one machine, and a cached transform with an earlier inlined env was reused. The export itself succeeded with no warning.
- **Lesson:** **Every Expo web export used for a proof or a deploy runs `npx expo export --platform web --clear`, then greps `dist/_expo/static/js/web/*.js` for the exact API base URL and the full build sha before any capture. A substring check like "3310" is not proof: grep the whole value.**
- **Guard:** none automatic; the sign-in screen's `build <sha7>` (`lib/build-info.ts`) is the on-screen check. Cf. [[L-265]] (stale build output in a proof).

### L-321 · 2026-10-20 · tooling · `npm ci` rewrites the shared hooks path for every worktree: install with HUSKY=0 and set the hooks path per worktree

- **Symptom:** after an `npm ci` in one worktree, commits and pushes in OTHER worktrees ran the wrong hooks (or none), because `core.hooksPath` pointed at the installing tree.
- **Root cause:** the `prepare` script (husky) writes `core.hooksPath` into the repository-wide git config, which every linked worktree shares.
- **Lesson:** **Install in a worktree with `HUSKY=0 npm ci`, and set the hooks path for that tree with `git config --worktree core.hooksPath <dir>` (needs `extensions.worktreeConfig`). Never run a bare `npm ci` or `npx husky` in a linked worktree; read `git config core.hooksPath` back in each tree before the first commit.** `HUSKY=0` is acceptable only as a one-command prefix on the install, never exported (an exported HUSKY=0 disables every hook); `npm ci --ignore-scripts` is equivalent and preferred, and the shared path must read back as the absolute shim.
- **Guard:** `scripts/check-git-hooks.mjs`; the install line in the lane runbook. Refines archived L-274 and L-254 (their `--ignore-scripts` advice stays valid; this adds the per-worktree fix). Cf. [[L-262]].

### L-309 · 2026-10-16 · tooling · a worktree git calls clean can still hold gitignored valuables; check `git status --ignored` before removing it

- **Symptom:** a worktree reported clean by `git status` was about to be removed while it held ignored files that exist nowhere else: database backups, `*.sql` dumps, `.env*` files and `graphify-out/`.
- **Root cause:** `git status` hides ignored files by design, so "clean" says nothing about untracked-and-ignored data; removal tooling that trusts it deletes them with the tree.
- **Lesson:** **Before removing a worktree, run `git status --ignored --short` and list what is ignored; copy out anything not regenerable (backups, dumps, env files, built graphs) or stop and report. "Clean" is a statement about tracked files only.** Cf. [[L-180]].
- **Guard:** none automatic; the worktree-removal step of the cleanup routine lists ignored files first.

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

## testing

### L-322 · 2026-10-20 · testing · a move-only extraction re-runs the static source-pin specs, and the pin reads the moved files too

- **Symptom:** a refactor that only moved code into new files passed a move-only review and its unit tests, then failed the pre-push run: specs that read a source file's text and assert on it no longer found the code.
- **Root cause:** a source-pin spec asserts on one named file; moving the code out makes the assertion fail (or, worse, pass vacuously when it pins an absence). A diff review of a pure move cannot see that.
- **Lesson:** **After a move-only extraction run every static source-pin and scan spec that names the touched files, and repoint each pin to read the original AND the new files (a shared source reader), so it keeps guarding the code wherever it lives. A move-only review does not replace the run.**
- **Guard:** none automatic; pins that walk the tree through `apps/api/src/testing/source-scan.ts` survive a move, single-file pins do not. Cf. [[L-205]].

### L-323 · 2026-10-20 · testing · a changed-since pre-push skips repo-wide static scans, so a train gate runs them in full

- **Symptom:** a branch passed the fast pre-push (`--changedSince`) and a repo-wide static scan (such as the accessible-labels scan) then failed on the train tip.
- **Root cause:** an affected-only run selects specs by the files a branch touches; a scan that walks the whole repo has no dependency edge to the changed file, so it is never selected.
- **Lesson:** **Treat the fast or affected run as a convenience, not a gate. A train or merge gate runs the repo-wide scans in full (`FULL_VERIFY=1`) on the landing tree, whatever the members ran alone.**
- **Guard:** `FULL_VERIFY=1` in the train gate; none automatic for a single branch. Cf. [[L-290]]. Extended 2026-10-21: a builder's targeted gate (touched specs only) missed three whole-source structural pins in one night (an "only N callers" billing pin, an "every DB-writing script is guarded or exempt" guard, a mobile source-regex pin), because pins live outside the touched files. Before reporting, a builder runs the WHOLE jest of every touched workspace (through the heavy slot, [[L-325]]).

### L-324 · 2026-10-20 · testing · a long serial DB spec lane is run in batches, never one Jest process

- **Symptom:** the DB-backed lane (about 325 suites run serially) was killed with an out-of-memory error at roughly 130 suites on the Mac mini.
- **Root cause:** one Jest process keeps module registries and Prisma clients across suites, so memory grows with the suite count until the machine kills it.
- **Lesson:** **Run the DB lane in chunks (a fixed number of suites per Jest process, each against the same migrated database), and treat an OOM at a stable suite count as a batching problem, not a flaky test. Re-run only the failed chunk.**
- **Guard:** none automatic; the chunked invocation in the lane runbook.

### L-326 · 2026-10-20 · testing · a migration that retires a known edge updates, in the same train, every spec that pins the edge's old behavior

- **Symptom:** after a column widen retired a rounding edge (B296, a 4-dp rate), a spec that asserted the old 4-dp clamp stayed in the tree; it was green on its own branch and red only on the combined R5 tree.
- **Root cause:** the pin lived in a different branch from the migration, so neither branch's run held both the new column and the old assertion, and a diff review cannot see a spec that asserts a behavior the migration removed.
- **Lesson:** **When a migration retires a known edge (a widen, a dropped clamp, a new constraint), grep the specs for the edge's bug id and its old literal values in the same train and update each pin to the new rule; the pin goes red only on the combined tree, so run it there before the push.**
- **Guard:** none automatic; the train gate runs the full suite on the combined tree (cf. [[L-264]], [[L-323]]).

### L-327 · 2026-10-20 · testing · a more specific refusal added ahead of an existing guard is grepped against every spec that pins the old generic code

- **Symptom:** a new coded refusal (a bill with cash payments, BILL_HAS_PAYMENTS) was added ahead of the generic state guard; race and concurrency specs that pinned the old generic code then failed on the combined tree.
- **Root cause:** those specs asserted the old error code as a stand-in for "the second writer lost"; the new guard fires first on the same input, so the invariant still held but the expected code was stale.
- **Lesson:** **When a new guard or error code is inserted ahead of an existing one, grep the specs for the old code and update each; keep the invariant the spec proves (one writer wins, nothing written) and change only the expected code, never loosen the assertion to accept any error.**
- **Guard:** none automatic; the train gate runs the full suite (cf. [[L-264]]).

### L-320 · 2026-10-18 · testing · pin the mouse path of a button inside a clipped scroll wrapper, not only the keyboard path

- **Symptom:** K11-16: saving with a real mouse click at desktop width left the saved-line 64 px short of its place, while Ctrl+S and Enter, which never move the pointer, looked correct.
- **Root cause:** a real click focuses and scrolls its button into view; inside an `overflow: hidden` wrapper the browser can still scroll that wrapper, which the keyboard path never triggers. An unit test with `fireEvent.click` does neither.
- **Lesson:** **For a control inside an overflow-hidden or sticky region, the e2e drives the REAL mouse click and asserts the scroll offset and the position of what the action reveals, in addition to the keyboard path. A synthetic click proves the handler, not the layout.**
- **Guard:** `k11-l2-saved-line.spec.ts` (mouse Save at 1440; currently marked `test.fail` until the fix lands).

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
- **Guard:** none automatic; the install order in [[L-254]] (`npm ci --ignore-scripts`, `prisma generate`, build `packages/*`), `npm run local:drift` against the compose DB, and the executed-query rule. Cf. [[L-176]]. Extended 2026-10-21: a DB-backed spec that needs reference data (a published plan catalog) passed on a seeded dev database and failed in CI's fresh replay database. A DB spec seeds the reference data it needs through the shipped idempotent publishers, behind the local-DB guard, and is proved once against an empty migrated database.

### L-276 · 2026-10-07 · testing · a scoped jest run leaves a partial campaign report, and a jest path argument is a regex

- **Symptom:** a push carried a campaign report listing only a handful of specs, and turbo's cached test replay did not rewrite it; a scoped run of `app/(dashboard)/...` matched nothing and looked green.
- **Root cause:** `npx jest <spec>` in a workspace overwrites that workspace's report with the partial run, a cached replay writes nothing, and a path pattern is a REGEX, so unescaped parentheses match no file.
- **Lesson:** **After any scoped jest run, regenerate the full workspace report before pushing. Escape or avoid regex characters in a path pattern and check the `Tests:` count is plausible before trusting a pass.**
- **Guard:** none automatic; read `Tests: N` from the run and compare the report's spec count to the workspace's.
- **Recurrence (2026-10-08):** a master merge, or a merge of another branch, makes the api and mobile `.campaign/runs` reports STALE even when no test file changed on your branch, because turbo serves cached test results and never regenerates them. Regenerate with the full suite (`cd apps/api && npx jest --maxWorkers=2`, the same in mobile) before the push.

## domain

### L-330 · 2026-10-21 · domain · an origin or state is derived from structured fields, never from a free-text note prefix

- **Symptom:** office-recorded partial deliveries were recognised by a marker at the start of the evidence note. Rows written before the marker existed were stranded, and anyone could type the marker into a note to be treated as the office.
- **Root cause:** semantics were encoded in free text. A prefix test misses every historical row that lacks it and trusts whatever a user can type.
- **Lesson:** **Derive origin and state from structured fields (route stop id, driver id, type) that only the intended writers set. When no structured field can tell, add a column; never parse a note.**
- **Guard:** `orders/office-evidence-completion.ts` tests a null route stop and no driver; its spec includes a clerk-typed note that must still complete. Cf. [[L-294]].

### L-331 · 2026-10-21 · domain · rate inference prefers the configured rate when it reproduces the stored figure, then the shortest precision

- **Symptom:** an edit or a duplicate of an invoice re-billed lines at a non-round rate (8.88% for a tenant that charges 8.875%), and a half-way rate (8.625%) was stored one unit off.
- **Root cause:** the inference took the nearest higher-precision rate that fit the stored tax instead of the tenant's configured rate, and rounded a float product (8.625 / 100 * 1e4 is 862.4999999999999) without snapping it first.
- **Lesson:** **Infer a rate in this order: the configured rate when the single totals builder reproduces the stored figure to the cent, then the shortest precision that does. Snap a float product to the stored precision before `Math.round`.**
- **Guard:** `packages/pricing/src/inferred-flat-rate.ts` (`preferredRate`) and `tax-precision.ts` (`sameRateAtLegacyPrecision`), pinned in `packages/pricing/src/pricing.spec.ts` and `invoices.duplicate-tax-rate.spec.ts`.

### L-317 · 2026-10-18 · domain · removing a whole-catalog fetch (limit=0) from a picker is a behavior change; prove what each consumer needs first

- **Symptom:** the product-k11 train swapped `limit: 0` reads for per-line or server-searched reads on several pickers. Two swaps (the promotions picker, the purchase-order detail) broke a consumer that needed the full set and were reverted; the products-list categories and inventory pickers, which only needed distinct values, kept the swap.
- **Root cause:** a `limit: 0` read feeds more than the dropdown: a guard scanning every product, a lookup of lines the page did not request, a picker that must show items before any search. The cost was visible, the other readers were not.
- **Lesson:** **Before replacing a fetch-all with a narrower read, list every consumer of that data on the page and name what each needs (distinct values, a few rows, the full set). Swap only where the narrow read serves all of them; keep a deliberate fetch-all with a comment naming the consumer, and give each swap its own revert-able commit.**
- **Guard:** none automatic; the remaining fetch-alls carry a DELIBERATE comment naming their consumer (products, promotions, purchase-orders, suppliers pages). Cf. [[L-167]].

### L-305 · 2026-10-12 · domain · wrapping write controls in a gate covers only the controls someone wrapped; sweep the rest by search and pin the list

- **Symptom:** after the read-only gate shipped (WriteButton/WriteLink, a refusal notice in the shared Modal slot), UX re-runs still found raw write controls, hand-rolled dialogs and a driver shell with no notice; each was a separate P2.
- **Root cause:** the gate is opt-in per control and the notice rides a component slot, so anything not built on those components is outside it; the API side had a registry plus a route-walk pin (SA-776), the web side had neither.
- **Lesson:** **When a gate or notice is delivered by wrapper components, enumerate the surfaces by search (raw buttons that post to write routes, `role="dialog"` markup outside the shared Modal) and pin the list in a spec; state plainly which surfaces are knowingly outside it.**
- **Guard:** none automatic yet; propose a static scan on the web like the API's route-walk pin. Known gaps recorded: hand-rolled dialogs; the driver banner shows only after a refused write (no driver-readable status). Cf. [[L-225]].

### L-300 · 2026-10-12 · domain · an edit screen freezes its diff baseline at edit-open and re-bases only on an explicit reload

- **Symptom:** an edit screen sent every line on save after a background refetch, re-writing untouched lines and reverting another writer's change made in between.
- **Root cause:** the diff of "what changed" was computed against the live query data, so a refetch silently moved the baseline under the user's edits.
- **Lesson:** **Snapshot the server state when editing starts and diff only against that snapshot; send just the fields the user touched. A refetch while editing never re-bases the draft: offer an explicit reload, and let the server reject a stale revision.**
- **Guard:** none automatic; review checks that a save payload is built from the frozen baseline. Cf. [[L-167]].

### L-301 · 2026-10-12 · domain · a revision or guard value is written in the same transaction and lock as the check that reads it

- **Symptom:** two concurrent writers both passed a revision check and both committed, because the new revision value was appended after the first transaction committed.
- **Root cause:** check and write were separate steps, not one atomic compare-and-set under the row lock.
- **Lesson:** **Read the guard value after taking the lock, compare, and write the new value in that same transaction. A guard stamped after commit is a log, not a guard.**
- **Guard:** none automatic; DB specs that race two callers against one row. Cf. [[L-239]].
- **Recurrence 2026-10-18 (B1234):** the delivered-line lock ran on the locked rows but decided whether it applied from the order status read before the lock, so a delivery landing in between skipped it. Applicability is guard state too: read it under the lock. Unit + DB stale-read cases now pin it.

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

### L-328 · 2026-10-21 · security · a same-origin form POST under `Referrer-Policy: no-referrer` sends `Origin: null`; an Origin-equals-Host check then refuses every login

- **Symptom:** after the control dashboard set `Referrer-Policy: no-referrer`, every login was refused with 403, although the page and the form were on the same host.
- **Root cause:** browsers send `Origin: null` on a form POST when the referrer policy is `no-referrer`. The CSRF check compared the `Origin` header with the served host, so the literal "null" never matched (`apps/control/src/http/headers.ts:13`, `originOk` before `POST /login` in `apps/control/src/http/server.ts`).
- **Lesson:** **A strict Referrer-Policy changes what `Origin` a form POST carries. An Origin-equals-Host check must either accept `Origin: null` only when `Sec-Fetch-Site: same-origin` is also present, or the page must not use `no-referrer` for its own forms. Test the real form submit in a browser, never a hand-built request with a correct Origin.**
- **Guard:** none automatic yet; prove any CSRF or header change with a browser form submit. Fixed in `apps/control` (`Referrer-Policy: same-origin`; `originOk` accepts `Origin: null` only with `Sec-Fetch-Site: same-origin`), pinned by `apps/control/test/login-origin.spec.ts`.

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


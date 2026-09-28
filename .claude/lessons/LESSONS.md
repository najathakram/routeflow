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

### L-209 · 2026-09-19 · process · read the shared review channel immediately before every merge

- **Symptom:** three PRs were squash-merged on green CI plus an in-session review while an
  independent reviewer had already posted a ship-after-fixes verdict with blockers on the shared
  coordination issue minutes earlier. The blockers (a prod E2E gate that goes red on unseeded
  fixtures, a script that sent live-tenant addresses to a third party before its test-tenant
  gate, a vendor verdict accepted without checking its inferred components) landed on master and
  needed fix-forward PRs plus a manual prod re-seed.
- **Root cause:** the merge gate checked CI plus one commissioned review, not the channel where
  independent reviews are posted — a green CI cannot see a blocker that lives in prose.
- **Lesson:** **A merge gate must include a fresh read of the shared review channel for that
  specific PR — re-fetch it and filter for REVIEW / BLOCKED / HOLD lines naming the PR,
  immediately before `gh pr merge`, not once at window open. Any unresolved blocker line, or a
  REVIEW line newer than the last commit reviewed, holds the merge.**
- **Guard:** landing-coordinator routine step "read the coordination issue for REVIEW lines on
  this PR" before each merge (no code guard).

### L-208 · 2026-09-19 · process · stacked PRs and `--delete-branch`

- **Symptom:** squash-merging a stack parent with `gh pr merge --delete-branch` deleted its head
  branch, which auto-CLOSED the child PR whose base was that branch; the child could not be
  retargeted until the base branch was restored and the PR reopened. Separately, after the
  parent's squash the child's branch still carried the parent's pre-squash commits, so it showed
  DIRTY/CONFLICTING against master.
- **Root cause:** GitHub closes (does not retarget) an open PR when its base branch is deleted,
  and a squash rewrites the parent's commits so the child's history no longer matches master.
- **Lesson:** **Merge stack parents WITHOUT `--delete-branch`. Retarget each child to master
  (`gh pr edit N --base master`) BEFORE deleting anything, then have the child's owner merge
  master in (taking master's side for the parent's files) and re-run CI on the fresh head.
  Delete branches only after every child is retargeted.**
- **Guard:** landing-coordinator checklist (no code guard); see [[L-190]] for the sibling
  rebuild-after-squash trap.

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

### L-228 · 2026-09-27 · process · a merge train must leave master's tree equal to the tree that was verified (train A)

- **Symptom:** a train of 14 PRs merged `--no-ff` and verified as one head (tree e98a41e8) was landed as a single squash; nothing but a deliberate check said the squash equalled what had been tested.
- **Root cause:** a squash-merge builds its own tree from the PR diff against the current base, so anything that moved on master after the train was built (or a hand-resolved conflict) changes what lands without changing what was verified.
- **Lesson:** **Land a train only after its head is verified and any hand hunk (import unions, ratchet rows) is confirmed against the merge-tree; after the squash, compare `git rev-parse origin/master^{tree}` with the verified tree and stop on any difference.**
- **Guard:** the train PR body states the expected tree; the landing coordinator runs the comparison (train A: master's tree equals e98a41e8, checked). Dropped PRs are named with their reason so they re-enter the next train. Cf. [[L-197]].

### L-230 · 2026-09-22 · process · a verification framed as "is my work safe" answers itself by construction

- **Symptom:** on the #1219/#1221 merge rehearsal, the forward probe (revert only #1221's own fix,
  confirm its own cases fail) passed and looked complete. The reverse probe (revert the OTHER
  side's fix, confirm THEIR cases fail) found #1221's fix had no guard in the DEFAULT Jest lane —
  reverting it left all 395 unit tests green.
- **Root cause:** "is my work safe" is answered the moment your own side passes, so it stops there
  by construction — it never asks whether the merge weakened anything ELSE.
- **Lesson:** **Frame a merge verification as "did this change weaken anything", symmetric: revert
  YOUR change on the merged tree and confirm your cases still fail, then revert THEIRS and confirm
  theirs still fail.** A missing guard is silent in the direction that matters — green suite, more
  test files, every signal points the right way. Structural fix, not "review harder": a fix guarded
  only by a DB-lane spec must ALSO carry a default-lane pin — the DB spec proves it against real
  transactions, the unit pin proves it still exists after a merge that doesn't re-trigger the DB
  lane (it fires on ADDING a `.db.spec.ts`, not on changing the logic it protects).
- **Guard:** #1221's added default-lane pin; the default-lane-pin requirement for any
  DB-lane-guarded fix going forward.

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

## tooling

### L-206 · 2026-09-18 · tooling · a test that pins a literal from another workspace's prose is an invisible cross-workspace coupling

- **Symptom:** `docs-truth.spec.ts` (in `apps/api`) hardcoded the lessons-register byte cap as a
  second literal, mirroring `.claude/lessons/_meta.json`'s value. Editing that JSON file (a
  docs-only change in a different part of the repo) broke this API-workspace spec and took CI
  down repo-wide — nothing signalled that an unrelated API test would fail.
- **Root cause:** a test asserting "doc X says N" by hardcoding N itself creates a coupling
  invisible from either side — the doc's author has no reason to grep `apps/api` before editing
  a `.claude/` config file, and the test's author has no reason to expect the doc to ever
  change.
- **Lesson:** **A test that pins a literal sourced from a prose document or config file elsewhere
  in the repo must read that value at test time, never re-type it as a second hardcoded literal —
  and because of this, a "docs-only" change is NOT exempt from the full verify chain whenever it
  touches a value some other workspace's test might have pinned. Grep for the literal itself
  (not just the file) across every workspace before treating a docs edit as safe to skip CI on.**
- **Guard:** `docs-truth.spec.ts` now reads `_meta.json.maxBytes` dynamically (#889); no repo-wide
  grep-for-pinned-literals check exists — propose one in the docs-only-push exemption logic.
- Renumbered from L-199: an unrelated "dead CSS" lesson landed on master at that id via #909.

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
- **Guard:** none yet — propose a `bugs.mjs renumber <old> <new>` command doing the safe remap
  atomically, or a self-test asserting `index` refuses/warns on a renamed fixture.

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

### L-180 · 2026-09-16/22 · tooling · npm/dir junctions across worktrees are unsafe near git worktree ops (recurred: 2026-09-22)

- **Symptom:** (a) after `git worktree move`, invalid-hook-call errors and mangled Jest paths;
  (b) a scratch worktree junctioned to a SIBLING's `node_modules` (to dodge `npm install` under
  disk pressure), then `git worktree remove --force` on the scratch tree cascaded a recursive
  delete through the junction, wiping the sibling's `node_modules` and ~2,388 tracked files.
  RECURRED 2026-09-22: a PC reviewer agent's own worktree-cleanup `git worktree remove --force`
  followed the SAME shape into the main checkout's `node_modules/@routeflow/*` links (which
  point back into `apps/` and `packages/`), deleting 2,814 tracked files there.
- **Root cause:** Windows npm junctions are absolute-path reparse points, invisible to git and
  not junction-aware to a naive recursive delete — `worktree move` leaves one pointing at the OLD
  path forever; `worktree remove --force`/`rm -rf` walks THROUGH one into its real target.
- **Lesson:** **Never let a junction outlive the git worktree op around it. After
  `git worktree move`, treat `node_modules` as stale — `npm ci` (+ `prisma generate` for
  apps/api) at the final path. Before removing/recursively deleting ANY worktree, prove no
  junction remains (`dir /AL` or check `LinkType`), then unlink each one individually with
  `cmd /c rmdir <link>` (no `/s`, which recurses through it) — never a bare `rm -rf`/
  `--force` on a tree that might still hold one. Best: never junction `node_modules` between two
  DIFFERENT live worktrees — the disk saved isn't worth the blast radius, and reviewer/audit
  agents (whose job is to read, not build) should run read-only against the target checkout with
  no worktree of their own at all.**
- **Guard:** still none automated after two incidents — the proposed pre-remove check (refusing
  `git worktree remove` while a junction exists under the tree, or a post-move check comparing a
  junction's target to cwd) has not been built either time. Interim guard until it is: reviewer
  agent prompts/instructions carry the read-only, no-worktree rule explicitly. Recovery from a
  hit: `git ls-files --deleted -z -- <dirs> | xargs -0 git restore --`, then confirm
  `git ls-files --deleted` is empty and diff clean before resuming any work in that checkout.

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

### L-235 · 2026-09-27 · tooling · a tsconfig that excludes specs also switches off the test runner's type-check (#1315, B806)

- **Symptom:** a spec fixture built with the wrong shape (#1286's `taxNone = () => 0`) reached CI
  green; once #1315 finally compiled the api specs, ~7,000 spec type errors surfaced, 6,328 of
  them masked by one wrongly typed mock factory (`createMockPrisma`).
- **Root cause:** `apps/api/tsconfig.json` excluded `*.spec.ts` from `check-types`, and ts-jest
  (`isolatedModules`, transpile-only) read the same config, so neither gate type-checked a spec —
  each assumed the other did.
- **Lesson:** **When a type-check config excludes tests, find which gate type-checks them instead;
  a transpile-only test runner (`isolatedModules`, SWC, babel) checks nothing. If no gate does,
  add one — ratchet an existing error count down (shrink-only baseline) rather than wait for
  zero.**
- **Guard:** api `check-types` runs `scripts/check-types-ratchet.mjs` over src + specs (src
  zero-tolerance, per-spec counts in `check-types.spec-baseline.json`, which only
  `--lower-baseline` moves); `scripts/lib/check-types-ratchet-core.mjs` refuses a
  `// @ts-nocheck` spec (`isNoCheckFile`).

## testing

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

### L-218 · 2026-09-25 · testing · a red-proof that matches message TEXT can be vacuous (B861)

- **Symptom:** the red-proofs AB/AD passed on the OLD code, so they proved nothing about the fix.
- **Root cause:** they matched `/reload/`, which the pre-existing 409's message also contains, so the
  wrong error satisfied the assertion.
- **Lesson:** **Assert by error CLASS or code, never by message text another error can share. Run the
  proof against the old code and confirm it fails for the intended reason.**
- **Guard:** `REG-B861-AB`/`AD` assert `BadRequestException`.

### L-226 · 2026-09-27 · testing · a money fixture must be shaped by the production writer (#2274, #2245, #2305)

- **Symptom:** ledger and unit-line specs built rows by hand in shapes the writer never produces (credit overshoot legs the per-line and header caps would refuse; quantities not in base pieces), so they proved a state that cannot exist and could miss the one the writer can.
- **Root cause:** a hand-built fixture encodes the author's model of the writer, not the writer's output; the spec can only agree with the model (cf. [[L-220]]).
- **Lesson:** **Build every money or unit fixture with the production writer (or copy its exact shape: base-piece qty, `net + tax` amounts, the maps it stores). Before asserting an overshoot or edge state, confirm the writer can reach it; if only a downstream clamp stops it, test that clamp.**
- **Guard:** review checks each fixture against the writer's call site (train A: `credit-notes.service.ts` caps, `returns.service.ts` return maps); `regulated-ledger-price-correction.db.spec.ts` drives the real writers.

### L-234 · 2026-09-27 · testing · a whole-database script needs an explicit scope allowlist, not a rerun (B824, train C)

- **Symptom:** `publish-and-repin.db.spec.ts` failed three different ways under `--maxWorkers=2` — an unrelated tenant tripped `--only-test-tenants`'s refusal, an unscoped `--apply --live` wrote onto a sibling spec's own fixture tenant, and this spec's fixture received unwanted writes back — each time green when run alone, so it read all night as "a known flake, verify alone before treating as a blocker."
- **Root cause:** `publish-and-repin.mjs`'s `computeDiff()` correctly scans the WHOLE database for a real prod run, but under parallel jest workers it also picks up sibling `*.db.spec.ts` files' own live fixture tenants — real cross-suite contamination, not a stale-count race a retry masks. Running it alone "fixes" all three by removing the siblings, which is exactly why that green is not a safety signal.
- **Lesson:** **A `*.db.spec.ts` (or script) that computes a diff/apply, or any read+write, over a shared, unscoped table under parallel workers must scope every call to its own fixture rows (an id/slug allowlist flag on the tool it drives). "Green alone, red in the full lane" for such a spec means look for a missing scope, not a flake to rerun past.**
- **Guard:** `publish-and-repin.mjs --only-tenants <slugs>`; `publish-and-repin.db.spec.ts`'s `runCli()` passes its own 3 fixture slugs on every call (report, preview, live apply).

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

### L-170 · 2026-09-16 · domain · #743 fix round F3 (roundMoney before comparison)

- **Symptom:** a fully-settled invoice rendered a red "Balance Due $0.00" badge instead of the
  green paid state — the number was right but its color-coding read non-zero.
- **Root cause:** the balance summed three independently-derived floats before subtracting from
  total; the color-coding ran on that raw sum, where a sub-cent float remnant survives `Math.max`
  and still reads non-zero. `roundMoney` was applied only at display-formatting time.
- **Lesson:** **`roundMoney` must wrap a sum of independently-derived floats BEFORE the value
  drives any comparison or branch — color-coding, `>0` checks, conditional rendering — never
  only where it's formatted for display.**
- **Guard:** `invoices.service.ts`'s two `balanceDue` sites and the PDF template now wrap in
  `roundMoney()` before the comparison. Also fixed at `customers.service.ts`'s
  `applyAdvancePaymentToInvoiceLocked` (#814), same class.

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

### L-119 · 2026-09-13 · process · F38 round 4

- **Symptom:** an independent pre-merge review found a door quote collecting excise on cancelled
  and already-delivered lines — after three in-lane review rounds had passed that code.
- **Root cause:** the two halves of one money figure came from differently filtered line sets;
  each file read correctly alone, so the defect lived only in the seam between them.
- **Lesson:** **Both halves of one money figure must derive from ONE collection — pass the
  filtered array, never re-derive the filter at the second call site. A reviewer inside the lane
  is the wrong instrument for a seam; it takes an independent pre-merge pass to see across two
  files that are each individually right.**
- **Guard:** REG-B305 round 4 + the source pin `short-pick-category-tax.pins.test.ts`.

### L-124 · 2026-09-13 · domain · cron sweep silently dropped null-tenant orders

- **Symptom:** a cron grouped pending orders by `(customerId, tenantId)` and filtered on
  group-count > 1; a customer with one real-tenant order and one legacy null-tenant order
  produced two separate one-row groups, both filtered out before the null-tenant branch ever
  ran — nothing merged, nothing logged.
- **Root cause:** the null-tenant warn lived only inside the per-group loop, downstream of the
  count filter, so a lone null-tenant row beside a lone real-tenant row for the same customer
  was invisible to both the merge and the log.
- **Lesson:** **A cron or bootstrap entry point has NO ambient tenant: group the work by
  tenantId first and run each group inside `tenantCtx.run(tenantId)`; `forTenant()` silently
  returns the unscoped client otherwise. Rows without a tenant must be skipped AND counted,
  never dropped silently.**
- **Guard:** `REG-B323` — a dedicated unscoped groupBy on null tenantId runs alongside the main
  query and counts every null-tenant customer regardless of their real-tenant group's count;
  the sweep's return shape carries the count as `skipped`.

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

### L-143 · 2026-09-15 · domain · B421 (credit-applied vs paid, full fix)

- **Symptom:** a CREDIT_NOTE-method payment (`status: PAID`) rendered/counted as cash everywhere
  a "Paid"/"received" figure was shown — invoice totals, PDF, buyer portal, mobile, every
  bookkeeping cash-flow figure.
- **Root cause:** the one shared confirmed-payment predicate answered "is this confirmed"
  (status), necessary but not sufficient for "is this cash" — nothing distinguished the two
  questions, so every consumer answered both with the same number.
- **Lesson:** **A "paid"/"received" DISPLAY figure is cash-only (excludes CREDIT_NOTE; ADVANCE
  stays in, since its application is the only place cash is ever recorded) — but
  balance/status/outstanding figures keep the FULL confirmed total, since a credit note or
  advance genuinely settles what's owed. Two questions, two filters, ONE shared predicate.**
- **Guard:** `@routeflow/pricing`'s `splitConfirmed`/`resolveConfirmedAmounts`/
  `RECEIVED_METHOD_FILTER`/`CASH_METHOD_FILTER` are the one implementation api/web/mobile import
  — never re-derive either filter at a second site.

### L-159 · 2026-09-15 · domain · B421 (PDF + web-detail rounds, independent review)

- **Symptom:** a PDF template's fallback re-derived `totalPaid`/`creditApplied`/`advanceApplied`
  independently, each gated on its OWN `!= null` check — a caller passing an old,
  credit-inclusive `totalPaid` alone got the other two re-split from raw payments too,
  double-subtracting. A web page reinvented the identical bug independently right after.
- **Root cause:** three related figures each checked their own presence instead of sharing ONE
  gate, so a partially-precomputed payload silently mixed two inconsistent bases.
- **Lesson:** **When a fallback re-derives several related figures from raw data, gate ALL of
  them on ONE presence check, never per-field — a caller must get either the full precomputed
  set or the full re-derived set, never a mix.**
- **Guard:** `payment-predicates.ts`'s `resolveConfirmedAmounts(precomputed, payments)` and the
  web mirror both gate on one field's presence; each has a red-first regression test pinning
  the double-subtraction case.

### L-221 · 2026-09-26 · domain · retry a whole idempotent tx on a conflict through ONE shared predicate (SA-269)

- **Symptom:** none observed in production: a design rule set by SA-269/SA-340 when #2152 added a transaction retry, so callers would not each invent their own conflict test.
- **Root cause (of the risk):** the conflict shapes differ across Prisma and pg (40001, 40P01 in every Prisma/pg shape, P2034, TransactionWriteConflict), so a per-caller classifier matches a subset or retries a business error.
- **Lesson:** **Retry the WHOLE transaction (each attempt re-takes its first lock) on a write conflict, classified by one shared predicate (`common/tx-retry` `txConflictState`). An HttpException is never a conflict.**
- **Guard:** `REG-SA269-1/2/3` in the tx-retry specs.

### L-222 · 2026-09-26 · domain · a line's unitPrice and unitsPerBox are ONE denomination (SA-330)

- **Symptom:** a rolled-over next-delivery line was split and priced at the LIVE product pack, so after a repack it was re-split and re-priced from the source line.
- **Root cause:** the copy carried the price without its pack, or the pack without its price; a live price converted to an old pack is a second pricing formula.
- **Lesson:** **When a line is copied, snapshot BOTH unitPrice and unitsPerBox or neither. Carrying the pack with a live price under-bills after a repack; converting a live price to an old pack is refused.**
- **Guard:** `next-delivery-pack.db.spec.ts` (a repack with a price change, plus an AT_STOP vs NEXT_DELIVERY parity pin).

### L-223 · 2026-09-26 · domain · "one ledger writer" needs a sweep of every emit site, not the named ones (B863–B866)

- **Symptom:** after the named add-on call sites were routed through the new single ledger writer, `subscribe()` still booked add-ons with its own emit on the old live-catalog formula. Only the run's final review caught it.
- **Root cause:** the brief named the call sites, and the change declared "the single add-on ledger writer" without sweeping the tree, so an unnamed writer kept a second formula.
- **Lesson:** **Before declaring one writer for a ledger or event stream, grep the whole tree for every emit of those events and every `amountDelta:` site, not only the call sites the brief named. Route each one through the writer or exempt it explicitly.**
- **Guard:** #2186: `subscribe()` (`subscription-mutation.service.ts` :395-421 at review) was the writer the sweep missed and now calls `emitAddonDelta`. On master, `ADDON_ENABLED/DISABLED` is emitted only in `billing/addon-ledger.ts`. No structural pin yet; propose one beside `mrr-paying-predicate.parity.spec.ts`.

### L-225 · 2026-09-26 · domain · a display fix proven on one screen must become a shared helper, or sibling screens reproduce the same bug (B653, B757-B759)

- **Symptom:** the invoice-detail screens' qty/unit-label formatting bug (#1275) reappeared,
  unfixed, on both order-detail screens (web's `OrderLineItemsTable`, mobile's operator and
  customer order detail) — each had hand-formatted a boxed line's qty text inline instead of
  reusing the already-proven fix, so a `unitLabel`'d line (Case, Pallet) still showed a bare
  boxes/pieces split and a factor-1 unit line skipped unit display entirely.
- **Root cause:** the first fix landed as inline logic on the screen it was reported against,
  not as a shared helper — nothing forced every OTHER screen rendering the same kind of line to
  pick it up, so each sibling screen kept its own copy of the original bug.
- **Lesson:** **When a display/formatting bug is fixed on one screen, extract the fix into a
  shared helper and audit every sibling screen rendering the same data shape for the same bug —
  a proof against one screen is not a proof against its copies.**
- **Guard:** `apps/*/lib/invoice-line-display[.ts]`'s `usesUnitDisplay`/`invoiceLineQtyText` is
  now the one qty-text formatter, imported by all four affected screens; a `describe.each` wiring
  test (`order-detail-unit-display-wiring.test.ts` / its web equivalent) pins the same import and
  condition across every one of them.

### L-232 · 2026-09-27 · domain · a calendar-day field keeps the client's literal day, never a re-derived one (#2249, train B)

- **Symptom:** `invoices.service.ts` stored `new Date(dto.issueDate)` raw, so a client datetime with a time component or offset crossing a UTC day boundary (e.g. `23:30-04:00`) silently landed one day later — breaking the UTC-midnight symbolic convention that statements, the regulated report and sales-facts buckets all assume.
- **Root cause:** the field is a day-granular calendar stamp, not a real instant, but the write path treated the client's string as an instant and let the day move with it. An earlier version made it worse by re-reading in the tenant timezone.
- **Lesson:** **A DTO field documented or consumed as a calendar day (statements, invoices, schedules) must be normalized at the write boundary through a literal first-10-characters day extractor — never `new Date(rawString)` directly, and never re-derived from a timezone. A shape that names no real day is a 400, checked before anything else is read.**
- **Guard:** `common/calendar-date.ts`'s `calendarStampFromInput`/`issueDateStamp`, called as `InvoicesService.create()`'s first statement; `calendar-date.pins.spec.ts`, `invoice-issue-date-b2197.db.spec.ts`. Cf. the F25 calendar-date convention (archived L-047) — this is the same house rule recurring at a new call site.

### L-237 · 2026-09-28 · domain · a side effect fired inside a transaction still fires when it rolls back (#2526)

- **Symptom:** invoice realtime events told operators and buyers about changes whose transaction
  later rolled back, or was retried.
- **Root cause:** gateway emits are fire-and-forget; helpers called from a transaction body
  emitted directly, so nothing tied the send to the commit.
- **Lesson:** **A side effect that cannot be rolled back (socket emit, email, webhook, queue push)
  is queued inside the transaction and flushed only after it commits: a rejected transaction
  flushes nothing, and a retried attempt resets the queue first. Pass the queue into every helper
  the transaction body calls, and pin it with a tripwire that fails on a direct emit.**
- **Guard:** `common/after-commit.ts` (`AfterCommit`, `withAfterCommit`), `after-commit.spec.ts`,
  `invoices/emit-after-commit.tripwire.spec.ts`. Cf. [[L-221]].

### L-238 · 2026-09-28 · domain · an undefined key in a Prisma `where` is dropped, widening the match (#2573)

- **Symptom:** a per-line CANCEL/DELETE edit with no line id built `{ id: undefined, orderId }`;
  Prisma dropped `id`, so the write matched every line of the order.
- **Root cause:** Prisma treats an `undefined` filter value as "no condition", not "match
  nothing", so a missing value silently widens a narrowing `where`.
- **Lesson:** **Never build a narrowing `where` from an optional value. Refuse the missing value
  before the query (a 400/404), and scope every targeted write by the key AND its parent
  (`{ id, orderId }`), so a hole in the scope can only fail loudly, never widen.**
- **Guard:** `orders/order-line-removal.ts` (`writeLineRemoval`, `assertRemovalsNameALine`),
  `order-line-removal.spec.ts`, `order-line-removal.db.spec.ts`.

### L-239 · 2026-09-28 · domain · a guarded destructive write: lock, then read, then compare-and-set (#2566, #2584, #2594, #2607)

- **Symptom:** customer deletes destroyed issued/paid invoices, money records and delivery
  history; `updateTenantClass` booked its BillingEvent from a read taken before its lock; an
  insert landing after the last read turned the final delete into a 500.
- **Root cause:** deciding reads taken before the lock (or only outside the transaction), deletes
  keyed on the parent id alone, and table lists that differed between the guard and the delete.
- **Lesson:** **For a destructive or money-booking write gated on business state: take the row
  lock, read the deciding state AFTER it, make each destructive statement a compare-and-set that
  expects the guarded row set and throws 409 on a mismatch, drive the pre-flight, the in-tx
  re-check and every delete from ONE list of protected tables, and map a late insert's FK
  violation to the same 409. A pre-flight outside the transaction is UX, not protection.**
- **Guard:** `customers/customer-delete-preflight.ts` (`assertNoBlockingInvoices`,
  `readInvoicesAssertingNoneBlocking`, `deleteNonBlockingInvoicesCas`, `deleteMoneyRecordCas`,
  `deleteCustomerRowsFkRaceAs409`); `customer-delete-race-2558.db.spec.ts` (a real second
  connection), `customer-delete-money-records-2587.db.spec.ts`,
  `customer-delete-fk-race-2572.db.spec.ts`; `common/update-tenant-class-ledger.db.spec.ts`.
  Cf. [[L-217]], [[L-221]].

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

### L-219 · 2026-09-26 · security · judge a DB-target guard by how the DRIVER parses the URL (D-03)

- **Symptom:** a local-only DB guard checked `new URL(url).hostname`, so `…@localhost/x?host=prod` passed the guard while the pg driver dialled prod.
- **Root cause:** the guard and the driver parsed the same string differently (`?host=`, `hostaddr`, `service`, multi-host lists, sockets, an encoded `?` in the database name).
- **Lesson:** **A safety guard on a connection string must parse it the way the DRIVER does (pg-connection-string), then dial the vetted explicit fields, never the raw string it just approved.**
- **Guard:** `scripts/lib/local-db-target.cjs` and its bypass-list spec (`local-db-target.spec.ts`).

### L-233 · 2026-09-27 · security · a role check is not an ownership check (#2386, SA-429, train B)

- **Symptom:** the DRIVER branch of `updateOrderItems` checked only `role === "DRIVER"` — any driver in the tenant could edit any order's items, not just orders on their own active run.
- **Root cause:** the branch was written assuming the role check was the whole authorization decision; no assignment/ownership predicate existed at all, and the gap is easy to miss because the code "looks done" (it correctly 403s the wrong role, just not the wrong instance).
- **Lesson:** **For a tenant-scoped, role-gated write path, "the role is correct" and "this principal is entitled to touch this specific resource" are two separate checks. A new role-gated branch needs an explicit resource-ownership assertion — re-derived from the resource's own foreign-key chain, never a denormalized shortcut field — written and tested as its own predicate, run before any other guard AND re-checked under the row lock.**
- **Guard:** `orders/driver-edit-access.ts`'s `assertDriverMayEditOrder` (follows `order.routeRunStopId → RouteRunStop → RouteRun`, never `order.routeRunId` directly); called first in `updateOrderItems`, before the cancelled-order check, and again under the Order `FOR UPDATE`. `driver-edit-access.spec.ts`, `driver-edit-access.db.spec.ts`.
- **Recurred 2026-09-27 (train D, #2398/#2391, SA-434):** the SAME predicate was missing (or independently reinvented weaker) at two MORE call sites reachable by the DRIVER role: `orders.service.ts`'s `changeStatus()` had no check at all, and `change-requests.service.ts`'s `resolve()` checked only `order.routeRun.driverId` with no run/stop status. The fix reused `assertDriverMayEditOrder` verbatim rather than writing a third bespoke check. Confirms the lesson generalizes beyond the one endpoint it was first found on: audit EVERY role-gated write path reachable by the same role, not just the one a report named.

### L-236 · 2026-09-28 · security · a stored storage key is trusted only after an exact own-prefix segment match (#2538, #2547)

- **Symptom:** a tenant could plant another tenant's object key in its own product row (`PATCH
  /products/:id` `imageKeys`) and have the server presign or delete it; separately, a POD key
  `tenants/<own>/pod/../../<other>/…` passed a `startsWith` ownership check.
- **Root cause:** a key persisted on a tenant-owned row was trusted once written, and ownership
  was tested as a string prefix, which cannot see `..` segments.
- **Lesson:** **Validate a storage/object key by parsing it into segments — exact segment count,
  every segment from a safe-character allowlist, no `.`/`..`/empty segment, the owner id in its
  fixed position — never with `startsWith`. Check it at write AND again at every sign/read/delete,
  so a row poisoned before the write guard existed still leaks and deletes nothing.**
- **Guard:** `products/product-image-keys.ts` (`isOwnProductImageKey`, `assertImageKeysReorder`) +
  `image-key-signing.tripwire.spec.ts`, `products.image-keys-2533.spec.ts`;
  `routes/pod-artifacts.util.ts` (`isPodStorageKey`, `podCaptureValueRefusal`) +
  `routes.pod-key-traversal-2542.spec.ts`; `scripts/report-2533-product-image-keys.mjs` finds
  rows poisoned before the fix.

## deploy

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

### L-195 · 2026-09-17 · deploy · landing a stale branch reverted #861's live fix (#862)

- **Symptom:** landing PR #862 silently reverted a live P1 fix from #861 that had merged after
  #862's branch was cut and never rebased — both PRs touched the same file in non-overlapping
  regions.
- **Root cause:** the landing computed a raw diff between #862's stale branch and current master
  to isolate "its own changes" — but since #861's hunk exists on master and NOT on #862's stale
  branch, that raw diff read #861's own fix as a REMOVAL belonging to #862 and applied it as one.
  A byte-identity check against the stale branch can't catch this either, since the stale
  content IS what's wrong.
- **Lesson:** **A landing diff meant to isolate "this PR's own changes" must be taken against
  the branch's OWN MERGE-BASE, never against current master directly. Whenever two in-flight
  PRs touch the same file, diff them against EACH OTHER for overlapping regions first. A
  post-deploy visual check is not a correctness check — verify the actual computed state, not a
  screenshot that can look right for the wrong reason.**
- **Guard:** the merge session's live post-deploy verification caught this one, plus the
  pre-existing e2e T13 opacity assertion. Propose: the landing tool diffs against
  `git merge-base <branch> master`, never `master` directly, and warns when two open PRs' diffs
  touch the same file.

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

### L-212 · 2026-09-21 · testing · a Playwright selector keyed to a responsive utility class rots silently (B620)

- **Symptom:** the boxed-proration e2e spec's line-total reader matched nothing and reported
  nothing — a selector that matches zero elements raised no error.
- **Root cause:** the selector was keyed to a layout utility class (`span.w-16`); a later UI
  change (#946) replaced it with a breakpoint-prefixed variant (`sm:w-16`), so the literal class
  no longer existed and the query silently returned an empty set.
- **Lesson:** **Never select by a layout or responsive utility class — a breakpoint prefix added
  later makes the selector match nothing with no error. Select by `data-testid`, which no styling
  change can rename.**
- **Guard:** #1133 (b8765689) added `data-testid="line-total"`; spec 13's `readLineTotal` reads it
  via `getByTestId`.


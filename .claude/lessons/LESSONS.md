# Lessons Learned — RouteFlow

> Generalizable rules this project has paid for. **Read this at the start of every major task,
> implementation, or bug fix** (alongside the code map) and cite entry ids when one changes your
> approach. **After every bug fix, append an entry** — Symptom / Root cause / **Lesson** / Guard —
> and bump [`_meta.json`](_meta.json); Gate 3 of [`../hooks/stop.mjs`](../hooks/stop.mjs) blocks
> fix-shaped turns that don't (a lesson-free fix bumps `_meta.json.updatedAt` to acknowledge).
> Caps: ≤ 52 active entries / 64 KB (set in [`_meta.json`](_meta.json), enforced by
> `scripts/validate-lessons.mjs`) — compact to [`ARCHIVE.md`](ARCHIVE.md). Entries that state one
> rule are merged; a merged entry keeps every absorbed id in its heading (`merged: L-xxx`), so a
> cited id still greps to its rule. Maintained by the `lessons-learned` skill. Blameless; **never
> client names/slugs/document numbers** — the repo goes public briefly for CI.

## process

### L-215 · 2026-09-19/23 · process · a merge authorization is fresh and exact (merged: L-209)

- **Symptom:** (L-215) a relayed brief said "set the ratchet baseline to the actual 5716" (down
  from 5751); the file grew to 5755 and the builder set 5755, citing SA and fleet-lead acceptance
  that never happened — a raise is the owner's call. (L-209) three PRs squash-merged on green CI
  plus an in-session review minutes after an independent reviewer posted blockers on the
  coordination issue (a prod E2E gate red on unseeded fixtures, a script sending live-tenant
  addresses to a third party before its test-tenant gate, an unchecked vendor verdict); fix-forward
  PRs and a manual prod re-seed followed.
- **Root cause:** a specific instruction was read as a standing license ("set it to the actual
  size" invited re-baselining); the merge gate checked CI plus one commissioned review, not the
  channel where independent reviews land — CI cannot see a blocker that lives in prose.
- **Lesson:** **An approval covers only the exact value or sha it names; any drift after it needs
  a fresh confirmation. A PR body or commit may cite an approval only by its coordination-issue
  comment id. Ratchet briefs say "extract until below the baseline, then lower the baseline to the
  new size", never "set it to the actual size". A merge gate includes a fresh read of the shared
  review channel for that PR — re-fetch and filter REVIEW / BLOCKED / HOLD lines naming it
  immediately before `gh pr merge`, not once at window open; an unresolved blocker, or a REVIEW
  line newer than the last reviewed commit, holds the merge.**
- **Guard:** reviewer check: every "approved/accepted by" claim links a comment;
  `size-ratchet.spec.ts` refuses raises beyond headroom; the landing-coordinator routine reads the
  coordination issue for REVIEW lines on the PR before each merge (no code guard).

### L-197 · 2026-09-17/18 · process · reason about master and shared ids only from a fresh all-refs view (merged: L-203, L-201)

- **Symptom:** (L-197) false "unlanded" verdicts: #857/B502 judged by its branch tip though it
  landed by cherry-pick under a new sha; a fix judged missing from a 59-commit-stale local
  `routeflow` checkout and broadcast before a fetch corrected it (the fleet lead's own mistake,
  logged at the lead's request). (L-201) five registry-id collisions in one window: a "next free"
  read of merged master missing an unmerged PR's reservations; a lane self-resolving per the
  B499-style protocol blind to a second branch's claim; two allocations racing an unconfirmed
  request; a fix commit's id going stale when its record was renumbered; an unrelated lesson
  landing on master at this entry's id.
- **Root cause:** each was a correct read of an incomplete view — a local `HEAD` lagging
  `origin/master`, the source branch's tip (a squash or cherry-pick leaves its commits
  legitimately absent), merged master, one worktree's scan, or memory. Nothing forces a fetch
  first, and self-resolving blind to a concurrent claim yields two plausible entries at one id.
- **Lesson:** **Before citing a closure as landed/unlanded: (1) `git fetch origin <branch>` first
  and name the fetched sha in any ancestry claim; (2) resolve the SPECIFIC landing commit —
  `git log --grep` for the PR's `(#N)` tag, or `gh pr view <n> --json mergeCommit` — never the
  source branch tip or GitHub's PR view alone; (3) run
  `merge-base --is-ancestor <that sha> origin/master` on full, unshallowed history. A shared,
  monotonically-allocated id comes only from a fresh `fetch --all --prune` then
  `git log --all -- <path-for-that-id>` across every local and remote ref, unmerged branches
  included — never memory, merged mainline or one worktree's scan. A handed-to-you id is
  unverified until checked the same way, even from the allocation owner.**
- **Guard:** none automated — landing checklist: fetch fresh, then check the actual landing
  commit, never either alone. Scoped: `bugs.mjs next-id` (fetch-all-refs scan + neighbor query).

### L-200 · 2026-09-18/26 · process · a claim about "the" path needs a whole-tree sweep of every path (merged: L-223)

- **Symptom:** (L-200, #866, B519) removing the legacy `AVAILABLE_ADDONS` toggle cards nearly
  shipped as retiring the `driver_payments` enforcement gap, but the Feature Console's
  `EnableAddonModal.tsx` "Enable as add-on" had the same missing check. (L-223, B863–B866) after
  the named add-on call sites moved to the new single ledger writer, `subscribe()` still booked
  add-ons through its own emit on the old live-catalog formula; only the final review caught it.
- **Root cause:** coverage was judged from the named sites — the removed control's own key, the
  brief's call-site list — while a sibling client surface or an unnamed writer reached the same
  capability.
- **Lesson:** **Before removing a UI control, grep every OTHER client entry point that reaches the
  same server capability/endpoint, not just the control's own key — it can be deletable as UI while
  its gap stays open through a sibling. Before declaring one writer for a ledger or event stream,
  grep the whole tree for every emit of those events and every `amountDelta:` site, not only the
  named call sites; route each through the writer or exempt it explicitly.**
- **Guard:** proposed removal-checklist item: list every client call site of the endpoint(s) the
  control posts to. #2186: `subscribe()` (`subscription-mutation.service.ts` :395-421 at review)
  now calls `emitAddonDelta`; on master `ADDON_ENABLED/DISABLED` is emitted only in
  `billing/addon-ledger.ts`. No structural pin yet; propose one beside
  `mrr-paying-predicate.parity.spec.ts`.

### L-231 · 2026-09-22 · process · a register claim needs the check that would disprove it

- **Symptom:** this write-up first relayed "no CI workflow runs the DB lane" as first-hand; false —
  `db-migrations.yml` runs `npm run test:db -w apps/api`, path-gated on `*.db.spec.ts` (why it
  fired for #1221). A stated clock time was stale when "corrected" (09:00Z vs 08:34Z, then 09:05Z
  vs 09:35Z).
- **Root cause:** a verified claim and a relayed one look identical once written; a clock or
  elapsed time is stale the instant it is read.
- **Lesson:** **A register claim must carry how it was established** — the command, the file:line,
  or who checked it — so a reader can disprove it in under a minute; an unfalsifiable claim is not
  a fact yet. **A CLOCK-time claim carries `date -u`'s output, not an estimate; an ELAPSED-time
  claim is not asserted, only the command that measures it.** For a docs PR mid-edit: QUEUE IT OR
  EDIT IT, NOT BOTH — publish a final sha only inside a merge window.
- **Guard:** none automated — proposed: a lint requiring a cited command or file:line beside
  factual claims; run `date -u` before quoting a time. Related: [[L-213]].

### L-240 · 2026-09-27 · process · a board issue has a 2,500-comment cap; roll to a successor at ~2,300

- **Symptom:** the board of record (#938) hit GitHub's 2,500-comment limit mid-window; verdicts
  had nowhere to go until #2554 was opened, pinned and pointed at from every skill and script that
  named #938.
- **Root cause:** one ever-growing issue with no count tracked, its number hardcoded in skills and
  `fleet-status.mjs`.
- **Lesson:** **A long-lived coordination issue is a capped resource: GitHub stops accepting
  comments at 2,500. Watch the count and roll to a pinned successor at ~2,300, before the cap. Name
  the live board in one place (a constant or config) and have skills point at it; leave the old
  issue's comment links as history.**
- **Guard:** `fleet-lead/scripts/fleet-status.mjs` reads one `BOARD_ISSUE` constant (env
  `FLEET_BOARD_ISSUE`); `fleet-lead/SKILL.md` names #2554. Proposed: print the count, warn at 2,300.

### L-241 · 2026-09-28 · process · text with backticks goes through a quoted heredoc to a file (#2707)

- **Symptom:** a lane wrote a PR body via an unquoted heredoc (`<<EOF`); the shell ran its
  backticked commands, including an owner-only `railway run … audit-tenant-entitlements.mjs`,
  stopped only by a missing CLI (MacBook, #2707; no damage).
- **Root cause:** command substitution runs inside an unquoted heredoc and a double-quoted
  `--body "…"`.
- **Lesson:** **Any PR, board or brief text that contains backticks is written with a QUOTED heredoc
  (`<<'EOF'`) or the file-write tool to a file, then passed as `--body-file` / `gh … -F body=@file`.
  Never interpolate such text into a command line.**
- **Guard:** the lane-brief rule (bodies to a file first); production commands are owner-run on the
  Mac mini only, with no railway CLI or link on the MacBook.

## tooling

### L-206 · 2026-09-18 · tooling · a test that pins a literal from another workspace's prose is an invisible coupling

- **Symptom:** `docs-truth.spec.ts` (`apps/api`) hardcoded the lessons byte cap, mirroring
  `.claude/lessons/_meta.json`; a docs-only edit to that JSON (a `.claude/` config file) broke the
  API spec and CI repo-wide.
- **Root cause:** a test re-typing a doc's literal couples two places whose authors never look at
  each other.
- **Lesson:** **A test that pins a literal sourced from a prose document or config file elsewhere in
  the repo must read that value at test time, never re-type it — so a "docs-only" change is NOT
  exempt from the full verify chain when it touches a value another workspace's test might pin.
  Grep for the literal itself (not just the file) across every workspace before skipping CI.**
- **Guard:** `docs-truth.spec.ts` reads `_meta.json.maxBytes` dynamically (#889); no repo-wide
  pinned-literal grep yet — propose one in the docs-only-push exemption. Renumbered from L-199
  (#909 landed an unrelated lesson at that id).

### L-198 · 2026-09-18/27 · tooling · `gh run rerun` replays the original checkout, not a fresh merge-ref

- **Symptom:** across ~12 PRs in one window, the first "fresh" `gh run rerun` after a root-cause fix
  landed on master kept failing on the SAME already-fixed assertion.
- **Root cause:** `gh run rerun <run-id>` reuses the commit/merge ref resolved at the run's ORIGINAL
  trigger; only a new `pull_request: synchronize` event (a new commit) recomputes it against the
  current base.
- **Lesson:** **To re-test a PR against the CURRENT base branch, push a genuinely NEW commit, never
  `gh run rerun` — an empty one works (`git commit --allow-empty`, or `git commit-tree` plumbing when
  the branch can't be checked out). Reserve `gh run rerun` for a flaky failure on a current merge
  ref.**
- **Guard:** none yet — propose a landing helper that pushes an empty commit instead of rerunning.
- **Fold-in 2026-09-27 (CI base must equal master):** a close/reopen or empty commit is not proof
  either — GitHub recomputes `refs/pull/N/merge` asynchronously, so a run started seconds after can
  check out the OLD base (seen three times in one night). Before trusting a green run, read its
  checkout line (`HEAD is now at <merge> into <base>`) and require `<base>` to equal current master;
  if not, wait until `git ls-remote origin refs/pull/N/merge` shows a merge commit whose first parent
  is master, then trigger again.

### L-191 · 2026-09-17/27 · tooling · know which gate actually checks the class you changed (merged: L-235)

- **Symptom:** (L-191) `MailboxCard.tsx` shipped five raw `'` in JSX text
  (`react/no-unescaped-entities`); `tsc`, Jest and a targeted `eslint` on the file were clean — only
  `npm run lint -w apps/web` (`next lint`) caught it. (L-235, #1315, B806) a wrong-shaped spec
  fixture (#1286's `taxNone = () => 0`) reached CI green; once #1315 compiled the api specs ~7,000
  spec type errors surfaced, 6,328 masked by one mistyped mock factory (`createMockPrisma`).
- **Root cause:** each green came from a gate that does not check that class: `next lint` fails the
  whole workspace amid backlog warnings, so a new error reads as backlog; `apps/api/tsconfig.json`
  excluded `*.spec.ts` from `check-types` and ts-jest (`isolatedModules`, transpile-only) read the
  same config — each gate assumed the other checked specs.
- **Lesson:** **A green from a gate that does not check the class you changed proves nothing. A JSX
  text change needs web lint run locally before push — scan the full output for NEW errors in the
  touched file(s), never infer from `tsc`/Jest. When a type-check config excludes tests, find which
  gate type-checks them; a transpile-only runner (`isolatedModules`, SWC, babel) checks nothing. If
  no gate does, add one — ratchet an existing error count down (shrink-only baseline) rather than
  wait for zero.**
- **Guard:** proposed: a scoped `npm run lint -w apps/web -- --file <changed-file>` or a pre-push
  lint-baseline diff. api `check-types` runs `scripts/check-types-ratchet.mjs` over src + specs (src
  zero-tolerance, per-spec counts in `check-types.spec-baseline.json`, moved only by
  `--lower-baseline`); `scripts/lib/check-types-ratchet-core.mjs` refuses a `// @ts-nocheck` spec
  (`isNoCheckFile`).

### L-193 · 2026-09-17 · tooling · bugs.mjs index carries catalogue-only fields forward BY ID POSITION

- **Symptom:** renumbering 17 bug records then running `bugs.mjs index` put shifted rows'
  `symptom`/`filedAt` onto the WRONG finding.
- **Root cause:** catalogue-only fields have no home in a record's front matter, so `index` carries
  forward whatever the prior catalogue row held at that SAME id — after a rename, an orphan.
- **Lesson:** **`bugs.mjs index`/`expand` carry a catalogue-only field forward by id lookup, not by
  identity — renaming a record's file to change its id does NOT bring these fields with it. To
  renumber, pull each row's ORIGINAL entry from git history, remap only `id`, and splice it back
  directly. Diff for net-zero before committing any bulk-id rewrite.**
- **Guard:** none yet — propose `bugs.mjs renumber <old> <new>` (atomic remap) or a self-test that
  `index` refuses/warns on a renamed fixture.

### L-176 · 2026-09-16/17/22/23 · tooling · prove a result ran this worktree's fresh code (merged: L-194)

- **Symptom:** (L-176) a worktree without its own `node_modules` resolved deps to the MAIN
  checkout — a stale `@routeflow/pricing` dist threw a missing-function error. Recurred 2026-09-22
  twice (after a `@routeflow/pricing` change landed, other worktrees' `packages/pricing/dist` stayed
  stale and api/web tests silently computed wrong zeros/drift) and 2026-09-23 (B660 PR B,
  `apps/web` + `@routeflow/returns`: editing `packages/returns/src/*.ts` did nothing to a web dialog
  test, because `apps/web`'s jest config has no `moduleNameMapper` for `@routeflow/returns`, unlike
  `apps/mobile`'s, and loaded the stale prebuilt `dist/index.js` via `package.json`'s
  `main`/`types`; fixed by `npm run build -w packages/returns`; turbo rebuilds it inside
  `npm run verify`). (L-194) `preview_start({name})` gave plausible screenshots of a worktree
  branch while a breakpoint in the branch looked broken — the main checkout's copy had none of the
  new component.
- **Root cause:** a worktree missing its own `npm ci` falls back to whatever the main checkout
  installed/built; a consumer with no `moduleNameMapper` resolves prebuilt `dist`, not `src`
  (inconsistent per app); `preview_start` launches `launch.json` configs from the main checkout,
  never the calling worktree. None of these warns.
- **Lesson:** **A worktree needs its OWN `npm ci` before running web/api tests. After any
  `packages/*` change lands on master, rebuild the shared dist in EVERY worktree that tests against
  it (`npx turbo run build --filter=@routeflow/pricing --force` after fetching master) — a stale
  `packages/pricing/dist` fails quietly (wrong money values) as easily as loudly. Mid-session, after
  editing a package's `src`, check the consuming app's jest config for a `moduleNameMapper`; absent
  one, `npm run build -w <pkg>` first. A UI proof for a branch not checked out in the main checkout
  runs its OWN dev server FROM the worktree and positively verifies what is served (grep the
  rendered HTML for something only the branch produces) before any screenshot is trusted.**
- **Guard:** none automated after three recurrences — proposed: a pre-test check comparing
  `packages/*/dist` mtimes to `src` (and listing consumers without a `moduleNameMapper`), and a
  worktree UI-proof runbook line: confirm the served code matches the branch BEFORE capturing.

### L-190 · 2026-09-17 · tooling · a stacked PR is rebuilt, not rebased, after its base squash-merges

- **Symptom:** #819 (FG-B) conflicted after sibling FG-A squash-merged the schema/contract commit
  both stacked on; a normal rebase/merge treated the squashed content as new and corrupted schema
  state.
- **Root cause:** after the squash the shared commit no longer exists on master under its identity,
  so history-diffing sees "the same change, twice".
- **Lesson:** **A PR stacked on another PR's not-yet-landed schema/contract commit must be REBUILT
  from a fresh branch off the post-squash master — cherry-picking only its OWN commits, never the
  shared ancestor or a merge commit — once the base PR lands. Never rebase or ordinary-merge a
  stacked branch through someone else's squash.**
- **Guard:** none automatic — the landing coordinator diffs `origin/master...HEAD` on the rebuilt
  branch and confirms zero changes under the schema-owning PR's files before pushing.

### L-180 · 2026-09-16/22 · tooling · npm/dir junctions across worktrees are unsafe near git worktree ops

- **Symptom:** (a) after `git worktree move`, invalid-hook-call errors and mangled Jest paths; (b) a
  scratch worktree junctioned to a SIBLING's `node_modules` (to dodge `npm install` under disk
  pressure), then `git worktree remove --force` cascaded through it, wiping the sibling's
  `node_modules` and ~2,388 tracked files. Recurred 2026-09-22: a PC reviewer agent's cleanup
  followed the main checkout's `node_modules/@routeflow/*` links (pointing into `apps/` and
  `packages/`) and deleted 2,814 tracked files.
- **Root cause:** Windows npm junctions are absolute-path reparse points, invisible to git;
  `worktree move` leaves one pointing at the old path, and `worktree remove --force`/`rm -rf` walks
  THROUGH one into its real target.
- **Lesson:** **Never let a junction outlive the git worktree op around it. After
  `git worktree move`, treat `node_modules` as stale — `npm ci` (+ `prisma generate` for apps/api)
  at the final path. Before removing or recursively deleting ANY worktree, prove no junction remains
  (`dir /AL` or check `LinkType`), then unlink each with `cmd /c rmdir <link>` (no `/s`, which
  recurses) — never a bare `rm -rf`/`--force` on a tree that might hold one. Never junction
  `node_modules` between two DIFFERENT live worktrees; reviewer/audit agents run read-only against
  the target checkout with no worktree of their own.**
- **Guard:** none automated after two incidents (proposed: refuse `git worktree remove` while a
  junction exists under the tree; a post-move junction-target check). Interim: reviewer prompts
  carry the read-only, no-worktree rule. Recovery:
  `git ls-files --deleted -z -- <dirs> | xargs -0 git restore --`, then confirm
  `git ls-files --deleted` is empty and the diff clean before resuming.

### L-179 · 2026-09-16 · tooling · campaign-check freshness ritual

- **Symptom:** every push cost 2–3 failed attempts against `campaign-check`'s freshness gate.
- **Root cause:** the gate compares each workspace report to the newest commit of ANY file, and
  `turbo run test --force` can still cache-skip the report-writing step.
- **Lesson:** **A freshness gate keyed on "newest commit, any file" false-fails when its own
  report-writing step can be cache-skipped.** Ritual until fixed: commit everything first, run
  `npx jest --maxWorkers=2` per workspace directly (bypasses the turbo cache), then push immediately.
- **Guard:** none yet — propose keying freshness on source/test/ledger paths only, with the pre-push
  hook regenerating reports itself.

## testing

### L-205 · 2026-09-16/18 · testing · assert the real outcome, never a proxy for it (merged: L-165)

- **Symptom:** (L-205) `touch-reveal-b511.test.ts` and `edit-line-item-row-b513.test.ts` pinned a
  JSX className as literal source text; an additive `cn(TAP_TARGET, "...")` wrapper (same classes,
  correct behavior) broke both. (L-165, #779, B225/B244/B411) two integration tests flaked under
  load — one asserted elapsed wall-clock time, the other an ambient tmpdir file count shared across
  parallel workers.
- **Root cause:** each asserted a proxy — source text, timing, a shared count — instead of the
  behavior or the process's own declared result. A proxy breaks on harmless changes and can pass a
  real regression (cf. archived [[L-218]]: a red-proof matching message text another error shares).
- **Lesson:** **A regression test asserts the underlying behavior (DOM state, computed style, an
  element's actual reachable size) or the process's own reported result/exit signal — never a
  scrape of the source file's literal text, wall-clock timing, or a shared/global count (which races
  every parallel worker touching the path). Assert an error by class or code, never message text,
  and run the proof against the old code to confirm it fails for the intended reason.**
- **Guard:** rewriting both className tests to DOM-behavior assertions was scoped into #910; review
  flags any `Date.now()`-delta or directory-count assertion in a spec touching a spawned process or
  shared tmp path (no lint yet).

### L-202 · 2026-09-18/21 · testing · a check that matched nothing must fail, not pass (merged: L-212)

- **Symptom:** (L-202) the 390px overflow sweep located screens via `a[href^='/x/']`, but list
  tables navigate by row `onClick` + `router.push`, never anchors; every run recorded "skipped: no
  data" and looked clean, and fleet decisions were made on it. (L-212, B620) the boxed-proration
  e2e's line-total reader keyed on `span.w-16`; #946 changed it to `sm:w-16` and the selector
  silently matched nothing.
- **Root cause:** "found zero targets" and "checked every target, all fine" produce the same green;
  a layout-class selector breaks with no error when styling changes.
- **Lesson:** **Any verification step that yields zero candidate targets must raise an error, never
  a skip or a pass. Never select by a layout or responsive utility class — a breakpoint prefix added
  later makes it match nothing with no error; select by `data-testid`, which no styling change can
  rename.**
- **Guard:** proposed: the sweep asserts a non-zero target count before evaluating. #1133
  (b8765689) added `data-testid="line-total"`; spec 13's `readLineTotal` reads it via `getByTestId`.

### L-050 · 2026-09-02/27 · testing · a test owns every fixture it mutates or scans (merged: L-234)

- **Symptom:** (L-050, #598) two new e2e specs went red post-deploy and took a previously-green test
  down with them. (L-234, B824, train C) `publish-and-repin.db.spec.ts` failed three ways under
  `--maxWorkers=2` (an unrelated tenant tripped `--only-test-tenants`'s refusal; an unscoped
  `--apply --live` wrote onto a sibling spec's fixture tenant; this spec's fixture got writes back),
  green each time alone — so it read all night as "a known flake".
- **Root cause:** shared state across parallel runs. Neither new project declared `dependencies`, so
  both ran in phase 1 while the victim ran in phase 2 on a stored session for the same shared
  operator, which the mutating spec revoked (401 on refresh). `publish-and-repin.mjs`'s
  `computeDiff()` correctly scans the WHOLE database for prod, but under parallel workers also picks
  up sibling `*.db.spec.ts` fixture tenants; running alone removes the siblings, so that green is
  not a safety signal.
- **Lesson:** **A spec that mutates shared auth state needs its own user, not a scheduling tweak —
  ask which fixtures a new suite MUTATES and who else in its phase reads them. A `*.db.spec.ts` (or
  script) that computes a diff/apply, or any read+write, over a shared unscoped table under parallel
  workers scopes every call to its own fixture rows (an id/slug allowlist flag on the tool it
  drives). "Green alone, red in the full lane" means a missing scope, not a flake to rerun past.**
- **Guard:** the two #598 project entries stay commented out with the diagnosis inline (re-enable =
  seed change + uncomment; a skip is not a discharge, [[L-041]]). `publish-and-repin.mjs
  --only-tenants <slugs>`; `publish-and-repin.db.spec.ts`'s `runCli()` passes its 3 fixture slugs on
  every call (report, preview, live apply).

### L-025 · 2026-09-01 · testing · a Platform/isWeb branch is untested unless something runs it

- **Symptom:** native Google Sign-In was dead the whole time — the callback destructured a `default`
  export `expo-secure-store` does not have, so token storage threw on every device.
- **Root cause:** the throw sits inside a `!isWeb` branch; every automated surface runs the web
  build, which takes the `localStorage` branch.
- **Lesson:** **A `Platform`/`isWeb` branch is untested code unless something runs that platform.
  When you touch one side of such a branch, either exercise the other side or state plainly that it
  is unverified.**
- **Guard:** none — judgment. Grep `isWeb`/`Platform.OS` in any file a fix touches.

### L-226 · 2026-09-27 · testing · a money fixture must be shaped by the production writer (#2274, #2245, #2305)

- **Symptom:** ledger and unit-line specs hand-built rows the writer never produces (credit overshoot
  legs the per-line and header caps would refuse; quantities not in base pieces), proving a state
  that cannot exist and able to miss the one that can.
- **Root cause:** a hand-built fixture encodes the author's model of the writer, not its output
  (cf. [[L-220]]).
- **Lesson:** **Build every money or unit fixture with the production writer (or copy its exact
  shape: base-piece qty, `net + tax` amounts, the maps it stores). Before asserting an overshoot or
  edge state, confirm the writer can reach it; if only a downstream clamp stops it, test that
  clamp.**
- **Guard:** review checks each fixture against the writer's call site (train A:
  `credit-notes.service.ts` caps, `returns.service.ts` return maps);
  `regulated-ledger-price-correction.db.spec.ts` drives the real writers.

## domain

### L-143 · 2026-09-15/17 · domain · two questions need two named answers, never one figure serving both (merged: L-185)

- **Symptom:** (L-143, B421) a CREDIT_NOTE-method payment (`status: PAID`) counted as cash wherever
  "Paid"/"received" showed — invoice totals, PDF, buyer portal, mobile, every bookkeeping cash-flow
  figure. (L-185, B440) a report's `total` was repurposed from "sum of the displayed column" to a
  pre-tax windowed expense figure, and the footer stopped equalling its own column.
- **Root cause:** one predicate or field answered two questions — "is this confirmed" (status) vs
  "is this cash"; a UI sum-of-column invariant vs a cross-report reconciliation value — so changing
  it for one consumer silently broke the other.
- **Lesson:** **A "paid"/"received" DISPLAY figure is cash-only (excludes CREDIT_NOTE; ADVANCE stays
  in, since its application is the only place cash is ever recorded) — but balance/status/
  outstanding figures keep the FULL confirmed total, since a credit note or advance genuinely
  settles what's owed. Two questions, two filters, ONE shared predicate. When a report field feeds
  both a displayed column's own sum AND a value another report must reconcile against, give the two
  consumers separate named fields.**
- **Guard:** `@routeflow/pricing`'s `splitConfirmed`/`resolveConfirmedAmounts`/
  `RECEIVED_METHOD_FILTER`/`CASH_METHOD_FILTER` are the one implementation api/web/mobile import —
  never re-derive either filter at a second site. Proposed for B440's class: a fixture where the two
  diverge (nonzero tax) asserting both formulas.

### L-167 · 2026-09-16/26 · domain · logic copied across sibling paths or screens drifts: one shared helper, audit every sibling (merged: L-225)

- **Symptom:** (L-167, #781, B156/B158/B170) three separately-reported bugs traced to one
  customer-list filter predicate living in several places. (L-225, B653, B757-B759) the
  invoice-detail qty/unit-label bug fixed in #1275 reappeared on both order-detail screens (web's
  `OrderLineItemsTable`, mobile's operator and customer order detail), each hand-formatting a boxed
  line's qty inline — a `unitLabel`'d line (Case, Pallet) showed a bare boxes/pieces split and a
  factor-1 unit line skipped unit display.
- **Root cause:** `findAll`'s `where` and `exportCustomers`'s hand-rolled copy had drifted, and the
  removed-customer guard consulted neither; the first display fix landed inline on the reported
  screen, so nothing made its siblings pick it up.
- **Lesson:** **When an entity has more than one read/export/guard path, its filter predicate belongs
  in exactly ONE shared builder consumed by all of them — call-site copies silently drift, and each
  drift surfaces as its own "unrelated" bug. When a display/formatting bug is fixed on one screen,
  extract the fix into a shared helper and audit every sibling screen rendering the same data shape —
  a proof against one screen is not a proof against its copies.**
- **Guard:** shared `buildListWhere()` backs `findAll`, `exportCustomers` and the status-change
  guards (a same-function-reference test is flagged, not added).
  `apps/*/lib/invoice-line-display[.ts]`'s `usesUnitDisplay`/`invoiceLineQtyText` is the one
  qty-text formatter for all four screens; a `describe.each` wiring test
  (`order-detail-unit-display-wiring.test.ts` / its web equivalent) pins the import and condition on
  each.

### L-119 · 2026-09-13/15 · domain · related money figures derive from one collection and one gate (merged: L-159)

- **Symptom:** (L-119, F38 round 4) an independent pre-merge review found a door quote collecting
  excise on cancelled and already-delivered lines after three in-lane review rounds passed it.
  (L-159, B421) a PDF fallback re-derived `totalPaid`/`creditApplied`/`advanceApplied` each on its
  OWN `!= null` check, so a caller passing an old, credit-inclusive `totalPaid` alone got the other
  two re-split from raw payments — double-subtracting; a web page reinvented the same bug right
  after.
- **Root cause:** the halves of one figure came from differently filtered line sets, and related
  figures each checked their own presence — each file or field read correctly alone; the defect
  lived in the seam.
- **Lesson:** **Both halves of one money figure derive from ONE collection — pass the filtered array,
  never re-derive the filter at the second call site. When a fallback re-derives several related
  figures from raw data, gate ALL of them on ONE presence check: a caller gets the full precomputed
  set or the full re-derived set, never a mix. A reviewer inside the lane is the wrong instrument for
  a seam; it takes an independent pre-merge pass to see across two files that are each right.**
- **Guard:** REG-B305 round 4 + the source pin `short-pick-category-tax.pins.test.ts`;
  `payment-predicates.ts`'s `resolveConfirmedAmounts(precomputed, payments)` and the web mirror gate
  on one field's presence, each with a red-first double-subtraction test.

### L-170 · 2026-09-16 · domain · roundMoney before any comparison, not only at display (#743 F3)

- **Symptom:** a fully-settled invoice showed a red "Balance Due $0.00" badge instead of the green
  paid state.
- **Root cause:** the balance summed three independently-derived floats; color-coding ran on the raw
  sum, where a sub-cent remnant survives `Math.max`, and `roundMoney` was applied only when
  formatting.
- **Lesson:** **`roundMoney` must wrap a sum of independently-derived floats BEFORE the value drives
  any comparison or branch — color-coding, `>0` checks, conditional rendering — never only where
  it's formatted for display.**
- **Guard:** `invoices.service.ts`'s two `balanceDue` sites and the PDF template wrap in
  `roundMoney()` before comparing; same fix at `customers.service.ts`'s
  `applyAdvancePaymentToInvoiceLocked` (#814).

### L-072 · 2026-09-03 · domain · never hand-declare a client mirror of a server enum (wave E `imp-10b`)

- **Symptom:** 4 hand-typed client mirrors of Prisma enums drifted from the schema (invented,
  renamed or omitted values); one hid a real action and broke a list filter.
- **Root cause:** TS never compares two independently hand-typed string unions, so drift compiles
  clean.
- **Lesson:** **Never hand-declare a client mirror of a server (Prisma) enum — derive one const-array
  union per enum from a shared package and pin it set-equal to `Object.values()` of the real enum in
  a spec, never against a second hand-typed "expected" list.**
- **Guard:** `apps/api/src/common/enum-parity.spec.ts` — a generic table (40 enums) against
  `packages/types/api/enums.ts`, plus a regression layer pinning the drifted files and the mobile
  jest stub that can't `require` the shared package.

### L-124 · 2026-09-13 · domain · cron sweep silently dropped null-tenant orders

- **Symptom:** a cron grouped pending orders by `(customerId, tenantId)` and kept groups with
  count > 1; a customer with one real-tenant and one legacy null-tenant order made two one-row
  groups, both filtered out — nothing merged, nothing logged.
- **Root cause:** the null-tenant warn lived inside the per-group loop, downstream of the count
  filter.
- **Lesson:** **A cron or bootstrap entry point has NO ambient tenant: group the work by tenantId
  first and run each group inside `tenantCtx.run(tenantId)`; `forTenant()` silently returns the
  unscoped client otherwise. Rows without a tenant must be skipped AND counted, never dropped
  silently.**
- **Guard:** `REG-B323` — an unscoped groupBy on null tenantId runs beside the main query and counts
  every null-tenant customer; the sweep returns the count as `skipped`.

### L-125 · 2026-09-14 · domain · never infer a money-bearing date from a column that happens to hold one (W1 billing anchor)

- **Symptom:** a billing-drift fix was about to derive each tenant's cycle anchor from
  `TenantSubscription.createdAt`, moving real charge dates for anyone whose row predates their
  subscription.
- **Root cause:** several paths create that row without subscribing; no column stores the anchor.
- **Lesson:** **Never infer a money-bearing date from a column that merely happens to hold a date.
  Check every writer of the row before treating a field as the thing you need — if none of them means
  it, the honest fix is a column and a migration. Shipping half a fix beats shipping a wrong charge
  date.**
- **Guard:** the time-of-day half shipped alone; the drift half is filed, blocked on an `anchorDay`
  column. Sibling [[L-118]].

### L-221 · 2026-09-26 · domain · retry a whole idempotent tx on a conflict through ONE shared predicate (SA-269)

- **Symptom:** none in production: a design rule set by SA-269/SA-340 when #2152 added a transaction
  retry, so callers would not each invent a conflict test.
- **Root cause (of the risk):** conflict shapes differ across Prisma and pg (40001, 40P01 in every
  Prisma/pg shape, P2034, TransactionWriteConflict), so a per-caller classifier matches a subset or
  retries a business error.
- **Lesson:** **Retry the WHOLE transaction (each attempt re-takes its first lock) on a write
  conflict, classified by one shared predicate (`common/tx-retry` `txConflictState`). An
  HttpException is never a conflict.**
- **Guard:** `REG-SA269-1/2/3` in the tx-retry specs.

### L-222 · 2026-09-26 · domain · a line's unitPrice and unitsPerBox are ONE denomination (SA-330)

- **Symptom:** a rolled-over next-delivery line was split and priced at the LIVE product pack, so
  after a repack it was re-split and re-priced from the source line.
- **Root cause:** the copy carried the price without its pack, or the pack without its price.
- **Lesson:** **When a line is copied, snapshot BOTH unitPrice and unitsPerBox or neither. Carrying
  the pack with a live price under-bills after a repack; converting a live price to an old pack is
  refused.**
- **Guard:** `next-delivery-pack.db.spec.ts` (a repack with a price change, plus an AT_STOP vs
  NEXT_DELIVERY parity pin).

### L-232 · 2026-09-27 · domain · a calendar-day field keeps the client's literal day (#2249, train B)

- **Symptom:** `invoices.service.ts` stored `new Date(dto.issueDate)` raw, so a client datetime with
  a time or offset crossing a UTC day boundary (e.g. `23:30-04:00`) landed one day later, breaking
  the UTC-midnight convention statements, the regulated report and sales-facts buckets assume.
- **Root cause:** a day-granular calendar stamp was treated as an instant; an earlier version made
  it worse by re-reading in the tenant timezone.
- **Lesson:** **A DTO field documented or consumed as a calendar day (statements, invoices,
  schedules) must be normalized at the write boundary through a literal first-10-characters day
  extractor — never `new Date(rawString)` directly, and never re-derived from a timezone. A shape
  that names no real day is a 400, checked before anything else is read.**
- **Guard:** `common/calendar-date.ts`'s `calendarStampFromInput`/`issueDateStamp`, called as
  `InvoicesService.create()`'s first statement; `calendar-date.pins.spec.ts`,
  `invoice-issue-date-b2197.db.spec.ts`. The F25 calendar-date convention (archived L-047)
  recurring at a new call site.

### L-237 · 2026-09-28 · domain · a side effect fired inside a transaction still fires when it rolls back (#2526)

- **Symptom:** invoice realtime events announced changes whose transaction later rolled back or was
  retried.
- **Root cause:** gateway emits are fire-and-forget, and helpers called from a transaction body
  emitted directly.
- **Lesson:** **A side effect that cannot be rolled back (socket emit, email, webhook, queue push) is
  queued inside the transaction and flushed only after it commits: a rejected transaction flushes
  nothing, and a retried attempt resets the queue first. Pass the queue into every helper the
  transaction body calls, and pin it with a tripwire that fails on a direct emit.**
- **Guard:** `common/after-commit.ts` (`AfterCommit`, `withAfterCommit`), `after-commit.spec.ts`,
  `invoices/emit-after-commit.tripwire.spec.ts`. Cf. [[L-221]].

### L-238 · 2026-09-28 · domain · a missing or null key is refused or segregated, never keyed on (merged: L-242)

- **Symptom:** (L-238, #2573) a per-line CANCEL/DELETE edit with no line id built
  `{ id: undefined, orderId }`; Prisma dropped `id` and the write matched every line of the order.
  (L-242, B889, #2709) mobile buyer edit-items keyed its draft by `productId`; seller custom lines
  (`productId` null) collapsed into one "Product" row, and Save sent `productId: null`, which the
  server silently ignored.
- **Root cause:** Prisma treats an `undefined` filter value as "no condition", widening a narrowing
  `where`; in a map keyed by a nullable id every null collides on one key, and the null class is not
  a real member of the keyed set.
- **Lesson:** **Never build a narrowing `where` from an optional value: refuse the missing value
  before the query (a 400/404) and scope every targeted write by the key AND its parent
  (`{ id, orderId }`), so a hole can only fail loudly, never widen. Never key a UI draft or map by a
  nullable id: key on the non-null identity and skip or segregate the null class explicitly,
  mirroring web's established filter and the server's own definition (`isUnlisted = !productId`).**
- **Guard:** `orders/order-line-removal.ts` (`writeLineRemoval`, `assertRemovalsNameALine`),
  `order-line-removal.spec.ts`, `order-line-removal.db.spec.ts`; #2709's pins in
  `apps/mobile/__tests__/buyer-edit-items-custom-lines.test.ts` (`isCustomLine` skips seller custom
  lines in `hydrateBuyerDraft`).

### L-239 · 2026-09-28 · domain · a guarded destructive write: lock, then read, then compare-and-set (#2566, #2584, #2594, #2607)

- **Symptom:** customer deletes destroyed issued/paid invoices, money records and delivery history;
  `updateTenantClass` booked its BillingEvent from a read taken before its lock; an insert landing
  after the last read turned the final delete into a 500.
- **Root cause:** deciding reads taken before the lock (or outside the transaction), deletes keyed on
  the parent id alone, and table lists that differed between the guard and the delete.
- **Lesson:** **For a destructive or money-booking write gated on business state: take the row lock,
  read the deciding state AFTER it, make each destructive statement a compare-and-set that expects
  the guarded row set and throws 409 on a mismatch, drive the pre-flight, the in-tx re-check and
  every delete from ONE list of protected tables, and map a late insert's FK violation to the same
  409. A pre-flight outside the transaction is UX, not protection.**
- **Guard:** `customers/customer-delete-preflight.ts` (`assertNoBlockingInvoices`,
  `readInvoicesAssertingNoneBlocking`, `deleteNonBlockingInvoicesCas`, `deleteMoneyRecordCas`,
  `deleteCustomerRowsFkRaceAs409`); `customer-delete-race-2558.db.spec.ts` (a real second
  connection), `customer-delete-money-records-2587.db.spec.ts`,
  `customer-delete-fk-race-2572.db.spec.ts`; `common/update-tenant-class-ledger.db.spec.ts`.
  Cf. [[L-217]], [[L-221]].

### L-243 · 2026-09-28 · domain · an action that narrows a list into a request is disabled when the narrowed list is empty (#2693, #2712)

- **Symptom:** on an inline return where no line matched an invoice (all excess), choosing "Return
  only what was bought" re-quoted with zero lines and showed the API's raw
  `items must contain at least 1 elements`.
- **Root cause:** `dropExcessAndRequote` built its request from the covered subset without handling
  an empty subset; the control stayed enabled, and the DTO's `ArrayMinSize` refusal was the only
  check.
- **Lesson:** **A control whose action filters a list into a request is gated by a predicate computed
  from the same data the request builder uses: when the filtered set would be empty, disable the
  control with a plain-words reason and never send the request. A raw DTO validation message is
  never the user-facing explanation. The predicate lives in the shared package so web and mobile
  gate identically.**
- **Guard:** `packages/returns/src/inline-return-state.ts` (`canReturnOnlyPurchased`,
  `notBoughtBeforeNames`, `NOTHING_BOUGHT_BEFORE_MESSAGE`) + `inline-return-state.spec.ts`; web
  `InlineReturnSection.test.tsx` (radio disabled, one quote call, no raw DTO text); mobile
  `inline-return-screen.pins.test.ts`.

## security

### L-188 · 2026-09-17 · security · no bearer-shaped secret in a URL query string (demo-booking tokens)

- **Symptom:** an OAuth/booking token traveled as a URL query parameter — the shape that lands in
  access logs, browser history, `Referer` headers and analytics scripts.
- **Root cause:** a query string is the easiest carrier across a redirect and the least private one.
- **Lesson:** **Never carry an OAuth token, booking token, or any other bearer-shaped secret in a URL
  query string — use a fragment (`#`, never sent to the server) for a client-side handoff, or a POST
  body for a server-side one.**
- **Guard:** none yet — propose a lint/review item flagging `token`/`code`/`secret`-named query params
  on any new route.

### L-219 · 2026-09-26/28 · security · a guard parses its input exactly as the consumer will, never by string shape (merged: L-236)

- **Symptom:** (L-219, D-03) a local-only DB guard checked `new URL(url).hostname`, so
  `…@localhost/x?host=prod` passed while the pg driver dialled prod. (L-236, #2538, #2547) a tenant
  could plant another tenant's object key in its own product row (`PATCH /products/:id`
  `imageKeys`) and have the server presign or delete it; a POD key
  `tenants/<own>/pod/../../<other>/…` passed a `startsWith` ownership check.
- **Root cause:** guard and consumer parsed the same string differently (`?host=`, `hostaddr`,
  `service`, multi-host lists, sockets, an encoded `?` in the database name; `..` segments a prefix
  check cannot see), and a key persisted on a tenant-owned row was trusted once written.
- **Lesson:** **A safety guard on a connection string must parse it the way the DRIVER does
  (pg-connection-string), then dial the vetted explicit fields, never the raw string it just
  approved. Validate a storage/object key by parsing it into segments — exact segment count, every
  segment from a safe-character allowlist, no `.`/`..`/empty segment, the owner id in its fixed
  position — never with `startsWith`; check it at write AND at every sign/read/delete, so a row
  poisoned before the write guard existed still leaks and deletes nothing.**
- **Guard:** `scripts/lib/local-db-target.cjs` + its bypass-list spec (`local-db-target.spec.ts`);
  `products/product-image-keys.ts` (`isOwnProductImageKey`, `assertImageKeysReorder`) +
  `image-key-signing.tripwire.spec.ts`, `products.image-keys-2533.spec.ts`;
  `routes/pod-artifacts.util.ts` (`isPodStorageKey`, `podCaptureValueRefusal`) +
  `routes.pod-key-traversal-2542.spec.ts`; `scripts/report-2533-product-image-keys.mjs` finds rows
  poisoned before the fix.

### L-233 · 2026-09-27 · security · a role check is not an ownership check (#2386, SA-429, train B)

- **Symptom:** the DRIVER branch of `updateOrderItems` checked only `role === "DRIVER"` — any driver
  in the tenant could edit any order's items, not just orders on their own active run.
- **Root cause:** the role check was taken as the whole authorization decision; no ownership
  predicate existed, and the code "looks done" (it 403s the wrong role, not the wrong instance).
- **Lesson:** **For a tenant-scoped, role-gated write path, "the role is correct" and "this principal
  is entitled to touch this specific resource" are two separate checks. A new role-gated branch
  needs an explicit resource-ownership assertion — re-derived from the resource's own foreign-key
  chain, never a denormalized shortcut field — written and tested as its own predicate, run before
  any other guard AND re-checked under the row lock.**
- **Guard:** `orders/driver-edit-access.ts`'s `assertDriverMayEditOrder` (follows
  `order.routeRunStopId → RouteRunStop → RouteRun`, never `order.routeRunId`); called first in
  `updateOrderItems`, before the cancelled-order check, and again under the Order `FOR UPDATE`.
  `driver-edit-access.spec.ts`, `driver-edit-access.db.spec.ts`.
- **Recurred 2026-09-27 (train D, #2398/#2391, SA-434):** the same predicate was missing or weaker at
  two more DRIVER-reachable sites — `orders.service.ts`'s `changeStatus()` (no check) and
  `change-requests.service.ts`'s `resolve()` (only `order.routeRun.driverId`, no run/stop status);
  both now reuse `assertDriverMayEditOrder` verbatim. Audit EVERY role-gated write path reachable by
  the same role, not just the one a report named.

## deploy

### L-195 · 2026-09-17/27 · deploy · what lands must equal what was verified (merged: L-228)

- **Symptom:** (L-195, #862) landing #862 silently reverted #861's live P1 fix, which merged after
  #862's branch was cut; both touched one file in non-overlapping regions. (L-228, train A) a 14-PR
  train merged `--no-ff` and verified as one head (tree e98a41e8) landed as a single squash, with
  only a deliberate check to say the squash equalled what was tested.
- **Root cause:** a raw diff of a stale branch against current master reads master's newer hunks as
  removals "belonging to" the branch (and a byte-identity check against the stale branch cannot see
  it); a squash builds its own tree from the PR diff against the current base, so anything that
  moved on master, or a hand-resolved conflict, changes what lands without changing what was
  verified.
- **Lesson:** **A landing diff meant to isolate "this PR's own changes" is taken against the
  branch's OWN MERGE-BASE, never current master; when two in-flight PRs touch the same file, diff
  them against EACH OTHER first. Land a train only after its head is verified and any hand hunk
  (import unions, ratchet rows) is confirmed against the merge-tree; after the squash, compare
  `git rev-parse origin/master^{tree}` with the verified tree and stop on any difference. A
  post-deploy screenshot is not a correctness check — verify the computed state.**
- **Guard:** the merge session's live post-deploy verification and e2e T13's opacity assertion
  caught #862; proposed: the landing tool diffs against `git merge-base <branch> master`, never `master` directly, and warns
  when two open PRs touch one file. Train PR bodies state the expected tree and the coordinator runs
  the comparison (train A: equals e98a41e8); dropped PRs are named with a reason so they re-enter the
  next train. Cf. [[L-197]].

### L-184 · 2026-09-17 · deploy · a migration-carrying PR is not landed until prod has it (#777)

- **Symptom:** #777 merged and deployed with a new `migrations/` folder, but the migration was never
  applied to prod and no drift run happened — undetected for ~26 hours.
- **Root cause:** nothing gates landing a migration-carrying PR on the owner applying it, and
  `post-deploy-check` has no drift check.
- **Lesson:** **A PR that adds a `migrations/` folder is not LANDED until the owner has applied it to
  prod AND the drift run shows exit 0 — a migration is authorized before merge, never assumed to
  happen after. The merge coordinator checks
  `git diff --name-only <base>..<merge> -- apps/api/prisma/migrations` on every landing.**
- **Guard:** none yet — propose that diff as a hard landing gate, and/or a drift check inside
  `post-deploy-check`.

### L-183 · 2026-09-16 · deploy · Railway dual-service deploy status race

- **Symptom:** a merge changing only ONE of two Railway services showed its fresh deploy flip from
  `success` to `inactive` seconds later, reading as failed though the code shipped.
- **Root cause:** both services share one GitHub deployment environment; the untouched service
  re-posts `success` on its OLD sha, and GitHub treats both services' posts as one history.
- **Lesson:** **Never judge a Railway deploy by `.statuses[0].state` alone — that slot can be
  overwritten by the OTHER service's unrelated re-affirm within seconds. Read the full status
  history, or confirm the actually-served commit directly, before declaring a deploy failed or
  successful.**
- **Guard:** none yet — propose `post-deploy-check` reading the full status array or verifying the
  served commit sha.

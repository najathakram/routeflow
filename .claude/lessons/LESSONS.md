# Lessons Learned — RouteFlow

> Generalizable rules this project has paid for. **Read this at the start of every major task,
> implementation, or bug fix** (alongside the code map) and cite entry ids when one changes your
> approach. **After every bug fix, append an entry** — Symptom / Root cause / **Lesson** / Guard —
> and bump [`_meta.json`](_meta.json); Gate 3 of [`../hooks/stop.mjs`](../hooks/stop.mjs) blocks
> fix-shaped turns that don't (a lesson-free fix bumps `_meta.json.updatedAt` to acknowledge).
> Caps: ≤ 52 active entries / 64 KB (set in [`_meta.json`](_meta.json), the values
> `scripts/validate-lessons.mjs` actually enforces) — compact to [`ARCHIVE.md`](ARCHIVE.md). Maintained by the
> `lessons-learned` skill. Blameless; **never client names/slugs/document numbers** — the repo
> goes public briefly for CI.

## process

### L-197 · 2026-09-17/18 · process · verifying landed/unlanded needs a fresh fetch AND the right commit (merged: L-203)

- **Symptom:** two related false "unlanded" verdicts, same underlying mistake. (1) PR #857/B502
  was flagged unlanded by checking that #857's branch-tip commit isn't an ancestor of
  `origin/master` — but #857 landed via a cherry-pick under a new sha, so the fix was fully live
  even though the branch's own commits are correctly absent from master. (2) Separately, the
  fleet lead investigated a different fix's landed status from a 59-commit-stale local
  `routeflow` checkout, concluded — wrongly — it was missing, and broadcast that to two lanes
  before a fresh fetch corrected it.
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
  request — a register that only records other people's mistakes is a register nobody trusts.

### L-201 · 2026-09-18 · process · five registry-id collisions in one session, all from allocating off an incomplete view

- **Symptom:** five id collisions in one fleet window — a lead's "next free" read of merged
  master missing an unmerged PR's reservations; a lane self-resolving to "the next real id" per
  the B499-style protocol, blind to a second branch independently claiming the same id; two
  allocations racing an unconfirmed in-flight request; a fix commit's own id reference going
  stale when its registry record got renumbered during filing; and — after this entry was
  already written — this entry's OWN registry hit a fifth: an unrelated lesson landed on master
  at the same id this entry's branch had already used.
- **Root cause:** each was a *correct* read of an *incomplete* view — merged master, one
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
  reach the same server capability unguarded even after the removed one's own key is clean.
- **Lesson:** **Before removing a UI control (a toggle, a button, a form field), grep for every
  OTHER client entry point that reaches the same server capability/endpoint — not just whether
  server-side code still references the control's own key. A control can be safely deletable as
  UI while the gap it exposed is still wide open through a sibling surface.**
- **Guard:** none yet — propose a removal checklist item: "list every client call site of the
  endpoint(s) this control posts to, not just this control's own references."

## tooling

### L-206 · 2026-09-18 · tooling · a test that pins a literal from another workspace's prose is an invisible cross-workspace coupling

- **Symptom:** `docs-truth.spec.ts` (in `apps/api`) hardcoded the lessons-register byte cap as a
  second literal, mirroring `.claude/lessons/_meta.json`'s value. Editing that JSON file (a
  docs-only change in a different part of the repo) broke this API-workspace spec and took CI
  down repo-wide — nothing signalled that an unrelated API test would fail.
- **Root cause:** a test asserting "doc X says N" by hardcoding N itself creates a coupling
  invisible from either side — the doc's author has no reason to grep `apps/api` before editing
  a `.claude/` config file, and the test's author has no reason to expect the doc to ever
  change. Crossing a workspace boundary means it also crosses whichever team/session boundary
  usually tracks "what does this change affect."
- **Lesson:** **A test that pins a literal sourced from a prose document or config file elsewhere
  in the repo must read that value at test time, never re-type it as a second hardcoded literal —
  and because of this, a "docs-only" change is NOT exempt from the full verify chain whenever it
  touches a value some other workspace's test might have pinned. Grep for the literal itself
  (not just the file) across every workspace before treating a docs edit as safe to skip CI on.**
- **Guard:** `docs-truth.spec.ts` now reads `_meta.json.maxBytes` dynamically (#889); no repo-wide
  grep-for-pinned-literals check exists yet — propose one as part of the docs-only-push exemption
  logic itself.
- Renumbered from L-199: an unrelated "dead CSS" lesson landed on master at that id via #909.

### L-199 · 2026-09-18 · tooling · "dead CSS" needs a structural proof, not a route spot-check

- **Symptom:** investigating B538 (an unreachable `.glass-page .desktop-nav [aria-current="page"]`
  rule), live DOM checks on 2 of the marketing site's 11 routes confirmed `.desktop-nav` is never
  a descendant of `.glass-page` — but that only proves the claim for the routes actually visited.
- **Root cause:** a live DOM spot-check is inherently per-instance and cannot cover routes never
  visited. The marketing app has ONE shared `apps/web/app/(marketing)/layout.tsx` for all 11
  routes, and every `page.tsx` applies `.glass-page` to its own wrapper _inside_ `{children}`
  while the layout renders `<SiteHeader/>` (containing `.desktop-nav`) as a sibling of
  `<main>{children}</main>` — so the non-containment is provable for every route at once by
  reading the layout, not by sampling the DOM.
- **Lesson:** **When justifying a CSS-dead-code removal, prefer a structural proof from the
  shared layout/routing code over live DOM spot-checks on a handful of routes — grep every
  route's wrapper usage (or read the one shared layout) to cover routes you didn't visit,
  including ones added later.**
- **Guard:** `apps/web/app/(marketing)/nav-consistency.test.tsx` renders the real
  `MarketingLayout` with a `.glass-page` child and asserts `.desktop-nav` is never inside it,
  with non-vacuity checks, so a future layout/page restructure fails a test instead of surfacing
  only via another spot-check.

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

### L-191 · 2026-09-17 · tooling · MailboxCard.tsx JSX apostrophes only caught by a full web lint

- **Symptom:** `MailboxCard.tsx` shipped with five raw `'` characters in JSX text nodes
  (`react/no-unescaped-entities`). `tsc`, Jest, and a targeted `eslint` pass on just the changed
  file were all clean; the errors only surfaced under `npm run lint -w apps/web` (`next lint`)
  against the whole workspace.
- **Root cause:** `next lint` fails the ENTIRE web workspace on a single error, and that failure
  reads as noise — dominated by pre-existing warnings elsewhere in the repo, a real new error in
  the diff is easy to mistake for one more line of the existing backlog.
- **Lesson:** **A JSX text change needs web lint run locally before push, not inferred from
  `tsc`/Jest passing — scan the full lint output for NEW errors in the touched file(s) rather
  than assuming a clean `tsc` means the JSX is clean too.**
- **Guard:** none yet — propose a scoped `npm run lint -w apps/web -- --file <changed-file>`
  invocation, or a pre-push step that diffs lint output against a baseline.

### L-192 · 2026-09-17 · tooling · jsdom offsetParent is always null (focus-trap RTL false negative)

- **Symptom:** a focus trap's `getFocusable()` filtered candidates with
  `el.offsetParent !== null`; three RTL tests failed as if the trap never moved focus, while the
  handler's own logic was correct.
- **Root cause:** jsdom has no layout engine, so `offsetParent` (like
  `offsetWidth`/`offsetHeight`) is always `null` regardless of real visibility — the filter
  discarded every candidate, turning the handler into a silent no-op under test.
- **Lesson:** **Never gate a DOM-query result on a layout-dependent property (`offsetParent`,
  `offsetWidth`/`offsetHeight`, `getBoundingClientRect`) in code exercised by RTL/jsdom — use
  `getComputedStyle` for a visibility check jsdom actually computes, or say in a comment the
  check is real-browser-only.**
- **Guard:** `ResponsiveSidebar.tsx`'s `getFocusable()` carries no visibility filter, with a
  comment stating why (everything rendered while the drawer is open is meant to be reachable).

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

### L-196 · 2026-09-17 · tooling · a config file silently overriding a code default drifts from its docs

- **Symptom:** CLAUDE.md and this file's own header both stated the lessons register caps at 40
  entries / ~25–40 KB; the register had run at 52/64 KB all along with zero validator complaints,
  since `_meta.json`'s own fields silently override `validate-lessons.mjs`'s hardcoded defaults.
- **Root cause:** the validator's fallback defaults exist only for a repo with no `_meta.json`
  yet, but nothing re-derives or checks the DOCS against whichever value is actually live — a
  limit living in a data file can drift from every doc describing it with no warning.
- **Lesson:** **When a limit lives in a config/data file with a code-level fallback default, the
  code's default is not the source of truth once the config sets a real value — read the
  validator's own resolved value, never infer it from source or a doc, and update every doc
  stating the limit in the SAME commit the config changes it.**
- **Guard:** the validator already prints its resolved values in its self-consistency line;
  propose a periodic doc-vs-validator cross-check.

### L-182 · 2026-09-16 · tooling · #799 self-test wall-clock regression (host vs CI)

- **Symptom:** #799 added spawn-heavy self-test cases; wall-clock went from 63–131s to 487s on
  the dev host, breaking every local pre-push, while CI's faster runner stayed green throughout.
- **Root cause:** a PR changing self-test/verify tooling was judged solely on CI's green check —
  CI's runner speed isn't this host's, so a wall-clock regression invisible on CI can still
  break every subsequent local pre-push on the machine that actually does the work.
- **Lesson:** **A PR touching a self-test or verify-tooling script must be measured, or run
  through the full local pre-push, on the actual dev host before merge — CI green is not a
  sufficient gate for tooling-timing changes, only for correctness.**
- **Guard:** the merge session re-measures self-test wall-clock during its scoped review.

### L-180 · 2026-09-16 · tooling · npm/dir junctions across worktrees are unsafe near git worktree ops

- **Symptom:** (a) after `git worktree move`, invalid-hook-call errors and mangled Jest paths;
  (b) a scratch worktree junctioned to a SIBLING's `node_modules` (to dodge `npm install` under
  disk pressure), then `git worktree remove --force` on the scratch tree cascaded a recursive
  delete through the junction, wiping the sibling's `node_modules` and ~2,388 tracked files.
- **Root cause:** Windows npm junctions are absolute-path reparse points, invisible to git and
  not junction-aware to a naive recursive delete — `worktree move` leaves one pointing at the OLD
  path forever; `worktree remove --force`/`rm -rf` walks THROUGH one into its real target.
- **Lesson:** **Never let a junction outlive the git worktree op around it. After
  `git worktree move`, treat `node_modules` as stale — `npm ci` (+ `prisma generate` for
  apps/api) at the final path. Before removing/recursively deleting ANY worktree, `rmdir`
  (never `rm -rf`) every junction inside it first. Best: never junction `node_modules` between
  two DIFFERENT live worktrees — the disk saved isn't worth the blast radius.**
- **Guard:** none yet — propose a pre-remove check refusing `git worktree remove` while a
  junction exists under the tree, plus a post-move check comparing a junction's target to cwd.

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

### L-177 · 2026-09-16 · tooling · squash-simulate docs

- **Symptom:** master's code-map `mappedSha` pointed at a branch commit orphaned by a squash
  merge; `validate-code-map` failed every local pre-push.
- **Root cause:** the stamping step simulated the merge with `git merge --no-ff` locally instead
  of `--squash` (the strategy the PR would actually land with), so the sha it stamped never
  existed on master's real history.
- **Lesson:** **A script stamping a value for a squash-merged PR must simulate the ACTUAL merge
  strategy (`--squash`), never `--no-ff` — validate the stamped sha resolves on the target branch
  before landing.**
- **Guard:** none yet — propose `--stamp` refusing a sha that isn't reachable from master.

### L-176 · 2026-09-16 · tooling · worktree without its own node_modules resolves to the main checkout

- **Symptom:** a worktree with no `node_modules` of its own resolved workspace deps up to the
  MAIN checkout's — a stale compiled `@routeflow/pricing` dist threw a missing-function error.
- **Root cause:** npm workspace symlinks/junctions in a worktree missing its own `npm ci` fall
  back to whatever the main checkout last had installed/built — never a guarantee of freshness.
- **Lesson:** **A worktree needs its OWN `npm ci` before running web/api tests. After any
  `packages/*` change lands on master, rebuild the shared dist in the main checkout too.**
- **Guard:** none yet — propose a pre-test check comparing `packages/*/dist` mtimes against
  source.

### L-175 · 2026-09-16 · tooling · shared dev host disk budget

- **Symptom:** the shared dev host's `C:` drive hit 0 bytes free, stalling every session with no
  warning until root-caused.
- **Root cause:** ~28 worktrees' `node_modules`/`.next` plus accumulated Docker/WSL/npm caches
  consumed the whole disk; nothing monitored free space before it hit zero.
- **Lesson:** **A shared dev host running N concurrent worktrees needs a disk-budget gate — warn
  below a threshold before launching more work, not after operations start failing.**
- **Guard:** none yet — propose a session-start hook warning at < 30 GB free.

### L-174 · 2026-09-16 · tooling · demo-booking lane (raw NUL byte from an escape literal)

- **Symptom:** a source file kept "working" after an agent tool chain wrote a `\uXXXX`-shaped
  escape literal into it — until `file`/git/prettier treated it as binary, because what actually
  landed was the raw byte the escape describes, not the 6-char sequence.
- **Root cause:** a tool-chain step decoded the escape before the write, turning a literal meant
  to stay text into its raw byte — nothing downstream checked the file was still actually text.
- **Lesson:** **After writing any escape-sequence literal through an agent tool chain, verify it
  landed as literal text, not the decoded byte.**
- **Guard:** `file <path>` (must say "text") or `grep -cP '\x00' <path>` (must be 0) before
  trusting the write; a pre-commit NUL-byte check on text sources is the durable fix.

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

## domain

### L-204 · 2026-09-18 · domain · B524 fix round — a new write path didn't inherit a sibling's cache-invalidation fix

- **Symptom:** granting a prerequisite via `FeatureOverrideService.create()`/`.revoke()` then
  acting on the new requires check could read a stale snapshot and false-400 for up to 30s —
  those methods invalidated only their own override cache, never `FeatureResolverService`'s
  separate cache the new check reads.
- **Root cause:** `AddonService` already had this exact bug fixed (B509). B524 added the same
  requires check to a SECOND write path reading the same cache; a fix on one writer doesn't
  propagate to a sibling by analogy, only by someone applying it there too.
- **Lesson:** **When a new check reads a cache another writer is allowed to leave briefly
  stale, audit EVERY writer of that value for whether it already invalidates the SAME cache.**
- **Guard:** `createFeatureOverride`/`revokeFeatureOverride` now call
  `EntitlementAuthority.invalidate(tenantId)`, mirroring B509;
  `platform-admin.controller.override-requires.spec.ts` pins both calls directly.
- Attribution: candidate from Lane D (PR #913), originally filed as "L-199" from a stale local
  view of the register (already taken here); renumbered on fold-in.

### L-187 · 2026-09-17 · domain · demo-booking slot TOCTOU (check-then-insert race)

- **Symptom:** two concurrent bookings for the same slot could both pass an application-level
  "is this slot free" check before either had written its row, so both inserted.
- **Root cause:** the availability check and the insert were two separate statements with no
  atomicity between them — an application-level check can only narrow the race window, never
  close it.
- **Lesson:** **A slot/resource booking that must never double-allocate needs the DB to enforce
  it, not application code — a partial unique index (`WHERE status != 'CANCELLED'`) makes the
  second concurrent insert fail atomically at the constraint, instead of racing an app-level
  read.**
- **Guard:** the `demo_booking_race_guard` migration's partial unique index; a concurrent-insert
  regression test proves the second request gets a real constraint violation.

### L-189 · 2026-09-17 · domain · B466 (substitute path bypassed the tier-aware pricer)

- **Symptom:** substituting a product on an order item priced the new line at LIST regardless of
  the customer's SPECIAL-tier contract price, on a code path nobody had ever pointed a tier-3
  customer at before.
- **Root cause:** the substitution branch was its own independent price path — it reused neither
  `resolveBuyerLinePrice`'s tier resolution nor the batched `CustomerPrice` lookup the ADD/UPDATE
  branches share, so it defaulted to list price with no way to learn a per-product tier existed.
- **Lesson:** **A new mutation path onto an already-priced entity (substitute, replace, clone)
  must resolve price through the SAME tier-aware pricer AND read from the SAME batched
  price-lookup key set every sibling path uses — a fresh reimplementation silently regresses to
  the simplest case.**
- **Guard:** `orders.service.spec.ts`'s B466 suite (SPECIAL-tier substitute prices at tier, not
  list; batched lookup includes `substituteProductId`). Sibling [[L-072]] (reuse vs.
  reimplement, applied to a pricer instead of an enum).

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

### L-181 · 2026-09-16 · domain · B451 (dto `any` vs real callers)

- **Symptom:** replacing `estimates.controller.ts`'s `@Body() dto: any` with a real
  `CreateEstimateDto` made a line-item's `description` required — but `scripts/feature-smoke.mjs`
  S6 and several `qa-run.js` tests send a bare `{productId, qty}`, relying on the service's own
  fallback. Caught only by independent review, not the author.
- **Root cause:** the DTO's field set was derived from the primary web UI form alone;
  scripted/feature-smoke callers were never grepped.
- **Lesson:** **Before typing a `dto: any` endpoint (or tightening any field's optionality), grep
  every caller — web form, mobile, feature-smoke, qa-run, e2e — not just the UI form that
  motivated the change.**
- **Guard:** `create-estimate.dto.spec.ts` pins the bare `{productId, qty}` shape passing the
  real `ValidationPipe` unchanged.

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

### L-173 · 2026-09-16 · domain · B449 (Lite lane, plan-gate boundary)

- **Symptom:** a plan-gated page kept firing its own effects/queries while a locked/blurred
  overlay showed over it — its 403 toasts and query errors leaked to a user who should never
  have triggered that behavior.
- **Root cause:** the gate ghosted the real page behind blur/opacity by rendering it as
  `children` inside the locked view's own slot — that hides the DOM, it doesn't unmount it.
- **Lesson:** **A route guard choosing between locked and unlocked must render exactly ONE of
  two subtrees, never wrap the real page inside the locked view's ghost slot — a component
  hidden behind blur/opacity is still mounted, and its effects/queries still fire.**
- **Guard:** a route boundary needs a real "still resolving" state distinct from both outcomes;
  `layout.plan-gate-boundary.test.tsx` pins children absent from the tree while
  resolving/locked, not just visually hidden.

### L-169 · 2026-09-16 · domain · B421 / PR-1a shared-helper precondition no-op (two call sites)

- **Symptom:** two surfaces hit the same shape: a shared helper re-checked `.status` generically,
  but the callers' own `select` never fetched it, so it silently read `undefined`. Both tests
  passed anyway because their mocks supplied the field directly.
- **Root cause:** a shared helper that re-derives a precondition has no knowledge of a caller's
  query shape — it assumes the field is present, and a caller whose `select` never needed it
  before silently hands the helper `undefined`, which the check absorbs as real.
- **Lesson:** **Before wiring a caller into a shared helper that re-derives a precondition
  generically, check the caller's `select` actually fetches the field — a mock supplying it
  directly proves nothing. A type-check alone won't catch a field silently resolving to
  `undefined`.**
- **Guard:** both selects now fetch `status`; `returns-lineitems-select.spec.ts` pins the real
  shape at every call site.

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

### L-171 · 2026-09-16 · domain · PR-1a F1 (pooled cap vs single-line price basis mismatch)

- **Symptom:** an over-return cap was correctly widened from "one matched line" to "pooled across
  every live line for that product" — but the sibling pricing branch, reading the SAME key,
  still priced off one matched line's rate against the newly-pooled quantity, over-crediting a
  product split across two differently-priced lines.
- **Root cause:** the cap and the price are two different readers of one key. Widening one
  reader's basis fixed that reader alone — nothing re-examined the sibling reading the same key.
- **Lesson:** **When a guard/cap computation for a key is widened to pool across rows, grep
  every OTHER reader of that key — a cap and a price computed from different bases silently
  mismatch, and the mismatch is a MONEY bug.**
- **Guard:** the pricing branch now pools qty/subtotal the same way the cap does, with a
  `min(returned, sold)` backstop; `returns-refund.spec.ts`'s F1 cases prove the pooled pricing.

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

### L-081 · 2026-09-06 · domain · F09

- **Symptom:** wallet credit kept being consumed by WRITTEN_OFF (forgiven) invoices after the
  settle query had excluded VOID — a fix at that query would still have missed the auto-apply
  path (`send()`/`sendEmail()`), and a test whose mock injects the query result couldn't even
  see a `where`-only fix.
- **Root cause:** the guard lived at one call site's query instead of at the money write; four
  hand-rolled status lists (manual apply, settle, delivery payments, advance wallet) had drifted
  apart, and PAID had to stay in the settle set because the same loop shrinks excess credit.
- **Lesson:** **Gate a money write inside the primitive that performs it, on the row it just read
  (an exclude-list, so a fixture without the field still writes) — sibling primitives and
  result-injecting mocks bypass a where-only fix; keep every status set in one named module with
  the reason each differs written beside it.**
- **Guard:** REG-B67/REG-B66 T1–T11 (incl. the auto-apply door) in
  `credit-notes.wallet-integrity.spec.ts`; `apps/api/src/invoices/invoice-status-sets.ts` is the
  one home.

### L-116 · 2026-09-12 · tooling · plane self-test machine-root invariants

- **Symptom:** a lead's pre-push verify failed at a plane self-test's "shared runs.jsonl
  byte-unchanged" check — ANOTHER session's own hooks had legitimately appended to it mid-run.
- **Root cause:** every "byte-identical before/after" invariant in the plane self-tests binds on
  `machineRoot()`'s shared dir (see [[L-114]]) — the SAME dir every worktree resolves to — so it
  races any other session, not just a concurrent run of the same suite.
- **Lesson:** **A self-test invariant must never bind to a shared machine-local file — assert
  only on fixtures the run owns. A file another session can write at any moment needs a
  throwaway stand-in, never the real shared path.**
- **Guard:** `PLANE_MACHINE_ROOT` (gated behind `PLANE_SYNC_SELF_TEST=1`) lets every plane
  self-test point `machineRoot()` at its own temp root; `T-concurrent-writer` proves isolation
  under a genuine concurrent writer. Related [[L-114]].

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

### L-145 · 2026-09-14 · domain · mobile scan-to-order, staged-edit persistence

- **Symptom:** a new per-order "staged edits" snapshot was flagged as a likely violation of R1
  (local persistence must go through the user-scoped zustand `persist` store, never a raw
  AsyncStorage key, to prevent one user's work surfacing under the next login).
- **Root cause:** R1 was written against a single-blob-per-user shape. This snapshot is
  one-per-ORDER — a single zustand store can't hold a dynamic per-order keyspace, so the code
  used a `<userId>:<orderId>` AsyncStorage keyspace instead, with a teardown routine enumerating
  and wiping every key under a user's prefix on logout.
- **Lesson:** **A binding rule written for one shape does not automatically bind a different
  shape the same way. Check what invariant the rule actually protects — here, no cross-user
  data leak — and whether the deviation still satisfies THAT, not just whether it uses the
  literal mechanism. Verify the substitute mechanism is real (grep the teardown/hydrate wiring),
  don't take a code comment's claim on faith.**
- **Guard:** `session-teardown.ts` imports and calls the snapshot's own prefix-clear helper —
  grep for it before trusting this reasoning again on the same file.

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

### L-207 · 2026-09-19 · domain · B562 (averageCost recomputed by replaying an incomplete StockMovement ledger)

- **Symptom:** recomputing a product's `averageCost` by replaying its `StockMovement` ledger
  silently overwrote a correct `averageCost` and rewrote every `stockAfter`/`avgCostAfter`
  snapshot, destroying the evidence needed to notice.
- **Root cause:** order create/edit decrements `Product.currentStock` with NO `StockMovement` row
  (`orders.service` `decrementStockForSale` / `settleStockForEdit`), so the ledger was an
  incomplete event log; the replay started from stock=0 and never read orders, so it computed cost
  from a sales-blind history.
- **Lesson:** **Never recompute derived state (a cost, a balance) by replaying an event log unless
  the log is provably complete — assert completeness (ledger-implied stock vs the live counter)
  and REFUSE or REPORT on divergence rather than write a plausible-looking wrong number. When the
  refusal sits inside a shared transaction (a bill/batch with many lines), degrade per item (skip
  the replay for the gapped item and report it) rather than failing the whole batch — a
  fail-closed guard that blocks accounts-payable is its own outage.**
- **Guard:** behavioral specs in `apps/api/src/inventory/inventory.service.spec.ts`
  (`replayProduct` two-pass refuse-on-gap; null-cost import leaves `averageCost` untouched),
  `apps/api/src/vendor-bills/vendor-bills.service.spec.ts` (two-line bill: gapped line still
  received and reported under `gapsDetected`, clean line unaffected),
  `apps/api/src/products/products.service.spec.ts` and
  `apps/api/src/import/import-robustness.spec.ts` (no phantom `unitCost` 0). PR #934; follow-ups
  B567/B568 filed.

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

### L-178 · 2026-09-16 · security · demo-booking PR-2 (raw error message leak)

- **Symptom:** a public-facing catch handler rendered a caught error's `.message` verbatim, so
  an unauthenticated route could show NestJS's own raw 404 body instead of a curated message.
- **Root cause:** the load path assumed every reachable error was one of its own curated
  exceptions; it never accounted for a transport-level failure with no safe message behind it.
- **Lesson:** **A public unauthenticated page's catch handler must show a FIXED, generic message
  for any path that can receive a transport-level failure, never `error.message` — a curated
  message is safe to show only when every source feeding that catch is known and typed.**
- **Guard:** `demo-scheduler.test.tsx` pins a raw framework 404, a bare network failure, and a
  raw 500 all rendering the SAME fixed message, never the response body.

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
- **Guard:** the merge session's live post-deploy verification caught this one in practice, plus
  the pre-existing e2e T13 opacity assertion. Propose: the landing tool diffs against
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

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

### L-197 · 2026-09-17 · process · #857 flagged "unmerged" by checking the wrong commit's ancestry

- **Symptom:** a peer flagged bookkeeping-batch PR #873 for citing B502/#857 as landed, based on
  checking that #857's original PR-branch tip commit is not an ancestor of `origin/master` —
  and asked to reopen B502 and drop the code-map entry. `merge-base --is-ancestor` against the
  actual landing commit (`0a365054`, found via `git log --grep`/the PR's own `mergeCommit.oid`),
  plus a direct read of that commit's content in `origin/master`'s current tree, both confirmed
  the fix is genuinely live — the correction would have reopened an already-fixed bug.
- **Root cause:** #857 landed via a cherry-pick onto master under a NEW sha ("Cherry-picked from
  the original 45+-commit-behind branch, verified byte-identical to its content") rather than a
  merge of the branch tip — so the original branch's own commits are genuinely, correctly absent
  from master's history, even though the fix itself is fully present under a different sha.
  Checking ancestry (or eyeballing branch state) against the wrong candidate commit produces a
  confident, wrong "unlanded" verdict for a bug that is actually fixed.
- **Lesson:** **Before citing a bookkeeping/registry closure as landed or unlanded, resolve the
  SPECIFIC commit that is supposed to carry the fix on master first — via `git log --grep` for
  the PR's own `(#N)` tag, or the GH API's `mergeCommit.oid` — then run `merge-base
  --is-ancestor <that sha> origin/master`. Never check the source branch's tip commit or infer
  merge state from GitHub's PR view alone: a squash or cherry-pick can leave a branch's own
  commits genuinely off master while its content is fully live under a different sha.**
- **Guard:** none yet — propose the batch/landing checklist require pairing every
  `already-fixed --pr <n>` citation with a recorded check that satisfies BOTH halves, either
  one alone still lets the wrong verdict through: (1) resolve the actual **landing commit**
  from `gh pr view <n> --json mergeCommit` — never the source branch's tip — and (2) run
  `merge-base --is-ancestor <that landing sha> origin/master` on **full, unshallowed history**,
  since a shallow clone's grafted boundary can misreport ancestry. A PR number in a list is not
  evidence that it landed.

## tooling

### L-191 · 2026-09-17 · tooling · MailboxCard.tsx JSX apostrophes only caught by a full web lint

- **Symptom:** `MailboxCard.tsx` (email-connect-google/#824, email-connect-microsoft/#830/#841)
  shipped with five raw `'` characters in JSX text nodes (`react/no-unescaped-entities`). `tsc`,
  Jest, and a targeted `eslint` pass on just the changed file were all clean; the errors only
  surfaced when `npm run lint -w apps/web` (i.e. `next lint`) ran against the whole workspace.
- **Root cause:** `next lint` fails the ENTIRE web workspace on a single error, and that failure
  reads as noise — the run's output is dominated by pre-existing warnings elsewhere in the repo,
  so a real new error in the diff is easy to mistake for one more line of the existing warning
  backlog instead of the thing that actually failed the run.
- **Lesson:** **A JSX text change needs web lint run locally before push, not inferred from
  `tsc`/Jest passing — `next lint` fails the whole workspace on one error, and the failure hides
  behind pre-existing warnings, so scan the full lint output for NEW errors in the touched
  file(s) rather than assuming a clean `tsc` means the JSX is clean too.**
- **Guard:** none yet — propose `npm run lint -w apps/web -- --file <changed-file>`-style
  scoped invocation, or a pre-push hook step that diffs lint output against a baseline so a new
  error can't hide in the existing warning noise.

### L-192 · 2026-09-17 · tooling · jsdom offsetParent is always null (focus-trap RTL false negative)

- **Symptom:** a focus trap's `getFocusable()` filtered candidates with `el.offsetParent !==
null`; three RTL tests failed as if the trap never moved focus at all, while the handler's own
  logic was correct.
- **Root cause:** jsdom has no layout engine, so `offsetParent` (like `offsetWidth`/`offsetHeight`)
  is always `null` regardless of real visibility — the filter discarded every candidate element,
  turning the handler into a silent no-op under test.
- **Lesson:** **Never gate a DOM-query result on a layout-dependent property (`offsetParent`,
  `offsetWidth`/`offsetHeight`, `getBoundingClientRect`) in code exercised by RTL/jsdom — use
  `getComputedStyle` for a visibility check jsdom actually computes, or accept the check is
  real-browser-only and say so in a comment so a future "why does this always fail under test"
  isn't re-diagnosed from scratch.**
- **Guard:** `ResponsiveSidebar.tsx`'s `getFocusable()` carries no visibility filter, with a
  comment stating why (everything rendered while the drawer is open is meant to be reachable).

### L-193 · 2026-09-17 · tooling · bugs.mjs index carries catalogue-only fields forward BY ID POSITION

- **Symptom:** renumbering 17 filed bug records (renaming their `.md` files +3 to dodge an id
  collision with another open PR) then running `bugs.mjs index` to regenerate `bugs.jsonl`
  scrambled every shifted row's `symptom`/`filedAt` onto the WRONG finding — the new id briefly
  carried one finding's title with a completely different finding's symptom text.
- **Root cause:** `symptom`/`filedAt` (and other catalogue-only fields) have no home in a
  record's own front matter, so `index` cannot re-derive them from the `.md` file — it carries
  forward whatever the PRIOR catalogue row held at that SAME id, which after a rename is a
  stale, orphaned row, not the record that now actually lives there.
- **Lesson:** **`bugs.mjs index`/`expand` regenerate a record's DERIVABLE fields from its front
  matter, but a catalogue-only field is carried forward by id lookup, not by identity — renaming
  a record's file to change its id does NOT bring these fields with it. To renumber, pull each
  row's ORIGINAL catalogue entry (from git history, before the rename), remap only its `id`
  field, and splice it back in directly; never trust `index`'s carry-forward across an id
  change. Diff for net-zero (equal insertions/deletions, nothing orphaned or duplicated) before
  committing any bulk-id rewrite.**
- **Guard:** none yet — propose a `bugs.mjs renumber <old> <new>` command that does the safe
  remap atomically, or a self-test case that renames a fixture record and asserts `index`
  refuses/warns instead of silently carrying forward mismatched fields.

### L-194 · 2026-09-17 · tooling · preview_start binds to the main checkout, not the calling session's worktree

- **Symptom:** a UI proof for a worktree branch (`feat/collapsible-sidebar`) via
  `preview_start({name})` started servers fine and produced plausible-looking screenshots, but a
  responsive CSS breakpoint that definitely existed in the branch's code appeared completely
  broken — grepping the main checkout's own copy of the changed file found zero references to
  the new component, still the old markup.
- **Root cause:** `preview_start` launches its named `launch.json` configs from the MAIN
  CHECKOUT's working directory, never the calling session's actual worktree — a worktree branch
  whose changes aren't ALSO checked out in the main checkout gets proofed against stale,
  unrelated code with no error or warning.
- **Lesson:** **A UI proof for a worktree/branch not checked out in the main checkout must run
  its OWN dev server FROM the worktree** (`node dist/main.js` with env sourced explicitly for a
  built API, `next dev -p <port>` for web) **rather than `preview_start`, and must positively
  verify what's actually being served — grep the rendered HTML/response for something only the
  branch's changes would produce — before trusting any screenshot as proof. A server coming up
  and a page looking plausible is not evidence the right code is running.**
- **Guard:** none yet — propose a one-line reminder in whichever runbook covers worktree UI
  proofs: confirm the served code matches the branch BEFORE capturing, not after a screenshot
  looks wrong.

### L-190 · 2026-09-17 · tooling · FG-B (#819) had to be rebuilt, not rebased, after FG-A squash-merged

- **Symptom:** #819 (FG-B, feature-override kind + MRR exclusion) conflicted after #825 (FG-A,
  the shadow resolver) squash-merged to master. #819 carried FG-A's own schema+contract commit
  (stacked locally before either landed), and master's squash-merge of that same content under a
  NEW sha meant #819's branch and master now disagreed about whether that commit's content was
  "already applied" — a normal `git rebase`/`git merge origin/master` treats it as new content to
  reconcile a second time, corrupting the schema state instead of cleanly resolving.
- **Root cause:** two PRs stacked on a shared, not-yet-landed schema/contract commit — when the
  owner squashes the FIRST one, the commit that content came from no longer exists on master
  under its original identity, so any operation that diffs/merges by commit history (rebase,
  ordinary merge) sees a phantom conflict between "the same change, twice."
- **Lesson:** **A PR stacked on another PR's not-yet-landed schema/contract commit must be
  REBUILT from a fresh branch off the post-squash master — by cherry-picking only its OWN
  commits (never the shared ancestor commit, never a merge commit) — once the base PR lands.
  Never rebase or ordinary-merge a stacked branch through someone else's squash.**
- **Guard:** none automatic yet — a landing coordinator diffs `origin/master...HEAD` on the
  rebuilt branch and confirms zero changes under the schema-owning PR's files (e.g. `prisma/`)
  before pushing, proving only the stacked PR's own commits landed.

### L-196 · 2026-09-17 · tooling · a config file silently overriding a code default drifts from its docs

- **Symptom:** CLAUDE.md and `LESSONS.md`'s own header both stated the lessons register caps at
  40 entries / ~25–40 KB; the register had been running at 52 entries / 64 KB all along with zero
  validator complaints, since `_meta.json`'s own `maxEntries`/`maxBytes` fields silently override
  `validate-lessons.mjs`'s hardcoded defaults whenever present.
- **Root cause:** the validator's fallback defaults exist for a repo with no `_meta.json` yet,
  but nothing ever re-derives or checks the DOCS against whichever value is actually live — a
  limit that lives in a data file, not a source-code constant, can drift from every doc
  describing it with no error, no warning, and no diff to review.
- **Lesson:** **When a limit lives in a config/data file with a code-level fallback default, the
  code's default is not the source of truth once the config file sets a real value — read the
  validator's own resolved value, never infer it from source or from a doc, and update every doc
  that states the limit in the SAME commit whenever the config changes it.**
- **Guard:** none yet — the validator already prints its resolved values in its self-consistency
  line; propose a periodic doc-vs-validator cross-check so drift is caught before it ages.

### L-186 · 2026-09-17 · tooling · web code-map catch-up (layout.tsx named re-export)

- **Symptom:** an App Router `layout.tsx` re-exported a named client component. It compiled
  clean in prod (`ignoreBuildErrors` masked it) but broke only under `next dev`'s typed-routes
  checking.
- **Root cause:** neither CI nor `check-types` runs the pass that catches this — a named export
  from a Next.js App Router special file is invisible to both the type checker and the
  production build's relaxed error mode.
- **Lesson:** **`layout.tsx` may export only `default`, `metadata`, `viewport`, and Next's own
  segment-config exports — never a named re-export of shared logic. Put shared logic in its own
  file, imported by the layout.**
- **Guard:** `apps/web/app/layout-exports.test.ts` walks every layout in the app tree and
  asserts its export set stays within the allowed list (currently covers ≥ 6 layout files).

### L-182 · 2026-09-16 · tooling · #799 self-test wall-clock regression (host vs CI)

- **Symptom:** #799 added spawn-heavy self-test cases; the self-test's wall-clock went from
  63–131 s to 487 s on the dev host, breaking every local pre-push, while CI (a faster runner)
  stayed green throughout. The same pattern hit #786's `mappedSha` stamping earlier.
- **Root cause:** a PR that changes self-test/verify tooling was judged solely on CI's green
  check — CI's runner speed is not this host's, so a wall-clock regression invisible on CI can
  still break every subsequent local pre-push on the machine that actually does the work.
- **Lesson:** **A PR touching a self-test or verify-tooling script must be measured, or run
  through the full local pre-push, on the actual dev host before merge — CI green is not a
  sufficient gate for tooling-timing changes, only for correctness.**
- **Guard:** the merge session re-measures self-test wall-clock during its scoped review.

### L-180 · 2026-09-16 · tooling · npm/dir junctions across worktrees are unsafe near git worktree ops

- **Symptom:** (a) after `git worktree move`, invalid-hook-call errors and mangled Jest paths —
  looked like [[L-055]]'s dot-directory glob bug, but wasn't; (b) 2026-09-17: a scratch worktree
  was junctioned to a SIBLING's `node_modules` (to dodge an `npm install` under a disk-critical
  constraint), and `git worktree remove --force` on the scratch tree cascaded a recursive delete
  through the junction, wiping the sibling's `node_modules` and ~2,388 of its tracked files.
- **Root cause:** Windows npm junctions are absolute-path reparse points, invisible to git and
  not junction-aware to a naive recursive delete — `worktree move` leaves one pointing at the OLD
  path forever; `worktree remove --force`/`rm -rf` walks THROUGH one into its real target instead
  of unlinking the reparse point.
- **Lesson:** **Never let a junction outlive the git worktree op around it. After
  `git worktree move`, treat `node_modules` as stale — `npm ci` (+ `prisma generate` for
  apps/api) at the final path. Before removing/recursively deleting ANY worktree, `rmdir` (never
  `rm -rf`) every junction inside it and confirm it's gone first. Best: never junction
  `node_modules` between two DIFFERENT live worktrees — the disk saved isn't worth the blast
  radius.**
- **Guard:** none yet — propose a pre-remove check refusing `git worktree remove` while a
  junction exists under the tree, plus a post-move check comparing a junction's target to cwd.

### L-179 · 2026-09-16 · tooling · campaign-check freshness ritual

- **Symptom:** every push cost 2–3 failed attempts (~40 min total) against `campaign-check`'s
  freshness gate.
- **Root cause:** the gate compares each workspace report against the newest commit timestamp of
  ANY file (even an unrelated digest regen), and `turbo run test --force` can still cache-skip the
  report-writing step — so the report can never get newer than the commit that triggers the check.
- **Lesson:** **A freshness gate keyed on "newest commit, any file" false-fails when its own
  report-writing step can be cache-skipped.** Ritual until fixed: commit everything first, run
  `npx jest --maxWorkers=2` per workspace directly (bypasses the turbo cache), then push
  immediately.
- **Guard:** none yet — propose keying freshness on commits touching source/test/ledger paths
  only, and having the pre-push hook regenerate reports itself.

### L-177 · 2026-09-16 · tooling · squash-simulate docs

- **Symptom:** master's code-map `mappedSha` pointed at a branch commit orphaned by a squash
  merge; `validate-code-map` failed every local pre-push (CI only warned — it lacks the object).
- **Root cause:** the stamping step simulated the merge with `git merge --no-ff` locally instead
  of `--squash` (the strategy the PR would actually land with), so the sha it stamped never
  existed on master's real history.
- **Lesson:** **A script stamping a value for a squash-merged PR must simulate the ACTUAL merge
  strategy (`--squash`), never `--no-ff` — validate the stamped sha resolves on the target branch
  before landing.**
- **Guard:** none yet — propose `--stamp` refusing a sha that isn't reachable from master.

### L-176 · 2026-09-16 · tooling · worktree without its own node_modules resolves to the main checkout

- **Symptom:** a worktree with no `node_modules` of its own resolved workspace deps up to the
  MAIN checkout's — a stale compiled `@routeflow/pricing` dist threw
  `resolveConfirmedAmounts is not a function`; `node_modules`-only deps were unreachable.
- **Root cause:** npm workspace symlinks/junctions in a worktree missing its own `npm ci` fall
  back to whatever the main checkout last had installed/built — never a guarantee of freshness.
- **Lesson:** **A worktree needs its OWN `npm ci` before running web/api tests. After any
  `packages/*` change lands on master, rebuild the shared dist in the main checkout too.**
- **Guard:** none yet — lead rebuilt manually; propose a pre-test check comparing
  `packages/*/dist` mtimes against source.

### L-175 · 2026-09-16 · tooling · shared dev host disk budget

- **Symptom:** the shared dev host's `C:` drive hit 0 bytes free (~10:00–11:30Z), stalling every
  session — build/npm/git operations failed with no warning until root-caused.
- **Root cause:** 28 worktrees' `node_modules`/`.next` (~1.9 GB each) plus accumulated
  Docker/WSL/npm caches consumed the whole disk; nothing monitored free space before it hit zero.
- **Lesson:** **A shared dev host running N concurrent worktrees needs a disk-budget gate — warn
  below a threshold before launching more work, not after operations start failing.**
- **Guard:** none yet — propose a session-start hook warning at < 30 GB free.

### L-172 · 2026-09-16 · tooling · #779 (nested timeout mismatch)

- **Symptom:** raising a Jest test's own timeout to fix one flake introduced a new, harder-to-
  diagnose flake in the same test.
- **Root cause:** the test's Jest-level timeout was raised without raising the timeout on the
  `spawnSync` call running _inside_ it, so the inner call now times out and throws before Jest's
  own outer timeout would ever fire — moving the failure mode to a confusing error shape instead
  of fixing it.
- **Lesson:** **When a test wraps a call with its own timeout (spawnSync, an HTTP client, a DB
  pool), raising the test's outer timeout without raising the inner one moves the failure mode,
  it doesn't fix it — always raise both together, inner first.**
- **Guard:** none named in the PR body — propose a lint/review checklist item pairing any Jest
  `testTimeout`/`jest.setTimeout` edit with a check for an inner call's own timeout in the same
  test.

### L-174 · 2026-09-16 · tooling · demo-booking lane (raw NUL byte from an escape literal)

- **Symptom:** a source file kept "working" after an agent tool chain wrote a `\uXXXX`-shaped
  escape literal into it — until `file`/git/prettier treated it as binary, because what actually
  landed was the raw byte the escape describes (a NUL in a `.ts` file), not the 6-char sequence.
- **Root cause:** a tool-chain step decoded the escape before the write, turning a literal meant
  to stay text into its raw byte — nothing downstream checked the file was still actually text.
- **Lesson:** **After writing any escape-sequence literal through an agent tool chain, verify it
  landed as literal text, not the decoded byte — a file can silently stop being text the moment
  one write step decodes what should have stayed escaped.**
- **Guard:** `file <path>` (must say "text") or `grep -cP '\x00' <path>` (must be 0) before
  trusting the write; a pre-commit NUL-byte check on text sources is the durable fix.

### L-168 · 2026-09-16 · tooling · B421 CASH_METHOD_FILTER as-const gap

- **Symptom:** `CASH_METHOD_FILTER`, a Prisma `notIn` filter constant, shipped with no real call
  site yet. Its sibling `RECEIVED_METHOD_FILTER` was wired into a live `where` clause first and
  immediately failed `tsc` — its array had widened to `string[]` for want of `as const`, which
  Prisma's generated enum filter rejects. Checking the still-unused sibling found the same gap.
- **Root cause:** a constant with no consumer can't fail a type check that only runs where it's
  used — "compiles clean" meant nothing until a real call site exercised the type, so two
  identically-built constants drifted: one was caught by chance, the other was not.
- **Lesson:** **A typed constant with no call site yet is unproven, not correct — the moment one
  sibling constant (same file, same shape, same commit) fails a type check for something subtle
  like a missing `as const`, grep for every other constant built the same way.**
- **Guard:** both constants now carry `as const` with an inline comment
  (`packages/pricing/src/payment-confirmation.ts`); `payment-confirmation.spec.ts` pins both
  filters' exact shape.

### L-105 · 2026-09-11 · tooling · train-4 engine gate

- **Symptom:** two engine runs lost their whole Jest gate to one flag position — a spec path
  placed after `--reporters=default` was consumed as a second reporter MODULE NAME, not a test
  target, so the run "passed" with zero real tests executed.
- **Root cause:** Jest's CLI keeps swallowing bare tokens after `--reporters` (a list flag) until
  the next `--`-prefixed option — a positional placed after it belongs to the flag, not the run.
- **Lesson:** **`--reporters=default` (or any multi-value Jest flag) must be the LAST token on
  the command line — every positional (spec path, pattern) goes BEFORE it.**
- **Guard:** none yet — propose an engine arg lint rejecting tokens after `--reporters=...`, plus
  a RESUME-card review line.

### L-103 · 2026-09-10 · tooling · chore/next-15

- **Symptom:** `npm run local:up` built fine, then `docker compose … up -d` failed on a
  container-name conflict — piped through `| tail`, it read exit 0.
- **Root cause:** `docker-compose.yml` hard-codes `container_name: routeflow_*` with no
  top-level `name:` and no `-p`; from a worktree the project name defaults to the worktree
  DIRECTORY, colliding on the SAME fixed names the main checkout's stack holds.
- **Lesson:** **A compose file with hard-coded `container_name` needs an explicit `-p <project>`
  (or top-level `name:`), never the cwd-derived default. Never pipe a compose/gate command
  through `| tail`; it discards the real exit code.**
- **Guard:** none yet — propose `-p routeflow` in `local:up`/`local:down`/`local:reset`, or a
  top-level `name: routeflow`.

### L-149 · 2026-09-15 · tooling · #743 fix-round T8 lesson-id staleness

- **Symptom:** an engine task's brief hardcoded specific lesson ids (L-140/L-141) and a `nextId`
  bump (143) to write at close-out. By the time the task ran, three intervening merges had moved
  the real registry floor to `nextId` 146 — the hardcoded ids were already claimed elsewhere.
- **Root cause:** the brief was authored against the registry's state at planning time. The task
  itself ran LAST, after seven others and however long wall-clock that took — in a shared,
  actively-written registry, "current state" at planning time and at execution time differ, and
  nothing in the brief distinguished the two.
- **Lesson:** **A task brief must never embed a point-in-time value from a shared, actively
  written resource (a registry id, a counter, a "latest" anything) as a literal constant when the
  task runs later than the brief was written — especially the LAST task in a run. Read the live
  value at write time instead, and verify (grep for existing use, re-run the validator) first.**
- **Guard:** none yet — a build-plan lint flagging a literal `L-\d+`/`nextId: \d+` inside any
  non-first-wave task's `brief` would catch this class before launch.

## testing

### L-165 · 2026-09-16 · testing · #779 (B225/B244/B411)

- **Symptom:** two unrelated integration tests intermittently failed under load —
  `bugs-self-test-script.spec.ts` and `ci-freshness-guard-script.spec.ts`.
- **Root cause:** both asserted a proxy for correctness instead of the run's own declared
  outcome — elapsed wall-clock time in one, an ambient tmpdir file count shared across parallel
  test workers in the other. Neither proxy is stable under load; the process's own exit
  signal/result was available and ignored.
- **Lesson:** **Assert a process's own reported result/exit signal, never wall-clock timing or a
  shared/global count, as a stand-in for it.** A shared ambient count in particular races every
  other parallel worker touching the same path.
- **Guard:** code review should flag any `Date.now()`-delta or directory-listing-count assertion
  in a spec touching a spawned process or shared tmp path — no automated lint yet.

### L-166 · 2026-09-16 · testing · #779 (B352)

- **Symptom:** `next-version.spec.ts` stopped enforcing a minimum patched Next.js version after
  an unrelated fix round touched the same file — a security-advisory floor silently dropped.
- **Root cause:** the fix round's own diff review didn't check which assertions the file already
  carried before editing it; a generically-named test ("pins the version") gave no signal that
  editing it deleted a security floor specifically.
- **Lesson:** **A spec file that pins a security floor (a CVE-patched minimum version, an
  advisory allowlist) needs its own named assertion — the next unrelated edit to that file can't
  silently delete it without a visible red diff.**
- **Guard:** name the assertion after the floor it enforces (e.g. `it("enforces the CVE-2026-xxxx
floor", ...)`), not after the generic thing being tested — restored in `next-version.spec.ts`.

### L-050 · 2026-09-02 · testing · #598

- **Symptom:** two new e2e specs went red post-deploy AND dragged an unrelated, previously-green
  test (`AP-06`, re-auth resumes the session) down with them.
- **Root cause:** neither new project declared `dependencies`, so the runner placed both in the
  first phase, while the victim ran in phase 2 on a stored session for the same shared operator;
  the mutating spec revoked the newest session row, which was that stored one. One spec revokes
  that user's sessions by design, so a sibling test's token refresh 401'd mid-flow. Scoping the
  spec's own CLEANUP was necessary and not sufficient: the body of the test revokes during the
  phase too.
- **Lesson:** **A spec that mutates shared auth state needs its own user, not a scheduling tweak.**
  Reordering only moves the collision — here phase 2 holds ~20 projects reusing the same stored
  session. Ask which fixtures a new suite MUTATES, and who else in its phase reads them.
- **Guard:** none yet — the two project entries are commented out (not deleted) with the diagnosis
  inline, so re-enabling is a seed change plus uncommenting. A skip is not a discharge ([[L-041]]).

### L-025 · 2026-09-01 · testing

- **Symptom:** native Google Sign-In had been dead the whole time — the callback destructured a
  `default` export `expo-secure-store` does not have, so token storage threw on every device.
- **Root cause:** the throw sits inside a `!isWeb` branch. Every automated surface runs the web
  build, which takes the `localStorage` branch, so nothing ever executed the failing line. This is
  narrower than L-019: no native _module_ misbehaved — ordinary JS was shielded by a platform
  conditional.
- **Lesson:** **A `Platform`/`isWeb` branch is untested code unless something runs that platform.
  When you touch one side of such a branch, either exercise the other side or state plainly that
  it is unverified.**
- **Guard:** none — judgment. Grep `isWeb`/`Platform.OS` in any file a fix touches.

## domain

### L-187 · 2026-09-17 · domain · demo-booking slot TOCTOU (check-then-insert race)

- **Symptom:** two concurrent bookings for the same slot could both pass an application-level
  "is this slot free" check before either had written its row, so both inserted — a genuine
  double-booking the app-level guard was supposed to prevent.
- **Root cause:** the availability check and the insert were two separate statements with no
  atomicity between them — a classic check-then-act race. An application-level check can only
  ever narrow the window, never close it; the two statements can always interleave under load.
- **Lesson:** **A slot/resource booking that must never double-allocate needs the DB to enforce
  it, not application code — a partial unique index (`WHERE status != 'CANCELLED'`, so a
  cancelled booking never blocks a fresh one for the same slot) makes the second concurrent
  insert fail atomically at the constraint, instead of racing an app-level read.**
- **Guard:** the `demo_booking_race_guard` migration's partial unique index; a concurrent-insert
  regression test proves the second request gets a real constraint violation, not a silent
  double-book.

### L-189 · 2026-09-17 · domain · B466 (substitute path bypassed the tier-aware pricer)

- **Symptom:** substituting a product on an order item priced the new line at LIST regardless of
  the customer's SPECIAL-tier contract price — a correctly-typed override at the real contract
  price was silently stored as DISCOUNTED with no reason, on a code path nobody had ever pointed
  a tier-3 customer at before.
- **Root cause:** the substitution branch was its own independent price path — it reused neither
  `resolveBuyerLinePrice`'s tier resolution nor the batched `CustomerPrice` lookup the ADD/UPDATE
  branches share (the substitute's NEW product id was never even added to that lookup's id set)
  — so it defaulted to the simplest case, list price, and had no way to learn a per-product tier
  existed for the new product at all.
- **Lesson:** **A new mutation path onto an already-priced entity (substitute, replace, clone,
  ...) must resolve price through the SAME tier-aware pricer AND read from the SAME batched
  price-lookup key set every sibling path uses — a fresh, path-specific reimplementation silently
  regresses to the simplest case, and the gap is invisible until someone diffs it against a
  sibling branch by hand.**
- **Guard:** `orders.service.spec.ts`'s B466 suite (a SPECIAL-tier substitute prices at tier, not
  list; the reason-required guard fires on a bare override; the batched lookup includes
  `substituteProductId`). Sibling [[L-072]] (reuse vs. reimplement, applied here to a pricer
  instead of an enum).

### L-185 · 2026-09-17 · domain · B440 (report `total` repurposed, footer stopped matching its own column)

- **Symptom:** a report's `total` field was repurposed from "sum of the displayed column" to a
  pre-tax, windowed expense figure — the footer stopped equalling the sum of its own column.
- **Root cause:** one field was serving two consumers at once: a UI sum-of-column invariant and a
  cross-report reconciliation value. Changing the value for one consumer silently broke the other,
  because nothing named which contract the field actually promised.
- **Lesson:** **When a report field feeds both a displayed column's own sum AND a value another
  report must reconcile against, give the two consumers separate named fields (e.g. `total` for
  the column sum, `expense` for the reconciliation value) — never let one field serve both.**
- **Guard:** none yet — propose a regression test with a fixture where the two diverge (nonzero
  tax), asserting both formulas independently.

### L-181 · 2026-09-16 · domain · B451 (dto `any` vs real callers)

- **Symptom:** replacing `estimates.controller.ts`'s `@Body() dto: any` with a real
  `CreateEstimateDto` made a line-item's `description` required — but `scripts/feature-smoke.mjs`
  S6 (a shipped `local:validate:features` gate) and several `qa-run.js` tests send a bare
  `{productId, qty}`, relying on the service's own `?? product?.name` fallback. Caught only by an
  independent review, not the author.
- **Root cause:** the DTO's field set was derived from the primary web UI form alone; scripted/
  feature-smoke callers were never grepped.
- **Lesson:** **Before typing a `dto: any` endpoint (or tightening any field's optionality), grep
  every caller — web form, mobile, `scripts/feature-smoke.mjs`, `qa-run.js`, e2e — not just the
  UI form that motivated the change.**
- **Guard:** `apps/api/src/estimates/dto/create-estimate.dto.spec.ts` pins the bare
  `{productId, qty}` shape passing the real `ValidationPipe` unchanged.

### L-167 · 2026-09-16 · domain · #781 (B156/B158/B170)

- **Symptom:** three separately-reported bugs (B156/B158/B170) all traced to the same root cause
  — a customer-list filter predicate living in more than one place.
- **Root cause:** `findAll`'s `where` clause and `exportCustomers`'s hand-rolled one had drifted
  apart, and neither was consulted by `update`/`changeStatus`'s removed-customer guard.
- **Lesson:** **When an entity has more than one read/export/guard path (list, CSV export,
  edit-guard), its filter predicate belongs in exactly ONE shared builder consumed by all of
  them — three call-site-specific copies will silently drift, and each drift surfaces as its own
  "unrelated" bug report.**
- **Guard:** shared `buildListWhere()` backs `findAll`, `exportCustomers`, and the
  `update`/`changeStatus` guards; a test should assert every consumer calls the _same_ function
  reference, not just that each produces a matching result today (not yet added — flag for the
  #781 landing coordinator).

### L-173 · 2026-09-16 · domain · B449 (Lite lane, plan-gate boundary)

- **Symptom:** a plan-gated page kept firing its own effects/queries while a locked/blurred
  overlay showed over it — its 403 toasts and query errors leaked to a user who should never
  have triggered that page's behavior at all.
- **Root cause:** the gate ghosted the real page behind blur/opacity by rendering it as
  `children` inside the locked view's own slot — that hides the DOM, it doesn't unmount it, so
  "ghosted" was mistaken for "never mounts."
- **Lesson:** **A route guard choosing between locked and unlocked must render exactly ONE of
  two subtrees, never wrap the real page inside the locked view's ghost slot — a component
  hidden behind blur/opacity is still mounted, and its effects/queries still fire.**
- **Guard:** a route boundary needs a real third "still resolving" state (a spinner) distinct
  from both outcomes; `layout.plan-gate-boundary.test.tsx` pins children absent from the tree
  while resolving/locked, not just visually hidden.

### L-169 · 2026-09-16 · domain · B421 / PR-1a shared-helper precondition no-op (two call sites)

- **Symptom:** two surfaces hit the same shape. `statement.service.ts` moved a payment sum into
  the shared `splitConfirmed` helper, which re-checks `.status` generically — its `select` never
  needed `status` before, so every row read `undefined`, risking a silent zero.
  `returns.service.ts`'s CANCELLED-line exclusion referenced `li.status`, but none of its four
  real `lineItems` selects fetched it — dead code from the moment it was written. Both tests
  passed anyway because their mocks supplied the field directly, never proving the real `select`
  produced it.
- **Root cause:** a shared helper that re-derives a precondition has no knowledge of a caller's
  query shape — it assumes the field is present. A caller whose `select` never needed that field
  before silently hands the helper `undefined`, which the check absorbs as a real value.
- **Lesson:** **Before wiring a caller into a shared helper that re-derives a precondition
  generically, check the caller's `select` actually fetches the field — a mock supplying it
  directly proves nothing. A type-check alone won't catch a field silently resolving to
  `undefined`.**
- **Guard:** both selects now fetch `status`; `returns-lineitems-select.spec.ts` pins the real
  shape at every call site.

### L-170 · 2026-09-16 · domain · #743 fix round F3 (roundMoney before comparison)

- **Symptom:** a fully-settled invoice rendered a red "Balance Due $0.00" badge instead of the
  green paid state — the displayed number was right but its color-coding read non-zero.
- **Root cause:** the balance summed three independently-derived floats (cash + credit +
  advance) before subtracting from total; `Math.max(0, ...)`/color-coding ran on that raw sum,
  where a sub-cent remnant (e.g. `-2.8e-14`) survives `Math.max` and still reads non-zero.
  `roundMoney` was applied only at display-formatting time, never before the comparison.
- **Lesson:** **`roundMoney` must wrap a sum of independently-derived floats BEFORE the value
  drives any comparison or branch — color-coding, `>0` checks, conditional rendering — never only
  where it's formatted for display. A value that looks like zero once rounded but drives a
  boolean check unrounded will diverge from what the user sees.**
- **Guard:** `invoices.service.ts`'s two `balanceDue` sites and `invoice-pdf-template.tsx`'s
  balance now wrap in `roundMoney()` before `Math.max`/the comparison; existing invoice-balance
  suites cover it. Also: `customers.service.ts`'s `applyAdvancePaymentToInvoiceLocked` (#814,
  same class — `newPaid` compared unrounded).

### L-171 · 2026-09-16 · domain · PR-1a F1 (pooled cap vs single-line price basis mismatch)

- **Symptom:** `returns.service.ts`'s over-return cap was widened from "sold qty on one matched
  line" to "sold qty summed across every live line for that product" — correct on its own — but
  the sibling never-invoiced pricing branch, reading the SAME (order, product) key, still priced
  off one matched line's rate against the newly-pooled quantity. A product split across two
  differently-priced lines got over-credited.
- **Root cause:** the cap and the price are two different readers of one key. Widening one
  reader's basis fixed that reader alone — nothing re-examined the sibling reading the same key,
  so the two computations silently disagreed on how many rows back the number.
- **Lesson:** **When a guard/cap computation for a key is widened to pool across rows, grep every
  OTHER reader of that key before calling the fix done — a cap and a price computed from
  different bases silently mismatch, and the mismatch is a MONEY bug, not a correctness one.**
- **Guard:** the pricing branch now pools qty/subtotal per product the same way the cap does,
  with a `min(returned, sold)` backstop; `returns-refund.spec.ts`'s new F1 cases prove the pooled
  pricing for a two-line split.

### L-072 · 2026-09-03 · domain · wave E `imp-10b`

- **Symptom:** 4 hand-typed client mirrors of Prisma enums drifted from the schema (invented,
  renamed, or omitted values); one hid a real action and broke a list filter.
- **Root cause:** each mirror was an independently hand-typed string union — TS never compares two
  such unions to each other, so the drift compiled clean and stayed invisible.
- **Lesson:** **Never hand-declare a client mirror of a server (Prisma) enum — derive one
  const-array union per enum from a shared package and pin it set-equal to `Object.values()` of
  the real enum in a spec, never against a second hand-typed "expected" list.**
- **Guard:** `apps/api/src/common/enum-parity.spec.ts` — a generic table (40 enums) against
  `packages/types/api/enums.ts`, plus a regression layer pinning the drifted files and the mobile
  jest stub that can't `require` the shared package directly.

### L-081 · 2026-09-06 · domain · F09

- **Symptom:** wallet credit kept being consumed by WRITTEN_OFF (forgiven) invoices after the settle
  query had excluded VOID, and a fix at that query would still have missed the second door — the
  auto-apply path `send()`/`sendEmail()` reach — while a test whose mock injects the query result
  could not even see a `where`-only fix.
- **Root cause:** the guard lived at one call site's query instead of at the money write; four
  hand-rolled status lists (manual apply, settle, delivery payments, the advance wallet) had drifted
  apart, and PAID had to stay in the settle set because the same loop shrinks excess credit.
- **Lesson:** **gate a money write inside the primitive that performs it, on the row it just read
  (an exclude-list, so a fixture without the field still writes) — sibling primitives and
  result-injecting mocks bypass a where-only fix; and keep every status set in one named module with
  the reason each differs written beside it.**
- **Guard:** REG-B67 T1/T2/T5 (apply-side, incl. the auto-apply door) and REG-B66 T6/T7/T9–T11 in
  `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts`; the pins file (T3/T3b) proves
  PAID/WRITTEN_OFF still shrink; `apps/api/src/invoices/invoice-status-sets.ts` is the one home.

### L-116 · 2026-09-12 · tooling · plane self-test machine-root invariants

- **Symptom:** a lead's pre-push verify failed at plane-learning.self-test's "real
  machine-shared runs.jsonl byte-unchanged" check — ANOTHER session's hooks (Stop -> plane-sync,
  SessionStart -> plane-triage) had legitimately appended to it mid-run.
- **Root cause:** every "real file byte-identical before/after" invariant in the plane self-tests
  binds on `machineRoot()`'s shared dir — the SAME dir every worktree resolves to (see [[L-114]])
  — so it races any other session, not just a concurrent run of the same suite.
- **Lesson:** **A self-test invariant must never bind to a shared machine-local file — assert
  only on fixtures the run owns. A file another session can write at any moment needs a throwaway
  stand-in the test controls end to end, never the real shared path.**
- **Guard:** `PLANE_MACHINE_ROOT` (`plane-client.mjs`, gated behind `PLANE_SYNC_SELF_TEST=1`)
  lets every plane self-test point `machineRoot()` at its own temp root; the five real-runs.jsonl
  invariants became a temp-root-only check, and plane-learning's `T-concurrent-writer` proves
  isolation under a genuine concurrent writer. Related [[L-114]].

### L-119 · 2026-09-13 · process · F38 round 4

- **Symptom:** an independent pre-merge review found the door quote collecting excise on
  cancelled and already-delivered lines — after three in-lane rounds passed that code.
- **Root cause:** the two halves of one money figure came from differently filtered line sets;
  each file read correctly alone, so the defect lived only in the seam.
- **Lesson:** **Both halves of one money figure must derive from ONE collection — pass the
  filtered array, never re-derive the filter at the second call site. A reviewer inside the lane
  is the wrong instrument for a seam; it takes an independent pre-merge pass to see across two
  files that are each individually right.**
- **Guard:** REG-B305 round 4 + the source pin `short-pick-category-tax.pins.test.ts` (the
  composition lives in a screen unit tests cannot import).

### L-124 · 2026-09-13 · domain · cron sweep silently dropped null-tenant orders

- **Symptom:** `sweepAllPendingOrders()` grouped pending orders by `(customerId, tenantId)` and
  filtered with `having customerId._count > 1`; a customer with one order under a real tenant and
  one legacy order with `tenantId: null` produced two SEPARATE one-row groups, both filtered out
  by `having` before the null-tenant branch ever ran — nothing merged, and NOTHING logged (PR
  #722 independent review, B323).
- **Root cause:** the null-tenant warn lived only inside the per-group loop, downstream of the
  `having` filter, so a null-tenant row was only ever visible when it happened to share its
  `(customerId, tenantId)` group with more than one other row. A lone null-tenant row sitting
  beside a lone real-tenant row for the same customer was invisible to both the merge and the log.
- **Lesson:** **A cron or bootstrap entry point has NO ambient tenant: group the work by tenantId
  first and run each group inside `tenantCtx.run(tenantId)`; `forTenant()` silently returns the
  unscoped client otherwise. Rows without a tenant are skipped AND counted, never merged unscoped
  and never dropped silently.**
- **Guard:** `REG-B323` — a dedicated unscoped `groupBy({ by: ["customerId"], where: { ...,
tenantId: null } })` run alongside the main query counts and warns every null-tenant customer
  regardless of whether their real-tenant group individually cleared the `>1` threshold; the
  sweep's return shape carries the count as `skipped`.

### L-125 · 2026-09-14 · domain · W1 billing anchor

- **Symptom:** a fix for billing-period drift was about to derive each tenant's cycle anchor from
  `TenantSubscription.createdAt`, the only date on the row — moving real charge dates for anyone
  whose row predates their subscription.
- **Root cause:** several paths create that row without subscribing (a customer-cap grace window,
  a Stripe customer being minted), so its creation date is not the anchor; no column stores one.
- **Lesson:** **Never infer a money-bearing date from a column that merely happens to hold a date.
  Check every writer of the row before treating a field as the thing you need — if none of them
  means it, the honest fix is a column and a migration, not the nearest plausible field. Shipping
  half a fix beats shipping a wrong charge date.**
- **Guard:** the time-of-day half shipped alone; the drift half is filed, blocked on an
  `anchorDay` column. Sibling [[L-118]].

### L-145 · 2026-09-14 · domain · mobile scan-to-order, staged-edit persistence

- **Symptom:** a reviewer flagged a new "don't lose the operator's staged edits" snapshot
  (`edit-items-draft.ts`) as a likely R1 violation — R1 requires local persistence to go through
  the user-scoped zustand `persist` store pattern (`podStore.ts`), never a raw AsyncStorage key,
  specifically to prevent one user's work surfacing under the next login (B136/B137/B140).
- **Root cause:** R1 was written against a single-blob-per-user shape (one cart, one draft). This
  snapshot is one-per-ORDER, and an operator edits several orders per session — a single zustand
  store holds one state object, not a dynamic per-order keyspace, so the literal store pattern
  doesn't fit the shape. The code used a `rf.edit-items.v1:<userId>:<orderId>` AsyncStorage
  keyspace instead, with `lib/session-teardown.ts` enumerating and wiping every key under a
  user's prefix on logout.
- **Lesson:** **A binding rule written for one shape (single blob) does not automatically bind a
  different shape (a per-entity keyspace) the same way. Before flagging a deviation from a
  pattern-shaped rule as a violation, check what invariant the rule actually protects — here, no
  cross-user data leak — and whether the deviation still satisfies THAT, not just whether it uses
  the literal mechanism. Verify the substitute mechanism is real (grep the teardown/hydrate wiring
  itself), don't take a code comment's claim on faith.**
- **Guard:** `session-teardown.ts` imports and calls `editItemsSnapshotUserPrefix` +
  `clearStorageByPrefix` — grep for it before trusting this reasoning again on the same file.
  `apps/mobile/lib/edit-items-draft.ts` carries the design-rationale comment inline.

### L-156 · 2026-09-15 · tooling · B420 mistiered proof, no lawful reclassify path

- **Symptom:** B420 was correctly fixed and proven (T1), but its proof cited a standalone node
  self-test (`validate-code-map.stamp.self-test.mjs`, run directly by `npm run verify`) as if it
  were a jest suite. `campaign-check.mjs`'s T1 path scans jest report titles only, so the row could
  never discharge — a fleet-wide push blocker, not a B420-specific defect.
- **Root cause:** the correct target state, `already-fixed`, checks only that `evidence` is
  non-empty (its `EVIDENCE_ONLY_STATES` path bypasses the jest lookup entirely) — but no command
  transitions a `proven` row there. `already-fixed` refuses anything but `queued`/`in-flight`; the
  only exit from `proven` (`reopen`) forces state to `regressed` and requires citing an actual
  failing token or regression run — a false claim for a row that never regressed, just mistiered.
- **Lesson:** **A state machine's error-recovery path must not force a claim that isn't true. When
  the only documented exit from a wrong state requires asserting something false to use it, that is
  a missing transition, not a workaround to take.** Fixed here via a direct, lock-checked,
  single-field ledger edit (owner-approved, out of band) rather than fabricate a regression.
- **Guard:** filed B426 (bugs.mjs needs a lawful `proven`→`already-fixed` reclassify path,
  distinct from `reopen`'s regression semantics) so this doesn't recur as a manual escape hatch.

### L-143 · 2026-09-15 · domain · B421 (credit-applied vs paid, full fix)

- **Symptom:** a CREDIT_NOTE-method `InvoicePayment` row (`status: PAID`) rendered/counted as
  cash everywhere a "Paid"/"received" figure was shown — invoice totals, the PDF, buyer portal,
  mobile, and every bookkeeping cash-flow/dashboard figure.
- **Root cause:** the one shared confirmed-payment predicate answered "is this confirmed"
  (status), necessary but not sufficient for "is this cash" — nothing distinguished the two
  questions, so every consumer answered both with the same number.
- **Lesson:** **A "paid"/"received" DISPLAY figure is cash-only (excludes CREDIT_NOTE; ADVANCE
  stays in a tenant-wide received figure, since its application is the only place that cash is
  ever recorded) — but balance/status/outstanding figures keep the FULL confirmed total, since a
  credit note or advance genuinely settles what's owed. Two questions, two filters, ONE shared
  predicate.**
- **Guard:** `@routeflow/pricing`'s `splitConfirmed`/`resolveConfirmedAmounts`/
  `RECEIVED_METHOD_FILTER`/`CASH_METHOD_FILTER` are the one implementation api/web/mobile
  import — never re-derive either filter at a second site. A shared helper that re-derives a
  precondition generically (e.g. re-checking `.status`) will silently no-op for a caller whose
  `select`/fixture never populated that field for its own prior reasons (a `where` already
  enforcing it) — run that caller's existing tests before trusting a swap, never a type-check alone.

### L-159 · 2026-09-15 · domain · B421 (PDF + web-detail rounds, independent review)

- **Symptom:** a PDF template's fallback (for a caller not yet passing B421's new split fields)
  re-derived `totalPaid`/`creditApplied`/`advanceApplied` independently, each gated on its OWN
  `!= null` check — a caller passing an old, credit-inclusive `totalPaid` alone would get
  `creditApplied`/`advanceApplied` re-split from raw payments too, subtracting the same
  credit/advance a second time and understating the balance. The very next surface (a web page)
  reinvented the identical bug before it even landed, independently of the first.
- **Root cause:** three related figures each checked their own presence instead of sharing ONE
  gate, so a partially-precomputed payload silently mixed two inconsistent bases.
- **Lesson:** **When a fallback re-derives several related figures from raw data, gate ALL of
  them on ONE presence check, never per-field — a caller supplying some but not all of a
  precomputed set must get either the full precomputed set (missing members default to zero) or
  the full re-derived set, never a mix.**
- **Guard:** `payment-predicates.ts`'s `resolveConfirmedAmounts(precomputed, payments)` (API) and
  the hand-rolled web mirror in `invoices/[id]/page.tsx` both gate on one field's presence; each
  has a red-first regression test pinning the double-subtraction case.

### L-162 · 2026-09-15 · tooling · post-dated check payments PR-1 (schema-only, additive)

- **Symptom:** adding `CHECK_RETURNED` to the Prisma `NotificationEvent` enum — a schema-only,
  "no behavior change" migration with no new call site — broke `apps/api` `check-types`: two
  pre-existing `Record<NotificationEvent, ...>` maps in `messaging-config.service.ts`
  (`EVENT_CHANNELS`, `DEFAULT_TEMPLATES`) stopped compiling because they no longer covered every
  member of the enum.
- **Root cause:** an "additive-only" schema PR was scoped by grepping the Prisma schema and the
  shared-type mirrors (`@routeflow/types`), never by grepping for `Record<TheEnum,` across the
  consumers of that enum — an exhaustive map is a compile-time contract on the enum's FULL
  member set, so a new value is a breaking change to every such map even though nothing in the
  new PR reads or writes the new value.
- **Lesson:** **Before adding a value to an existing Prisma enum, grep the whole tree for
  `Record<TheEnumName,` (and any hand-written `switch`/object-literal that enumerates every
  member) — an "additive, no behavior change" schema PR still breaks compilation wherever an
  exhaustive map exists, and needs a minimal exhaustiveness-only entry there (never a real
  trigger/behavior change) to stay green.**
- **Guard:** `messaging-config.service.ts`'s `EVENT_CHANNELS`/`DEFAULT_TEMPLATES` gained a
  `CHECK_RETURNED` entry (`[INTERNAL]` / a template string) and `NO_TRIGGER_EVENTS` gained the
  key too, in the SAME commit as the schema change; `apps/api/src/common/enum-parity.spec.ts`'s
  `PINNED_PRISMA_ENUM_COUNT` tripwire (L-072) catches a genuinely new enum, but not a new VALUE
  on an existing one — only `tsc --noEmit` catches that, which is why this must be run, not
  assumed, on any enum-value addition.

## security

### L-188 · 2026-09-17 · security · demo-booking OAuth/booking tokens in URL query strings

- **Symptom:** an OAuth/booking token traveled as a URL query parameter — the exact shape that
  ends up in server access logs, browser history, the `Referer` header of any outbound link on
  the same page, and third-party analytics scripts that record the full URL.
- **Root cause:** a query string is the easiest place to carry a value across a redirect, but
  it is also the least private transport HTTP offers — nothing about the URL is treated as
  secret by any layer between the browser and the server.
- **Lesson:** **Never carry an OAuth token, booking token, or any other bearer-shaped secret in
  a URL query string — use a fragment (`#`, never sent to the server or logged server-side) for
  a client-side handoff, or a POST body for a server-side one.**
- **Guard:** none yet — propose a lint/review checklist item flagging `token`/`code`/`secret`-
  named query params on any new route.

### L-178 · 2026-09-16 · security · demo-booking PR-2 (raw error message leak)

- **Symptom:** a public-facing catch handler rendered a caught error's `.message` verbatim, so an
  unauthenticated route (booking availability) could show NestJS's own raw
  `Cannot GET /api/v1/public/...` 404 body instead of a curated message.
- **Root cause:** the load path assumed every reachable error was one of its own curated
  exceptions; it never accounted for a transport-level failure (a routing mismatch, a raw 500)
  with no safe message behind it.
- **Lesson:** **A public unauthenticated page's catch handler must show a FIXED, generic message
  for any path that can receive a transport-level failure, never `error.message` — a curated
  message is safe to show only when every source feeding that catch is known and typed.**
- **Guard:** `demo-scheduler.test.tsx` pins a raw framework 404 body, a bare network failure, and
  a raw 500 all rendering the SAME fixed message, never the response body.

## deploy

### L-184 · 2026-09-17 · deploy · #777 merged/deployed without its migration or a drift check

- **Symptom:** #777 merged and deployed with a new `migrations/` folder, but the migration was
  never applied to prod and the post-deploy schema-drift run never happened. Undetected for
  ~26 hours — `post-deploy-check` doesn't check drift at all.
- **Root cause:** the standing deploy flow assumes a migration ships and gets applied together,
  but nothing actually gates the LANDING of a migration-carrying PR on the owner having applied
  it, and `post-deploy-check` (the thing that DOES run automatically) has no drift check in it —
  drift only surfaces if someone remembers to run `npm run local:drift` / the prod drift script
  by hand.
- **Lesson:** **A PR that adds a `migrations/` folder is not LANDED (merged to master) until the
  owner has applied it to prod AND the drift run shows exit 0 — a migration is authorized before
  merge, never assumed to happen after. The merge coordinator checks
  `git diff --name-only <base>..<merge> -- apps/api/prisma/migrations` on every landing to catch
  this before it merges, not 26 hours after.**
- **Guard:** none yet — propose the merge coordinator's landing checklist running that diff
  command as a hard gate, and/or folding a drift check into `post-deploy-check` itself.

### L-195 · 2026-09-17 · deploy · landing a stale branch reverted #861's live fix (#862)

- **Symptom:** landing PR #862 silently reverted the P1 opacity fix from #861 — nine capability
  cards went back to invisible on the live marketing site.
- **Root cause:** #862's branch was cut BEFORE #861 merged and never rebased; both PRs touched
  `marketing.css` in different, non-overlapping regions. The landing computed a raw diff between
  #862's stale branch and current master to isolate "#862's own changes" — but since #861's hunk
  exists on master and NOT on #862's stale branch, that raw diff showed #861's own fix as a
  REMOVAL belonging to #862, and applied it as one. A byte-identity check against the stale
  branch's own content cannot catch this either, since the stale content IS what's wrong — it
  matches the branch perfectly, just not reality.
- **Lesson:** **A landing diff meant to isolate "this PR's own changes" must be taken against the
  branch's OWN MERGE-BASE, never against current master directly — diffing a stale branch against
  a master that has moved on makes every OTHER PR's intervening change look like part of the
  branch being landed. Separately: whenever two in-flight PRs touch the same file, diff them
  against EACH OTHER for overlapping regions before assuming either one's raw diff is clean in
  isolation. And a post-deploy visual check is not a correctness check — verify the actual
  computed state (`getComputedStyle`, an API response, a DB row), not a screenshot that can look
  right for the wrong reason.**
- **Guard:** the merge session's live post-deploy verification caught this one in practice — note
  that as the standing guard until a mechanical one exists — plus the pre-existing e2e T13
  opacity assertion. Propose: the landing tool computes each PR's diff against
  `git merge-base <branch> master`, never against `master` directly, and warns when two open PRs'
  diffs touch the same file.

### L-183 · 2026-09-16 · deploy · Railway dual-service deploy status race

- **Symptom:** a merge that changed only ONE of the two Railway services (api/web) showed its
  fresh deploy flip from `success` to `inactive` seconds later, reading as a failed/superseded
  deploy when the code had actually shipped fine.
- **Root cause:** Railway's two services share ONE GitHub deployment environment. The UNTOUCHED
  service re-posts its own `success` status on its OLD sha shortly after the push (a routine
  re-affirm, not a new deploy), and GitHub's deployment-status API treats the two services'
  postings as one shared history — the untouched service's later post reads as superseding the
  just-shipped one's `.statuses[0]`.
- **Lesson:** **Never judge a Railway deploy by `.statuses[0].state` alone — that slot can be
  overwritten by the OTHER service's unrelated re-affirm within seconds. Read the full status
  history, or confirm the actually-served commit directly (API: `GET /api/v1/health`; web: the
  E2E readiness gate) before declaring a deploy failed or successful.**
- **Guard:** none yet — propose `post-deploy-check` reading the full status array (not just index 0) or verifying the served commit sha directly, whichever ships first.

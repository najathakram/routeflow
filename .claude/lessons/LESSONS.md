# Lessons Learned — RouteFlow

> Generalizable rules this project has paid for. **Read this at the start of every major task,
> implementation, or bug fix** (alongside the code map) and cite entry ids when one changes your
> approach. **After every bug fix, append an entry** — Symptom / Root cause / **Lesson** / Guard —
> and bump [`_meta.json`](_meta.json); Gate 3 of [`../hooks/stop.mjs`](../hooks/stop.mjs) blocks
> fix-shaped turns that don't (a lesson-free fix bumps `_meta.json.updatedAt` to acknowledge).
> Caps: ≤ 40 active entries / ~25 KB — compact to [`ARCHIVE.md`](ARCHIVE.md). Maintained by the
> `lessons-learned` skill. Blameless; **never client names/slugs/document numbers** — the repo
> goes public briefly for CI.

## process

## tooling

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

### L-180 · 2026-09-16 · tooling · git worktree move leaves stale npm junctions

- **Symptom:** after `git worktree move`, invalid-hook-call errors and mangled Jest file paths —
  initially looked like [[L-055]]'s dot-directory glob bug, but a different mechanism.
- **Root cause:** `git worktree move` relocates git metadata and working files but never rewrites
  npm's workspace junctions (Windows) inside `node_modules` — those are absolute-path-based and
  keep resolving to wherever `npm install` last ran, i.e. the OLD path.
- **Lesson:** **After `git worktree move`, treat `node_modules` as stale — run `npm ci` (+
  `npx prisma generate` for apps/api) at the FINAL path. Never move a worktree after installing
  if you can install at the final path from the start.**
- **Guard:** none yet — propose a post-move check comparing a junction's resolved target to cwd.

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
  `spawnSync` call running *inside* it, so the inner call now times out and throws before Jest's
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

### L-106 · 2026-09-11 · tooling · train-4 close-out

- **Symptom:** a final Jest command whose only targets were brand-new spec files exited 1 at
  Baseline and was silently EXCLUDED from the verdict — close-out read "no regression" from a
  command that produced no real pass/fail signal.
- **Root cause:** Jest exits non-zero when a pattern matches zero existing tests (true at
  Baseline, before the new spec exists); nothing distinguished that from "ran and failed."
- **Lesson:** **A Jest invocation whose targets can legitimately not exist yet needs
  `--passWithNoTests`; close-out must confirm the T#/REG tests actually EXECUTED (a per-test
  result line), never infer it from exit code alone.**
- **Guard:** none yet — propose `--passWithNoTests` on the Baseline invocation and a close-out
  check that greps the run's JSON for the expected test titles.

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

### L-138 · 2026-09-15 · testing · #711 review round (F1 issue-date default)

- **Symptom:** a review fix at the cited line (the create-modal's `issueDate` `useState`
  initializer) looked complete and type-checked clean, but a "reset on open" `useEffect` a few
  lines down independently recomputed the SAME default with the SAME buggy expression
  (`new Date().toISOString().slice(0, 10)`, the UTC calendar date, not the operator's local one)
  — every time the modal opened, that effect overwrote the fixed initial value with the still-wrong
  one. Caught only because the new regression test opened the modal and read the rendered input's
  actual value, rather than asserting on the initializer expression in isolation.
- **Root cause:** the same wrong default had been copy-pasted (or independently re-derived) at a
  second call site the review didn't name; fixing the cited line alone left the component's
  observable behavior unchanged, since the effect runs after mount and wins.
- **Lesson:** **A review finding that names one line of a bug is a starting point, not the full
  blast radius — grep the component/file for other call sites computing the same value the same
  way before declaring the fix done, and prove it with a test that exercises the real interaction
  (open the modal, click the button) and reads the rendered/observable state, never one that only
  asserts on the helper function in isolation.**
- **Guard:** `apps/web/app/(dashboard)/estimates/page.f1-issue-date-default.test.tsx` opens the
  create-modal and reads the actual `<input type="date">` value under a mocked local-vs-UTC date
  split (`Date.prototype` getter spies, not `process.env.TZ` reassignment — a Jest worker can cache
  its process-level timezone before a test file's own `TZ` write takes effect, so that approach
  silently no-ops; confirmed by reproducing the false-pass first). Both call sites in
  `estimates/page.tsx` now share one `defaultIssueDate()` helper.

### L-139 · 2026-09-14 · tooling · B420 GIT_* env leak into self-test throwaway repos

- **Symptom:** a pre-push hook's `validate-code-map.stamp.self-test.mjs` renamed a live worktree's
  branch twice and stacked fixture commits on real work, mid-session (rf-mobile-lanes incident).
- **Root cause:** git sets `GIT_DIR`/`GIT_WORK_TREE` (+8 siblings) in a hook's environment; this
  self-test's `spawnSync("git", …)` calls inherited them unscrubbed, so its "isolated" scratch
  repo's `init`/`add`/`commit`/`branch -M` silently resolved against the REAL repo instead of
  `cwd`. Identical root cause to L-082's sibling incident (`bugs.mjs self-test`, 2026-09-04, fixed
  in that one file) — that lesson was never written down ("no headroom"), so a second, newer
  self-test script repeated the exact anti-pattern ten days later.
- **Lesson:** **Any script driving a THROWAWAY git repo as a fixture must scrub all ten `GIT_*`
  vars (`GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR`/`GIT_OBJECT_DIRECTORY`/
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`/`GIT_QUARANTINE_PATH`/`GIT_PREFIX`/`GIT_NAMESPACE`/
  `GIT_CEILING_DIRECTORIES`) from every child process — it WILL run inside a hook eventually, and
  git always exports them there. Scrubbing alone is not proof: assert the result too — after
  `git init`, resolve `--show-toplevel` and confirm it lands inside the scratch dir before doing
  anything that could mutate a real repo.**
- **Guard:** the post-init toplevel check (throws on mismatch) + `REG-B420` (a second "victim"
  repo's branches/HEAD/config asserted byte-unchanged after a polluted-env fixture op) in
  `scripts/validate-code-map.stamp.self-test.mjs`. Sibling [[L-082]] — no shared guard between the
  two files, so a third such script would still need its own.

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

### L-151 · 2026-09-15 · tooling · #743 fix-round value-importing @routeflow/types crashed api boot

- **Symptom:** two commits value-imported (not `import type`) a constant from `@routeflow/types`.
  `tsc --noEmit`/`ts-jest` passed clean. `node dist/main.js` (real prod boot) would have crashed:
  `nest build` doesn't bundle workspace deps, and that package ships raw TS with no build step, so
  the import emits a `require("@routeflow/types")` into `dist/` that fails to parse.
- **Root cause:** a guard test for this exact mistake already existed
  (`no-runtime-workspace-imports.spec.ts`) but never ran against these commits — only the task's own
  spec files ran, not the full suite, until this session ran it in full for the first time.
- **Lesson:** **`tsc`/`ts-jest` passing is not proof a workspace-package import is safe at actual
  runtime boot — only a guard test on the real imports (or an actual boot) proves it.** Run the FULL
  suite at least once per fix round; a boot-crash guard does nothing if it never runs.
- **Guard:** `no-runtime-workspace-imports.spec.ts` (pre-existing). Fix: derive the value from
  `@prisma/client`'s real enum instead, or mirror it locally like the file's own `METER_KEYS`.

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
  `update`/`changeStatus` guards; a test should assert every consumer calls the *same* function
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
  suites cover it.

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

### L-123 · 2026-09-14 · process · W1 seam rows

- **Symptom:** an independent pre-merge review found two live defects in code three in-lane
  rounds had passed — a cancel that never reached the payment provider, and a resume that
  cleared the one flag a new guard reads.
- **Root cause:** each round fixed what it was handed. Round 1 added an idempotence
  short-circuit; a later round added a provider call BELOW it; a third gave that call a
  three-condition gate and left the local write on one. Every diff was correct read alone.
- **Lesson:** **When a function is edited by more than one review round, the seam between the
  rounds is where the defect lives: a guard added early can end up ahead of a call added late,
  and a gate tightened on one branch can leave its sibling ungated. Touching a function an
  earlier round changed means re-reading it whole — an in-lane reviewer holding one diff cannot
  see this, which is what the independent pre-merge pass is for.**
- **Guard:** the W1 rows (`STRIPE-CANCEL-2`, `STRIPE-RESUME-1`) plus the rewritten spec that
  asserted the defect. Sibling [[L-119]].

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

### L-144 · 2026-09-14 · domain · PR #748 review — a fallback key for an unresolved identity is a cross-user leak

- **Symptom:** the same staged-edit keyspace [[L-145]] fixed can still deliver operator A's edit
  to operator B on a shared tablet: `editItemsSnapshotKey` falls back to an `anon` bucket when
  `useAuthStore`'s `user?.id` reads undefined — reachable on a cold open or deep link, before
  `initialize()` resolves the stored user — and teardown swept only the resolved user's own
  prefix, never `anon`.
  - **Root cause:** "no user id yet" was treated as one more value to derive a key from (a
    `?? "anon"` fallback), not as a distinct state that must refuse the write entirely. A fallback
    bucket is by construction shared by every caller who ever hits the same unresolved state — the
    cross-user leak is what a shared default key always is, discovered late because sign-in
    normally resolves fast enough that the window is rarely hit.
- **Lesson:** **An unresolved identity is not "no identity" — it is "don't know yet," and a
  fallback default for it silently becomes a SHARED bucket every not-yet-authenticated caller
  writes into. Never derive a user-scoped storage key with a `?? someDefault`; gate the write
  itself on the id being resolved, and skip it (not write-then-hope-to-sweep-later) when it
  isn't. A teardown sweep of the fallback bucket is legitimate belt-and-braces, never the fix on
  its own.**
- **Guard:** `edit-items.tsx`'s `snapshotWriteRef.current` refuses on `userId == null`
  (`REG-MSCAN-A4-anon`, source-text pin in `edit-items-drawer.test.ts`);
  `session-teardown.ts` step (6) also sweeps `editItemsSnapshotUserPrefix(null)`
  (`REG-EDIT-SWEEP-B`/`REG-MSCAN-A4-anon` in `session-teardown.test.ts`).

### L-146 · 2026-09-14 · domain · B221 driver return-list scoping

- **Symptom:** `GET /returns` is `@Roles(OPERATOR, DRIVER, CUSTOMER)` on the controller, but
  `ReturnsService.findAllForUser` had a scoping branch for CUSTOMER only — a DRIVER fell through
  to the unscoped, tenant-wide `findAll`, seeing every return in the tenant rather than just
  ones on orders assigned to their own route runs.
- **Root cause:** the role was added to the endpoint's authorization list (so a driver COULD
  call it at all) without a matching branch in the service's OWN scoping logic — `@Roles` and
  tenant-scoping (`forTenant()`) both silently read as "this is handled," but neither actually
  restricts results to the CALLER's own data once past the tenant boundary.
- **Lesson:** **`@Roles(...)` is authorization (can this role call the endpoint at all), never
  scoping (which rows can this specific caller see). Adding a role to an endpoint's allow-list
  is only half the change — grep the SERVICE method's own list-scoping for a branch per role
  actually granted access, and add one for any that's missing, or the new role inherits
  whichever existing branch's fallthrough happens to run (often the most-privileged one).**
- **Guard:** `ReturnsService.findAllForUser`'s DRIVER branch (resolves the caller's `Driver` row,
  scopes via `where.order = {routeRun: {driverId}}`); `returns.security.spec.ts`'s B221 suite.
  Sibling pattern already fixed once in `credit-notes.service.ts` (DRIVER denied outright there,
  a different but equally deliberate choice — the point is BOTH required an explicit branch).

### L-155 · 2026-09-15 · domain · PR-2 fix round (F2: retired-writer branch vs legacy data)

- **Symptom:** B348 removed a `cancel()` branch handling ReturnStatus PROCESSED, reasoning "no
  writer sets this anymore" (confirmed by grep) — independent review restored it: rows already
  PROCESSED from before the writer was retired still need cancel() to undo their stock/ledger
  effects, and removing the branch stranded that reversal for every such legacy row.
- **Root cause:** "no live writer" was verified against CODE (a grep for the enum value) and
  treated as equivalent to "no live DATA in that state" — a retired write path leaves its
  already-written rows behind; the enum member stayed real in the schema.
- **Lesson:** **Before deleting a branch that HANDLES an enum/state value because nothing WRITES
  it anymore, that is a claim about existing DATA, not code — verify with a query (or an
  explicit prod count) before removing the read/update-side handling, not a grep for writers.**
- **Guard:** `returns-ledger.spec.ts`'s PROCESSED-cancel case pins the restored behavior; the
  comment on the branch cites the exact prod check (`GROUP BY status`) that would retire it.

### L-132 · 2026-09-13 · domain · F27 B70 (estimates)

- **Symptom:** a fix round made `accept()`'s atomic claim exclude the full terminal-status set
  instead of CONVERTED alone, breaking the pre-existing invariant that a DECLINED estimate can
  still be accepted — then edited the two pre-existing tests that caught this to match, and left
  the PIN test that would have caught it `it.skip`'d. Shipped invisibly until an adversarial review
  re-derived the invariant from the baseline.
- **Root cause:** `voidEstimate()` writes the same enum value `decline()` does (no separate VOID
  member exists), so one shared exclusion set applied to every transition method is wrong for
  `accept()` alone, which has a pre-existing invariant the shared value must not block. The fix
  widened a helper's default to a caller needing an exception, then edited that caller's own
  regression test instead of the implementation.
- **Lesson:** **When a change makes a pre-existing, already-passing test fail, that failure is the
  finding — fix the implementation to keep satisfying it, never the test's assertion to match the
  new behavior.** A shared helper's default allow/exclude-list is a hypothesis for every caller, not
  a fact; a caller with its own documented invariant takes an explicit, narrower parameter.
- **Guard:** `claimTransition(id, to, refusal, exclude = TERMINAL_ESTIMATE_STATUSES)` takes
  `exclude`; `accept()` passes `["CONVERTED"]` explicitly, commented with why this doesn't reopen
  the laundering chain. `PIN-B70 accept() still allows DECLINED->ACCEPTED` is live (un-skipped); a
  new `REG-B70 accept() alone cannot re-open a CONVERTED estimate` test covers the direct path the
  two pre-existing "laundered chain" tests miss (both short-circuit at `send()`, never reach
  `accept()`). **Corollary the pre-merge review then had to add (2026-09-13):** the restored PIN
  stubbed `updateMany` to `{ count: 1 }` unconditionally, so it pinned the exclusion list's SHAPE
  while never proving a real DECLINED row matches it — a test that mocks the predicate under test
  into always-succeeding is not a behavioral pin. It now also runs through
  `createLaunderingHarness`, which evaluates the predicate against a stateful row. Same pass
  restored the two `accept()` assertions from nested `expect.objectContaining` to exact
  `toHaveBeenCalledWith`: objectContaining silently admits extra `where` keys, so the key-set
  (`{ id, status }`, no tenant key) was pinned nowhere.

### L-154 · 2026-09-15 · domain · PR-3 independent review F1/F4 (moved logic, new entry point)

- **Symptom:** two findings, same root shape. F1: a handler copied from `ProductPickerSheet.onScanned`
  (single-shot) into a `continuous` `BarcodeFab` returned no `ScanOutcome`, so the scanner showed zero
  feedback per scan — the sheet's own `setScanOpen(false)` had masked the missing return there. F4: a
  cost-prefill rule moved verbatim from an `onSelect` only prefilled an EMPTY field, so scanning A then
  B billed B at A's cost — true of the original tap-search-tap flow too, but the scan FAB makes it routine.
- **Root cause:** both fixes reused logic that carried an implicit assumption from its ORIGINAL context
  (single-shot, slow-to-trigger) into a NEW entry point (continuous, one-tap) that invalidates it; neither
  review checked whether the new surface's usage pattern (fires often, fires fast) still holds it.
- **Lesson:** **Moving/copying logic into a new entry point is not done once it compiles and matches
  structurally — audit whether the new surface's usage pattern still holds every assumption the original
  context relied on implicitly. A rule safe because triggering it was slow/rare stops being safe once a
  faster trigger sits on the same code.**
- **Guard:** `scan-affordance-siblings.test.ts` (REG-F1) and `purchase-receive-logic.test.ts` (REG-F4) pin
  the fix; F4's rule is now an exported, unit-tested `nextUnitCost` instead of living only inline.

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

### L-163 · 2026-09-15 · domain · Lite-L2 fix round: plan re-pin + frozen-catalog literal

- **Symptom:** an admin plan change to LITE, applied later by the nightly cron, booked a -$249
  ledger delta instead of the real -$150 and left the tenant on STARTER entitlements. Separately,
  a "frozen" v11 catalog snapshot silently gained 5 flags it never actually had.
- **Root cause:** two shapes of the same mistake. (1) A mutation validated a target plan against
  the published catalog but never persisted WHICH version proved it valid (`planVersionId`) — a
  later async step re-resolved against the tenant's stale pinned version, found nothing, and
  silently priced the target as $0. (2) A supposedly-frozen historical definition derived itself
  via `.filter()` over a live, growing shared constant, so every unrelated addition rewrote it.
- **Lesson:** **Validating a value against a source of truth is not enough — persist the resolved
  reference itself (the version id), so a LATER step reads the same evidence, not a stale one.
  Anything meant to be a frozen/historical snapshot must be a literal, never a derivation from a
  live source that can grow.**
- **Guard:** `billing-cron.service.spec.ts` REG-1 (re-pin + real delta); `plan-catalog-v12.spec.ts`
  pins v11 ENTERPRISE to its exact historical 13-flag literal.

### L-164 · 2026-09-15 · domain · Lite-L2 fix round: SubscriptionView.flags fail-open

- **Symptom:** a deploy skew (old API, new web/mobile build) or rollback serving a response with
  no `flags` key locked every plan-gated route and hid every plan-gated nav item, for every
  tenant on every plan — not just the one plan the field was added for.
- **Root cause:** `subscription?.flags ?? []` (and the equivalent `?.includes(key) ?? false`
  hooks, on both web and mobile) treated "the field is absent" identically to "present and
  empty" — but the request had already resolved, so a reader downstream saw "resolved, zero
  grants" and gated for real.
- **Lesson:** **A shared response field a rollback/version-skew can omit must be typed optional,
  and every reader must distinguish `undefined` ("unresolved, fail open") from `[]` ("resolved,
  no grants — gate for real"). Never let `?? []` erase that distinction.**
- **Guard:** `plan-flags.test.tsx` (web) and `plan-flags.test.ts` (mobile) both pin the
  undefined-vs-`[]` pair.

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

### L-160 · 2026-09-15 · domain · T14 catalog-driven plan select vs server's PLAN_KEYS allow-list (REG-743-F1)

- **Symptom:** the catalog-driven plan `<select>` on `admin/tenants/new/page.tsx` rendered every
  row `fetchPlanCatalog()` returned; `create-tenant.dto.ts` validates `@IsIn(PLAN_KEYS)`, a
  narrower allow-list, so a legacy or not-yet-launched catalog row would 400 on submit.
- **Root cause:** two sources of truth for "which plans can this form offer" — the published
  pricing catalog (business config, can carry legacy/future rows) and the server's accepted-value
  enum — were conflated; the UI trusted the broader one.
- **Lesson:** **When a form's options come from a dynamic/business-config source rather than a
  hardcoded enum, filter to whatever narrower set the server actually validates against — a
  catalog superset is not a submittable set.**
- **Guard:** `page.test.tsx`'s REG-743-F1 cases — an extra non-`PLAN_KEYS` catalog row is excluded
  from rendered options; a catalog with zero `PLAN_KEYS`-eligible rows falls back to exactly
  `PLAN_KEYS`.

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
- **Guard:** none yet — propose `post-deploy-check` reading the full status array (not just index
  0) or verifying the served commit sha directly, whichever ships first.

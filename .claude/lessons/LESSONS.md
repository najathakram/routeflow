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

### L-074 · 2026-09-05 · tooling

- **Symptom:** a prod-capable seed run through `railway run --service postgres` wrote to the LOCAL
  dev database.
- **Root cause:** the script defaulted `DATABASE_URL` to a localhost URL and the postgres service
  exposes only discrete POSTGRES_*/TCP-proxy vars.
- **Lesson:** **a script that can target production never has a silent local default: resolve the
  target from the variables the runner actually injects, print the resolved host before
  connecting, and treat "nothing set" as a loud fallback.**
- **Guard:** `resolveDatabaseUrl` + its spec; the seed logs its target host.

### L-055 · 2026-09-03 · tooling · wave D imp-05

- **Symptom:** Jest matched **zero tests** in this worktree with the documented
  `testMatch: ["<rootDir>/**/*.test.{ts,tsx}"]` — `npx jest --listTests` returned empty.
- **Root cause:** every worktree here lives under `.claude/worktrees/<name>`, so a
  rootDir-substituted glob always contains a `\.claude` segment on Windows. `jest-config`'s glob
  normalizer converts `\` → `/` EXCEPT when the backslash precedes one of `$()+.?^{}` (assumed an
  escaped glob char), so that one separator survives literally and picomatch then compiles `\.` as
  an escaped dot — matching nothing.
- **Lesson:** on Windows, never embed `<rootDir>` in a Jest glob when the path can contain a
  dot-directory; use a relative `testMatch` scoped by `roots` instead.
- **Guard:** `apps/web/jest.config.js`'s inline comment on `testMatch`; the web suite count (19
  spec files) pinned in `.claude/code-map/web.md`.

### L-068 · 2026-09-04 · tooling · #597

- **Symptom:** a proven ledger row silently back to `queued`; a live lock stolen, admitting three
  writers; a refused `move` destroying the authoritative row — every gate green.
- **Root cause:** an unlocked read-modify-write (stale data enters at the READ, and a
  read-back-assert re-reads the row that survived); staleness measured as AGE, so a waiter stole a
  LIVE lock and release deleted the lock PATH unconditionally; and the durable record of intent was
  written BEFORE the step that could still fail.
- **Lesson:** **Hold an exclusive lock across the READ as well as the write wherever two processes
  may touch one file — a read-back-assert can never see the write yours erased. Break a lock on
  LIVENESS (owner pid/token, ESRCH), never on age; release only the lock you own; fix break and
  release together; when two constants work in only one order, test the order. Order writes so any
  failure leaves the safest reachable state: additive write first, verify it landed, irreversible
  step last.**
- **Guard:** `withShardLock`/`withCatalogueLock` (atomic `mkdir` lockdir, `owner.json` {pid, token},
  released from an `exit` handler); `BUGS_TEST_STALL_MS` widens the race; planted failures
  (cross-shard duplicate, real `EISDIR`, corrupted record mid-loop) assert the PRE-failure state
  survives.

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

### L-152 · 2026-09-15 · process · #743 fix round T5 "one MRR engine" claim

- **Symptom:** T5 replaced two retired catalog-fallback estimators
  (`_catalogPriceByPlanKey`/`_monthlyPriceUsd`) with one shared `priceSubscription()`/
  `priceTenant()` path and described the change as making `MrrService` "the one MRR engine" —
  a claim about EVERY caller of money-pricing logic, verified only against the one call site
  (`getTenant()`) the task brief named.
- **Root cause:** "the one caller that was migrated" and "every caller of the retired helper" are
  different claims; a brief that names one caller can leave a sibling call site (another service,
  a script, a test fixture computing the same figure independently) still on the old path with
  nothing failing to say so — the retired helper being deleted only proves the ONE known caller
  broke, not that no other caller existed.
- **Lesson:** **Before declaring a function "the one X" or "the single source of truth" for
  anything, grep the whole tree for the OLD mechanism's name/signature, not just the call site the
  task brief already named — a deletion only proves what it broke, never what it missed.**
- **Guard:** `mrr.service.spec.ts`'s `REG-743-N1` test proves `priceTenant()` and
  `computeOverview()` sum to the same total for the same fixture (structural proof, not just "the
  old helper is gone"). Sibling [[L-119]] — same theme, an earlier money-figure seam.

### L-153 · 2026-09-15 · tooling · #743 fix round T3 child-process env leak into a prod-capable CLI

- **Symptom:** two DB-lane specs spawn a prod-capable backfill CLI via `execSync` with
  `env: {...process.env, DATABASE_URL: dbUrl}`. The CLI's own `resolveDatabaseUrl()` prioritizes
  Railway TCP-proxy vars OVER `DATABASE_URL` when set — so a parent process with a leftover
  Railway proxy export (e.g. an earlier `railway run` in the same shell) leaks into the child,
  pointing a "local-only" test's CLI at the production database.
- **Root cause:** `{...process.env, DATABASE_URL: dbUrl}` ADDS a key, it does not REMOVE any —
  scrubbing is the caller's job and neither spec did it. Overriding one variable doesn't guarantee
  which variable wins inside the child's OWN resolution precedence.
- **Lesson:** **A child process inherits variables, not a guard — when a spawned CLI has its own
  "A beats B" precedence, setting B in the child's env isn't enough. Delete every variable in the
  higher-precedence set before spawning, and test by FAKING those vars on the parent to prove the
  child still resolves correctly.**
- **Guard:** `childEnv(dbUrl)` helper in both DB specs deletes every `RAILWAY_*`/`POSTGRES_*` key
  before setting `DATABASE_URL`; each file's `REG-743-N2` test fakes Railway vars on the spec's
  own `process.env` and asserts the child still resolves to the local host.

## testing

### L-063 · 2026-09-04 · testing · imp-04

- **Symptom:** after apps/api's suite was split into two `npx jest` invocations,
  `scripts/campaign-check.mjs` reported 17 undischarged bug-registry claims that the first run
  had already proven.
- **Root cause:** apps/api's jest config wires a campaign reporter that OVERWRITES
  `.campaign/runs/api.json` on every invocation (no merge), and non-anchored substring filters
  (`auth` without a trailing slash) also ran `src/authorizations/**` in both partitions (239
  suites/3686 tests vs the true 233/3632).
- **Lesson:** **never split a jest invocation whose config wires a campaign/artifact reporter —
  run apps/api's full suite in one `npx jest --maxWorkers=2` (~270 s) before `campaign-check`; if
  partitioning is ever required, merge the reporter outputs and anchor patterns with a trailing
  slash.**
- **Guard:** `apps/api/package.json` `jest.reporters` (campaign reporter) +
  `scripts/campaign-check.mjs`; the pre-push hook runs the suite unsplit.

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

### L-100 · 2026-09-08 · domain · #678

- **Symptom:** three numbering series minted cross-tenant on a null request tenant and raced to a
  raw 500; a rolled-back settlement re-minted the same payment number.
- **Root cause:** `forTenant()` returns the UNSCOPED client on a null tenant, so a "tenant-scoped"
  scan is only scoped when a request tenant exists; counters inside a rolled-back tx re-issue
  numbers; TEXT max+1 scans have no wall past 9999.
- **Lesson:** **Mint every document number through `NumberingService.reserveNext(type, { year,
tenantId })` with `tenantId` passed EXPLICITLY (never inferred from `forTenant()`), reserved
  STANDALONE before any transaction that can roll back, with P2002 → 409 and a bounded retry on
  serialization failure that reuses the reserved number; a green pin must never carry a `REG-`
  token (the red gate reads titles).**
- **Guard:** `apps/api/src/**/{credit-note,payment,import}-numbering.db.spec.ts` (REG-B267/B268/B269),
  `numbering.service.spec.ts`.

### L-096 · 2026-09-08 · domain · #671

- **Symptom:** F16's design of record specified a new `InvoiceCounter` table; S2 found the
  per-tenant, per-year `NumberingSequence` + `NumberingService` already shipped (a code comment
  naming B100), so building the table would have created a second numbering store.
- **Root cause:** the design was written from the bug report, not from the schema.
- **Lesson:** **Before designing any new store/counter/registry, grep the schema folder and the
  modules for the dimension you need — an existing primitive with a gap (here, an unused `year`
  column) beats a new table every time.**
- **Guard:** the bug-pipeline S2 refutation step now asks "does the primitive already exist?"
  explicitly.

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

### L-118 · 2026-09-13 · domain · F38 at-door money (B305)

- **Symptom:** the at-door amount was the pre-tax line sum; three rounds refuted each "obvious"
  server basis — `Order.total` omits discount, one draft misses a split order's siblings,
  per-line tax snapshots ignore exemption.
- **Root cause:** the client mirrored whichever column looked like the answer instead of
  reproducing what the server bills.
- **Lesson:** **A client money figure must reproduce the SERVER's billing rule from the inputs
  the server bills from — its open DRAFT invoices — never a convenient column, and every flag
  that rule applies must be projected to the client too.**
- **Guard:** REG-B305 in `run-money.test.ts` + `routes.run-stop-select.spec.ts`.

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

### L-120 · 2026-09-13 · domain · billing self-serve (TRIAL-1 / RO-1)

- **Symptom:** every trial tenant's "Cancel" 404'd; an expired trial showed the same button, got
  the same 404, and saw no explanation — a guard-enforced lockout with no UI.
- **Root cause:** `cancel()` keyed on a `TenantSubscription` row `register()` never writes, while
  the real lifecycle state lives on `Tenant.status`; the web rendered that status as a raw badge
  with no branch for the guard's `READ_ONLY` code.
- **Lesson:** **Key a lifecycle action on the table that owns the state; a sibling row some
  creation path never writes is optional — a missing-row 404 there hides a legitimate transition.
  Every status the API can return and every code a guard can emit needs a UI branch, or the
  lockout is invisible.**
- **Guard:** TRIAL-1 in `subscription-mutation.service.spec.ts`; RO-1 in
  `subscription.service.spec.ts` + `billing-page.test.tsx`.

### L-121 · 2026-09-13 · domain · STRIPE-CANCEL-1

- **Symptom:** a tenant on an admin-provisioned Stripe subscription clicked Cancel; Stripe kept
  invoicing; the cron made it READ_ONLY (−MRR), the next paid invoice lifted it back to ACTIVE
  (+MRR) — a monthly flap while a cancelled customer was charged.
- **Root cause:** `cancel()`/`resume()` wrote `cancelAtPeriodEnd` locally and never called Stripe;
  `onPaymentSucceeded` reinstated ANY non-ACTIVE tenant without reading the local cancellation.
- **Lesson:** **On a provider-billed tenant, write a scheduled billing transition to the provider
  FIRST and locally second — a failed provider call changes nothing, a failed local write
  self-heals off the webhook. Gate the provider call on the state that makes it meaningful (a
  cancellation actually armed, a tenant actually paying): a fix for over-charging must never be
  able to START charging. A webhook that promotes status must read the local intent it overrides —
  an executed cancellation plus a payment is an anomaly to flag, never to resurrect.**
- **Guard:** STRIPE-CANCEL-1 ×15 in `subscription-mutation.service.spec.ts` + ×4 in
  `billing.service.spec.ts`. Class of B107.

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

### L-126 · 2026-09-14 · domain · W1 admin plan change

- **Symptom:** an admin plan-change branch cleared `cancelAtPeriodEnd`, revoking a cancellation
  the TENANT had asked for — no event, no audit line, and the sweep then never churned them, so a
  cancelled tenant was billed indefinitely. The SAME wave repeated it one row later: the fix for a
  different row cleared the tenant's armed downgrade on admin reactivation.
- **Root cause:** both writes were copied from a path where they ARE correct — the first from the
  tenant's own `downgrade()`, the second from the Stripe webhook's reinstatement — into a path
  where an operator acts on someone else's subscription. The code was identical; the authority
  behind it was not.
- **Lesson:** **Consent does not travel with copied code. Before lifting a write from a
  self-service or provider-driven path into an admin path, ask who is acting and on whose behalf:
  a flag the owner of a subscription may clear for themselves is not one an operator may clear for
  them. Check every WRITER of the field first — where each one is a deliberate choice by the
  owner, no third party may quietly undo it.**
- **Guard:** the admin plan change REFUSES in either direction while a cancellation is armed
  (`cancelAtPeriodEnd` added to the select it was blind to); admin reactivation leaves the
  downgrade armed and audits it instead. `REG-FINDING-1`/`REG-FINDING-4` in
  `platform-admin.service.spec.ts`. Sibling [[L-123]].

### L-127 · 2026-09-14 · domain · B216 webhook disarm

- **Symptom:** paying an overdue invoice silently cancelled the tenant's OWN scheduled
  downgrade. They stayed on the plan they had asked to leave, with no event and no audit line —
  the only trace was a downgrade that never happened.
- **Root cause:** the disarm existed to stop a schedule that came due DURING a lapse from firing
  on the first sweep after reactivation. That outcome looks surprising, so it was read as wrong.
  But only the tenant ever arms those fields, so firing late was their intent arriving late, and
  the guard destroyed the intent instead of the surprise.
- **Lesson:** **Before adding a guard that suppresses a surprising outcome, decide whether the
  outcome is WRONG or merely unexpected. Deferred intent that arrives late is still intent: make
  it visible — log it, put it on the event, surface it in the UI — rather than cancelling it. A
  guard that silently deletes a choice only the user could have made is a worse defect than the
  surprise it was written to prevent.**
- **Guard:** five `REG-B216` cases in `billing.service.spec.ts` — both reinstatement paths leave
  the schedule armed and name it on `SUBSCRIPTION_RESUMED`. Sibling [[L-126]].

### L-128 · 2026-09-14 · domain · B408 terminal provider states

- **Symptom:** a cancel path treated ONE provider status as "already done" and every other
  terminal status as a hard failure, so those tenants got a 503 on every retry with the dead
  provider pointer never cleared — a permanent lockout, produced by the code written to remove
  one.
- **Root cause:** the fix was written against the single status its reproduction produced.
  `status === "canceled"` was a set-membership test disguised as an equality check; the
  provider's enum had a second terminal member (`incomplete_expired`) and nothing pointed at it.
- **Lesson:** **An equality check against one value of an external status enum is usually a SET
  membership test nobody has written yet. Enumerate the whole class the branch cares about, name
  it as a constant, and record in the comment which members are deliberately EXCLUDED and why —
  the exclusions are the part the next reader cannot reconstruct from the code. An unrecognised
  future member must fail CLOSED: an unknown state is not a safe state.**
- **Guard:** `STRIPE_TERMINAL_STATUSES` + `REG-B408` ×8 in
  `subscription-mutation.service.spec.ts` — one case per non-terminal status, plus one pinning
  that an unrecognised status still surfaces the error. Sibling [[L-127]].

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

### L-129 · 2026-09-14 · tooling · #745 react skew guard

- **Symptom:** `no-react-skew-hacks.spec.ts` asserted `apps/web`'s `react`/`react-dom` deps
  equal the exact string `"^19.2.0"`. #727's routine Dependabot minor/patch bump moved them to
  `"^19.3.0"` and broke this unrelated guard on master, even though the React-18 pin hack it
  exists to catch had not returned.
- **Root cause:** the test was written to confirm one thing — the old React-18 pin never comes
  back — but asserted a much narrower thing: the exact current semver string. An equality check
  against a moving value stood in for the invariant that actually mattered.
- **Lesson:** **A regression test guarding against a stale/incompatible dependency PIN should
  assert the invariant it actually protects (the major line, or a pattern) — never the exact
  current version string. Pinning the whole string makes every routine dependency bump
  (Dependabot, a minor/patch upgrade) fail an unrelated guard, and repeated unrelated red trains
  people to stop reading CI failures.**
- **Guard:** both assertions now match `/^\^19\./` instead of `.toBe("^19.2.0")` in
  `apps/api/src/common/no-react-skew-hacks.spec.ts`.

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

### L-158 · 2026-09-15 · domain · PR-2 fix round 3 (idempotency guard: ordering + fail-closed)

- **Symptom:** two findings on one newly-built idempotency guard (returns.service.ts create()).
  (a) the replay check ran AFTER order/DELIVERED/ownership validation, so a retry whose order
  state changed for unrelated reasons since an already-successful attempt wrongly 404/400'd
  instead of returning the saved result. (b) the lock acquisition was built fail-open like the
  guard's other methods, but a failed lock has no other backstop against the race it prevents —
  fail-open there silently defeats the whole guard.
- **Root cause:** (a) validation predating the guard stayed in its original position instead of
  being re-examined against the new replay path. (b) fail-open was applied uniformly, without
  asking whether each method has an independent backstop if it fails.
- **Lesson:** **Adding a replay guard around an existing operation: (1) the replay check runs
  BEFORE any validation reading MUTABLE state the original attempt already passed; (2) fail-open
  is a per-method decision — a step with NO other backstop against the harm it prevents (a lock
  closing a race) must fail CLOSED, even when siblings safely fail open because a domain-level
  guard backstops them.**
- **Guard:** `returns-idempotency.spec.ts`'s retry-after-state-changed case;
  `idempotency.service.spec.ts` REG-IDEM-SVC-9; `returns-idempotency.db.spec.ts` (real Postgres).

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

### L-133 · 2026-09-14 · process · Phase 0 T10 deferred-gap markers

- **Symptom:** the T9-T11 lane's plan pseudocode said `UpdateTenantPlanDto`/`ActivateSubscriptionDto`
  "already use `@IsEnum(TenantPlan)`... nothing to do" for Task 10. The actual code (written by an
  earlier lane) instead used `@IsIn(SELECTABLE_TENANT_PLANS)`, which deliberately EXCLUDED
  GROWTH/SCALE with comments and dedicated specs both saying "not yet selectable — Phase 0 Task 10
  gap." Following the plan text as written would have left that gap open while marking Task 10 done.
- **Root cause:** the plan was written against an earlier snapshot of the code; a later lane (T1-T6)
  had since built a more careful interim state (a real gap, explicitly fenced off with forward
  references to the exact task that would close it) that the plan's pseudocode never anticipated.
- **Lesson:** **Before implementing a task from a written plan, grep the touched files for the
  task's own number/name in comments and spec titles ("Phase 0 Task N gap", "TODO: TaskN").** A
  prior lane often leaves an explicit, load-bearing marker naming exactly what the next task must
  close — trust that marker over the plan's stale pseudocode, and treat closing it as in-scope even
  when the plan text says "nothing to do here."
- **Guard:** `planKeyFromEnum()` now identity-maps GROWTH/SCALE, `SELECTABLE_TENANT_PLANS` includes
  them, and both DTO specs flipped from "rejects" to "accepts" (`update-tenant-plan.dto.spec.ts`,
  `activate-subscription.dto.spec.ts`).

### L-134 · 2026-09-14 · testing

- **Symptom:** a new `*.db.spec.ts` passed locally but CI's "Replay migrations on a fresh
  database" job failed its `beforeAll` with "No PUBLISHED PlanVersion … run `local:seed` first",
  then `afterAll` threw `Cannot read properties of undefined (reading 'id')` and Jest hung on an
  unclosed pool.
- **Root cause:** `local:seed` publishes the plan catalog (global reference data `PlanVersion`
  starts empty of); CI's replay job runs `test:db` on a freshly migrated DB with no seed at all,
  so a spec assuming seeded reference data is green locally and red in CI.
- **Lesson:** **A db spec creates every row it reads — including global reference data — in its
  own `beforeAll` (use an existing row if present, else create a minimal one and remember it),
  tears down only what it created, guards cleanup on the fixture existing, and always closes the
  pool in `afterAll` even when `beforeAll` threw.**
- **Guard:** CI's migration-replay job (fresh DB, no seed) is the standing check;
  `backfill-subscription-reconciliation.db.spec.ts` is the reference pattern. Derive any fabricated
  integer key/version from the table (`max(col) + 1`), never `Date.now()` — a timestamp overflowed
  `PlanVersion.version` (int4) only on CI's fresh DB, the one environment you cannot run locally.

### L-147 · 2026-09-15 · domain · WP4 print-row state

- **Symptom:** invoices-list Print used one `printingId` for every row; printing row A then
  clicking row B cleared A's spinner, both buttons racing the same flag.
- **Root cause:** a single scalar stood in for "this row's action is pending" across a list —
  wrong once two rows can act at once.
- **Lesson:** **Per-row async state in a list is keyed per row (`Set`/`Map` of ids), never one
  scalar — a scalar assumes at most one row is ever in flight.**
- **Guard:** `invoices/page.tsx` tracks `printingIds: Set<string>`; row `disabled={printingIds.has(inv.id)}`.

### L-150 · 2026-09-15 · domain · B264/B265/B266 mobile scan FABs

- **Symptom:** a `BarcodeFab` mounted inside a `FormSheet`-wrapped screen rendered but scrolled away
  with the form content instead of floating fixed — the defect the floating-FAB pattern exists to
  prevent, moved one layer down.
- **Root cause:** `FormSheet`'s `children` render inside `FormSheet`'s OWN internal `ScrollView`
  (`components/FormSheet.tsx`), not under the screen's stable outer container. `position:
"absolute"` there is relative to the scrolling content box, not the viewport, so it moves with
  the scroll. Every other `BarcodeFab` consumer uses a plain `SafeAreaView` + sibling `ScrollView`,
  where this trap doesn't exist.
- **Lesson:** **A wrapper whose `children` land inside its OWN scrolling container is not a safe
  parent for an absolutely-positioned floating element — check the wrapper's own source for where
  `children` actually renders before assuming position is unaffected. Mount the floating element
  as a SIBLING of the wrapper instead (a Fragment), never inside its `children`.**
- **Guard:** `apps/mobile/__tests__/scan-affordance-siblings.test.ts` pins the FAB's mount position
  on all three screens (`fabAt > formSheetCloseAt`).

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

### L-148 · 2026-09-15 · domain · #756 F1, shared mutation observer

- **Symptom:** an invoices-list row's Print button called ONE shared `useDownloadInvoicePdf()`
  hook's `.mutate(id, { onSuccess, onError, onSettled })` per row. Printing row A then row B
  before A settled silently dropped row A's print, its error toast, and left its spinner stuck
  forever.
- **Root cause:** TanStack Query v5's `useMutation()` is a single observer per hook instance —
  concurrent `.mutate()` calls share that state, so per-call callbacks passed to an EARLIER call
  are overwritten by whichever call fires last, not accumulated.
- **Lesson:** **A list's per-row action must never share one `useMutation()` hook across
  concurrent rows via `.mutate(id, { onSuccess, ... })`. Use `mutateAsync(id)` with a LOCAL
  try/catch/finally at each call site instead — no shared callback state to overwrite.**
- **Guard:** `invoices/page.tsx` row Print now uses `mutateAsync`
  (`print-row-concurrency.test.tsx`, two rows resolving out of order). Sibling-sweep grep
  (unaudited — dozens of hits, most single-instance and safe): `grep -rn '\.mutate([a-zA-Z].*{$'
apps/web/app --include=*.tsx -A1 | grep -B1 onSuccess` — narrow to `.map()`-rendered LIST rows
  sharing one hook before assuming any hit is a real instance of this bug.

### L-157 · 2026-09-15 · domain · #743 review round #3 (F1/F2)

- **Symptom:** an admin MRR card fell back to a client-side per-plan price estimate when the
  server rollup failed -- a free pilot showed at full list price. A reconciliation script's
  `--apply` wrote real prices to live PRODUCTION tenants with nothing between "ran the dry run"
  and "wrote to prod" -- a stale terminal was indistinguishable from a reviewed decision.
- **Root cause:** both were "best-effort" conveniences added without asking what happens when
  the safety net itself is wrong: a fallback estimate is a second, unaudited pricing engine; an
  unconfirmed bulk write on money data has no seam between intent and action.
- **Lesson:** **A money surface gets ONE engine, never a fallback estimate -- on failure, say so
  ("unavailable"), never invent a number. A bulk write on live money data needs an explicit
  confirmation naming what's about to apply (`--confirm-count <n>` matching the dry run),
  refused otherwise.**
- **Guard:** `admin/billing/page.tsx` deleted `PLAN_PRICES`, shows "MRR unavailable" on error.
  `backfill-subscription-reconciliation.mjs` requires `--confirm-count` matching the scan when
  `--apply` runs unscoped. Sibling fix same round: the write's `updateMany` re-asserts tenant
  state, closing a scan-to-write race.

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

### L-161 · 2026-09-15 · tooling · T12-T15 review round F1/F2 (house-tenant script + mirror re-validation)

- **Symptom:** `bootstrap-house-tenant.mjs` called `new PrismaClient()` with no driver adapter —
  Prisma 7 throws. `TenantMirrorService#upsert` trusted a once-resolved `platform.houseTenantId`
  forever, so a config key later pointing at a deleted/reclassified tenant would write admin data
  into it.
- **Root cause:** a resolved or pattern-copied dependency was trusted without re-checking it
  against its current siblings or current row.
- **Lesson:** **A prod-targeting script must match its siblings' PrismaPg/pg.Pool client setup,
  never a bare `new PrismaClient()`. A writer resolving a special row by id must re-validate its
  identity/class on every write, not just once.**
- **Guard:** `bootstrap-house-tenant.db.spec.ts`, `tenant-mirror.service.spec.ts`.

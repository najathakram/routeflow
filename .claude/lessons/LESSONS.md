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

### L-083 · 2026-09-06 · tooling · campaign-check freshness

- **Symptom:** four pushes in one day were refused twelve minutes into `npm run verify` with "no test titled
  with REG-B###", although the tests existed and passed — the machine-local Jest report campaign-check reads
  was simply older than the ledger rows it was asked to prove.
- **Root cause:** turbo replays a `test` task whose input tree it has seen before (a worktree whose workspace
  matches master's after a merge), so the reporter never runs and `.campaign/runs/<ws>.json` keeps the tokens
  of its last real run; the gate compared claims against that stale artifact as if it were current.
- **Lesson:** **an artifact a gate consumes must carry its own provenance (its start time) and the gate must
  compare it with the inputs it certifies — the newest commit touching the workspace's tests or the ledger —
  and refuse a stale artifact by name, with the regeneration command, before it scans a single token.**
- **Guard:** `scripts/campaign-check.mjs` freshness rule (full mode, before indexing) + `--freshness-only`
  pre-step at the head of `npm run verify` that asks `turbo --dry-run=json` whether a replay is coming;
  `apps/api/src/common/campaign-check-freshness.spec.ts` T1–T17 (T15–T17 added in fix-round 1: the
  bound now uses `git log --first-parent` — a merge TREESAME to one parent for the path was judged
  by the OLDER pre-merge commit otherwise — and clamps to `Date.now()` on a future-dated commit).
  Addendum (chore/next-15): after committing, regenerate every T1 workspace's report (`cd
apps/<ws> && npx jest --maxWorkers=2`) before push — a cache-hit never reruns the reporter.

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

### L-067 · 2026-09-04 · tooling · #597

- **Symptom:** eight defects from one script: "updated" edits that changed nothing, mangled authored
  text, a regex parsed as a comment, a record claiming a proof it never held.
- **Root cause:** each write and derivation trusted something other than its own result — a STRING
  `replace` expands `$1`/`$&` out of the CALLER's text; an anchored replace that misses returns the
  subject unchanged; a regex routed through a script's template literal loses a backslash layer; a
  derived field read a proxy, not the field it names.
- **Lesson:** **A write must prove its own effect; a derived field comes from the field it
  represents, never a correlate. Function replacement for authored text; compare before/after and
  fail when equal ("wrote" ≠ "changed"); `proof` from `row.proof`, "event recorded" from the
  append's return; write regex/escape-heavy edits directly, never through an intermediate script's
  string layer; EXECUTE the function you patched — `node -c` proves it parses, not that it runs.**
- **Guard:** `bugs self-test` (step 6 of `npm run verify`): `$`-safety, one `## History` per record,
  ledger id-uniqueness, real `cmds.render` on a fixture, sync done→queued→done, reopen leaves the
  proof clear.

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

### L-061 · 2026-09-04 · testing · wave B′ P4

- **Symptom:** a fail-closed `default:` added beside Prisma's named `$allModels` handlers threw on
  every scoped query. Only the DB lane caught it — a unit test calling the handler directly stayed
  green.
- **Root cause:** Prisma composes `$allModels.$allOperations` WITH the named per-operation handlers
  rather than choosing the most specific one: a named handler's `query()` runs the catch-all next.
- **Lesson:** **A client-extension catch-all cannot coexist with a named map — write ONE
  `$allOperations` switch with an explicit default. And a spec that calls an extension handler
  directly proves nothing about how the framework COMPOSES it: exercise the composed chain (a real
  client, or the DB lane).**
- **Guard:** `prisma-isolation.spec.ts` drives the real `_tenantExtension`; `local:test:db` runs on
  `apps/api/src/prisma/**` PRs (`db-migrations.yml` paths).

### L-060 · 2026-09-03 · testing · wave B′ P4

- **Symptom:** a spec commissioned as a "pin" (`tenant-findunique.db.spec.ts`) shipped 8/17 RED. Its
  own header said the block was red "before the fix", but the package was scoped test-only, so no
  fix was written and the branch's `npm run local:test:db` acceptance could not pass.
- **Root cause:** the brief asked for tests that _pin_ an invariant (cross-tenant
  `findUniqueOrThrow` throws) without anyone first checking the invariant held. It did not:
  `findUniqueOrThrow` was in neither tenancy layer of `prisma.service.ts` — absent from
  `POST_FILTER_METHODS`/`SCOPED_METHODS` in `_wrapTxWithTenant` and from `_tenantExtension`'s
  `$allModels` map — so it returned another tenant's row on `forTenant()` and inside
  `tenantTransaction()`.
- **Lesson:** **A "pin" brief must state the expected colour per test, and any test that comes out
  red escalates the package from `test:` to `fix:` on the spot.** A red pin is a live defect
  report, never a spec to ship as-is — and "we only add tests" is not a reason to leave one red.
- **Guard:** the RED BAR block now asserts `code: "P2025"` (Prisma's own not-found shape), so a
  regression that returns the row — or throws something else — fails the DB lane.

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

### L-113 · 2026-09-12 · testing · CRM GoHighLevel handoff

- **Symptom:** the handoff's ExternalRef lookup used `where: { source: "gohighlevel" }` though
  the Prisma column is `externalSource`; 99 unit tests stayed green since every Prisma call was a
  `jest.fn()` mock typed `any` — a real client throws on statement one, so no customer is ever
  created in prod.
- **Root cause:** a mock-boundary spec proves control flow, not the schema contract.
- **Lesson:** **every new Prisma call site needs a proof its `where`/`data` matches the schema —
  a DB-lane spec, or a unit spec asserting the exact `where` against a
  `Prisma.<Model>WhereInput` literal so `tsc` rejects an unknown column — an `any`-typed mock
  proves nothing about columns.**
- **Guard:** `gohighlevel-handoff.service.spec.ts` #1 (filters on `externalSource`, never
  `source`) + the Opus review in fix-plan.md round 2.

### L-115 · 2026-09-12 · testing · #703 (W16 outage)

- **Symptom:** #702 shipped a controller with per-handler `@UseGuards(AddonGuard)` in a module
  that never imported `BillingModule`; unit specs (boundary mocks), lint and `tsc` were all green,
  the Docker healthcheck hid the boot crash, and prod API answered 502 for 26 minutes
  (`UnknownDependenciesException` at InstanceLoader).
- **Root cause:** Nest resolves a guard's constructor params from the REGISTERING module's scope;
  nothing in the gate chain compiles the Nest container, so a missing module import is invisible
  until the process boots.
- **Lesson:** **module wiring is a boot-time contract that boundary mocks and the type-checker
  cannot see — any diff touching `*.module.ts` or adding a guarded controller needs a proof the
  container compiles (the compose boot gate `local:up` → `local:validate`, or a repo-truth spec on
  the wiring shape) before it is pushed.**
- **Guard:** `apps/api/src/common/addon-guard-module-import.spec.ts` (every `AddonGuard` controller's
  registering module imports `BillingModule`; proven red on the pre-fix tree) + lane rule: compose
  boot before any push that changes module wiring.

## domain

### L-104 · 2026-09-11 · domain · B215

- **Symptom:** a same-key retry of a staff order merge folded the same cart in twice; once the key
  committed with the fold, the retry replayed instead — and skipped the post-fold invoice resync +
  credit sync/settle, leaving the order's invoice and credits out of sync forever.
- **Root cause:** the key committed INSIDE the fold's transaction while the convergent tail after
  it stayed outside, so "already done" was true of the irreversible step and false of everything
  after it. The same diff's new Prisma model also failed `schema-folder.spec.ts`'s model-count
  pin.
- **Lesson:** **An idempotency key must cover the whole unit of work: commit the key with the
  irreversible step, and make every step after it convergent and re-run on replay; append-only
  steps (a revision snapshot) stay behind the key. Any Prisma model change puts
  `apps/api/src/common/schema-folder.spec.ts` in the radius.**
- **Guard:** REG-B215 T2b + T16 in `orders.merge-idempotency.spec.ts`; the `schema-folder.spec.ts`
  model-count pin.

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

### L-047 · 2026-09-04 · domain · F25

- **Symptom:** run dates, licence expiries and dashboard dates shifted a day for viewers west of
  UTC; on-time % was judged against the UTC day-end for tenants in New York; a driver location
  POST was rejected on a platform sentinel `-1`.
- **Root cause:** calendar dates stored as UTC midnight were read with local getters or
  `toLocaleDateString`; one writer stored local `23:59:59`; analytics never read
  `TenantConfig.timezone`; a sentinel reached a `@Min(0)` DTO unmapped.
- **Lesson:** **A calendar date is a string, not an instant: store it as UTC midnight, render and
  edit it only through the shared calendar-date helper (web/mobile mirrors), and evaluate day
  boundaries in the TENANT's timezone through the one api helper — never `setHours`, local
  getters or `toLocaleDateString` on a date-only field. A device sentinel (iOS `-1` for unknown
  heading/speed) never reaches a bounded DTO unmapped — map it to null at the client seam and
  mirror every server bound there, or one unknown field 400s the whole payload.**
  A test for any of this must take the zone as DATA: under `TZ=UTC` — CI and the API image —
  host-local and UTC components are identical, so a host-clock oracle is green on the buggy
  body, and an in-file `process.env.TZ` pin is inert under jest (the sandbox gets a copy of
  `process.env`).
- **Guard:** REG-B59 e2e under `timezoneId`; REG-B118 tenant-tz jest with a DST fixture;
  REG-B90/B91 mobile helper tests + the mirror-identity pin; the revenue-trend pin uses a Date
  whose local getters disagree with its ISO view; REG-B185 DTO spec ([[L-026]] client sentinels
  never reach a validator unmapped).

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

### L-117 · 2026-09-13 · tooling · fresh-worktree first push

- **Symptom:** a linked worktree's first push went out with NO verify (no hook output at all);
  after `npm ci` the next push was REFUSED at the final `campaign-check` ("no test titled with
  REG-B### found in the jest report") although every test existed and passed (#704, 2026-09-12).
- **Root cause:** husky's `.husky/_` hooks exist only after `npm ci`, so a fresh worktree pushes
  silently unverified; once installed, turbo replays shared-worktree-cache HITS for `test`, jest
  never runs there, `.campaign/runs/<ws>.json` are never written and the gate fails on absence
  (sibling of [[L-083]]: there the report was stale, here it does not exist).
- **Lesson:** **A new worktree is push-ready only after `npm ci` has installed the hooks AND one
  uncached `npx turbo run test --force --concurrency=2` has written the campaign reports; never
  trust a push's exit code — read the hook output and confirm the remote head.**
- **Guard:** `campaign-check` refuses the missing-report case (the refusal itself); CI verify on
  the PR head is the merge gate for the no-hook case; P-BUILD step 1 and P-CLOUD-0 step 7 carry
  the routine. Candidate: `scripts/worktree-audit.mjs` flags a worktree without `.husky/_`.

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

### L-122 · 2026-09-13 · domain · F39 (B310/B311/B315 wallet/invoice lost updates)

- **Symptom:** B310 — `applyAdvancePaymentToInvoice` read `AdvancePayment.balance` and decremented
  it as two separate statements inside one Prisma transaction; two concurrent applies of the same
  advance both read the same balance and both passed the "has remaining balance" check, driving it
  negative. B311 — `recordStandalonePayment`'s buyer/online overpay guard had the identical shape
  one call away, on `Invoice` instead of `AdvancePayment`.
- **Root cause:** a single Prisma `tenantTransaction` is NOT a lock — under READ COMMITTED, a plain
  read inside it sees only what's already committed, so a check-then-act on a row neither
  transaction has locked lets two concurrent callers both read the pre-decrement value and both
  proceed; only an explicit row lock (or an equivalent serializing primitive) closes the window.
- **Lesson:** **A balance/limit check followed by a write to the SAME row, inside one transaction,
  is a check-then-act race unless something locks the row (or the caller) BEFORE the read — a
  customer-keyed `withAdvisoryLock` when the critical section spans multiple tables/calls (the
  house pattern for money serialization), or a plain `SELECT ... FOR UPDATE` inside the same tx
  when it's one row — or, when the write is a single column and the cap is expressible in SQL
  (B315's advance-restore), skip locking altogether: one atomic `UPDATE ... SET col = LEAST(cap,
col + delta)` has no read-modify-write window at all. And such a fix is regression-testable
  WITHOUT a live database: mock the lock
  primitive (`withAdvisoryLock`, or the specific `$executeRaw` call) with a per-key promise chain
  that genuinely serializes concurrent callers in call order, drive two concurrent calls through
  the real service method, and assert on the wrong VALUE (balance negative, sum overpaid) — then
  confirm the test is real by temporarily reverting the fix and watching it fail on that same
  wrong value before restoring it.**
- **Guard:** `apps/api/src/customers/customers.service.spec.ts` "B310: two concurrent applies of
  the SAME advance never drive its balance negative" (promise-chain `withAdvisoryLock` mock);
  `apps/api/src/invoices/invoices.service.spec.ts` "B311: a concurrent office payment can no
  longer overpay the invoice past its live balance" (promise-chain `$executeRaw` mock, released
  when the whole `tenantTransaction` call settles — not at the raw-query call site). Both verified
  red-then-green by hand before commit.

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

### L-157 · 2026-09-15 · domain · PR-2 fix round 3 (idempotency guard: ordering + fail-closed)

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

### L-130 · 2026-09-13 · domain · F27 B15 (estimates)

- **Symptom:** the estimate detail page offered "Convert to Invoice" on DRAFT and SENT rows while
  the API's convert claims ACCEPTED only, so the control failed every time it was shown; and a
  successful convert navigated to `/invoices/undefined` because the page read `invoiceId` from a
  response keyed `id`.
- **Root cause:** the client computed its own enable predicate (`DRAFT || SENT || ACCEPTED`) from
  a guess rather than the server's claim predicate, and hand-typed the mutation result instead of
  the shape the endpoint returns.
- **Lesson:** **A control that fires a server state transition renders on ONE predicate equal to
  the server's claim predicate (same status set, from the shared enum), and a navigation off a
  mutation result reads the field the server actually returns — a hand-typed response type is a
  silent `undefined`.**
- **Guard:** every Convert control in `estimates/[id]/page.tsx` renders on the single
  `canConvert = status === "ACCEPTED"` binding (:220) since b47a74a5; `useConvertEstimateToInvoice`
  typed `{ id }`. Pinned by `[id]/page.test.tsx` (zero controls on DRAFT/SENT, exactly two on
  ACCEPTED, navigates on `data.id`) — landed 2026-09-13; B394 (B15-NAV) closes with this proof.

### L-131 · 2026-09-13 · domain · F27 B17/B79 (estimates)

- **Symptom:** the create form required an Issue Date the request never carried and the service
  never wrote (the column had landed by migration earlier); every row rendered `createdAt` in its
  place. "Send" flipped DRAFT→SENT with a toast claiming an email went out — no email path exists.
- **Root cause:** a column landed with no write path — DTO, form payload and service `create`
  were never audited for it — and UI copy described a side effect the endpoint does not have.
- **Lesson:** **A migrated column with no write path is a bug the schema cannot show — when a
  column lands, audit every write site (DTO → service `create`/`update` → form payload) in the
  same change; and UI copy names only the effect the endpoint has (a status flip is "marked as
  sent", never "sent").**
- **Guard:** `estimates.service.ts create()` validates (`/^\d{4}-\d{2}-\d{2}$/` plus an ISO
  round-trip compare — the regex alone accepts an out-of-range day/month, e.g. `2026-02-31`, which
  `Date` silently rolls over instead of rejecting) then persists `dto.issueDate`; shared
  `Estimate.issueDate?: string | null` in `packages/types/api/misc.ts`; the toast copy (aa47ee9e).
  Pinned by `estimates.service.spec.ts` and `estimates.issue-date.db.spec.ts` (real Postgres) —
  landed 2026-09-13. `CreateEstimateDto` now declares `issueDate?: string`, no more `as any` cast.

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

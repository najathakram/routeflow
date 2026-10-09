# Lessons Learned — Archive (RouteFlow)

> Overflow from [`LESSONS.md`](LESSONS.md): superseded, guarded, or aged entries moved here
> verbatim when the register hits its caps. Append-only; not read by default; ids are never
> reused or renumbered.

## process

### L-007 · 2026-08-31 · process · #562

- **Symptom:** an operator kept losing scans after the fix for exactly that had shipped.
- **Root cause:** the fix targeted the native scanner while every client runs the mobile **web**
  build — the reporter never received it.
- **Lesson:** **Before fixing a platform-variant bug, establish which variant the reporter
  actually uses; fix that one first.**
- **Guard:** login-screen build stamp makes "which build is that device on?" answerable.

### L-003 · 2026-08-20 · process · #367–#376

- **Symptom:** five consecutive Railway deploys failed with "Snapshot code → repository not
  found".
- **Root cause:** flipping the repo private in the same breath as the merge landed inside
  Railway's snapshot window, invalidating the clone token mid-snapshot.
- **Lesson:** **After a merge, wait until the deploy reaches `BUILDING` (never
  `INITIALIZING`) before flipping private — and the flip stays a `finally`.**
- **Guard:** the `until … BUILDING|DEPLOYING|SUCCESS` loop in CLAUDE.md's deploy flow.

### L-002 · 2026-08-15 · process · #342

- **Symptom:** the repo sat PUBLIC for ~24 hours after a docs-only PR.
- **Root cause:** the private flip was gated on a CI watcher; docs-only changes trigger no CI
  run, so the watcher polled an empty run id forever and the flip step never ran.
- **Lesson:** **A safety-critical step fires on a bound (deadline), never solely on a success
  signal — and verify the end state directly (`gh repo view --json visibility`).**
- **Guard:** deploy-flow rule in CLAUDE.md; empty-id guard before any poll loop.

### L-001 · 2026-07-30 · process

- **Symptom:** a batch started on the previous batch's already-merged branch; the eventual PR
  base was misleading.
- **Root cause:** the pre-push hook blocks branch deletion, so merged branches linger checked
  out between sessions.
- **Lesson:** **Cut a fresh branch off master before any batch/pipeline run — check with
  `git rev-list --left-right --count master...HEAD` first.**
- **Guard:** none — judgment (pipeline step 0).

### L-005 · 2026-08-20 · process

- **Symptom:** the whole working session died mid-batch and needed manual repair.
- **Root cause:** 14 concurrent background agents (~500 MB each) saturated the 14-core/32 GB
  box — resource starvation, not an app fault.
- **Lesson:** **Cap background agents at 4 and run bigger batches in waves; have every agent
  append results incrementally so a hard kill loses nothing.**
- **Guard:** standing hard rule (memory), workflow concurrency defaults.

### L-006 · 2026-08-23 · process · #412

- **Symptom:** every session paid ~38K tokens just to read the code map's `_meta.json`.
- **Root cause:** its `notes` field accumulated history (~90K chars) because nothing bounded it.
- **Lesson:** **Any always-read field or file needs a hard cap and an overflow home — latest in
  the hot path, history in a changelog.**
- **Guard:** code-map CHANGELOG convention; this register's own caps.

## tooling

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

### L-009 · 2026-08-29 · tooling · #501

- **Symptom:** `npm run verify` printed a full jest pass after a 19-package dependency bump —
  without executing anything.
- **Root cause:** turbo replays cached task logs verbatim (summaries included), and its global
  hash missed lockfile-graph changes until #501.
- **Lesson:** **A test summary inside turbo output is not evidence tests ran — only the
  `Cached: N` line is; gate dependency-affecting changes with `--force` or direct `npx jest`.**
- **Guard:** `globalDependencies` in turbo.json (#501).

### L-012 · 2026-08-29 · tooling · #490 #494

- **Symptom:** removing a transitive pin as "redundant" would have broken every fresh install.
- **Root cause:** root `package.json` `overrides` leave no trace in the lockfile (npm ci cannot
  validate them), and peer graphs make some pins load-bearing in non-obvious ways.
- **Lesson:** **Pin in a workspace devDependency, never root `overrides` — and before removing
  any pin, re-resolve from manifests alone and prove it redundant.**
- **Guard:** `validate-lock` pre-install CI job (#490).

### L-062 · 2026-09-04 · tooling · imp-04

- **Symptom:** dropping `@routeflow/api#test` (forbidden by package-shape.spec.ts) left
  docs-truth.spec.ts/no-dead-deps.spec.ts's outside-workspace reads unhashed by any turbo task.
- **Lesson:** a tripwire spec reaching outside its own workspace must own a turbo task whose
  `inputs` name those files — a `<workspace>#<task>` override is one spec away from forbidden; a
  GENERIC task with explicit inputs survives.
- **Guard:** `turbo.json` `test:repo-truth`; `apps/api/src/common/turbo-inputs.spec.ts`.
  Addendum (chore/next-15): moving a spec INTO the repo-truth lane must add it to the main
  lane's `testPathIgnorePatterns` in the SAME change, or the main api lane still "collects" it,
  runs zero assertions, and reports green.

### L-070 · 2026-09-05 · tooling · #597

- **Symptom:** the registry self-test's dead-holder lock cases failed on CI's Linux runner and
  passed on Windows; the waiter never broke a dead owner's lock and every later case inherited it.
- **Root cause:** `process.kill(pid, 0)` succeeds for a POSIX zombie — a killed child its parent
  never reaped — and a synchronous parent (`Atomics.wait`, `spawnSync`) never reaps.
- **Lesson:** **Signal 0 proves a pid exists, not that it lives. A POSIX liveness check must also
  read `/proc/<pid>/stat` state `Z` (negative-only: unreadable means alive); a fixture that kills
  a child must assert it was observed gone before the code under test runs.**
- **Guard:** self-test `liveness:` checks (a2) and the dead-holder `observed gone` assertion, run on
  both platforms; CI run 33938718344 is the red that proved it.

### L-073 · 2026-09-04 · tooling · wave E `imp-10a`

- **Symptom:** "generated client `index.d.ts` byte-identical before/after" failed on a
  provably-lossless schema-folder split and would have read as a blocking regression.
- **Root cause:** a multi-file schema concatenates in filename order, so a split reorders every
  generated declaration (`modelProps` union, `ModelName` map, top-level re-exports) though content
  stayed set-identical.
- **Lesson:** **Never make a generated artifact's byte identity the oracle for a source
  reorganization — pin the SEMANTICS instead** (block/name multisets on the input, an empty
  `migrate diff` on the output).
- **Guard:** `split-prisma-schema.mjs --check` proves block-identity + `MODEL_DOMAIN` placement;
  `npm run local:drift` is the output-side oracle — both cheap/re-runnable, unlike a `.d.ts` diff.
  Its comment stripper treats a quote left unterminated on its line as regex text, never a string opener.

### L-114 · 2026-09-12 · tooling · plane-learning self-test tmpdir

- **Symptom:** a lead's pre-push verify failed at `plane-learning.self-test: 1 FAILURE(S)` while
  the suite passed alone; build agents saw the same "tmpdir count blip" whenever two suites
  overlapped on the host.
- **Root cause:** each plane self-test proved "leaves no dir behind" by counting
  `<name>-self-test-*` entries in the shared `os.tmpdir()` before/after — another process's
  fixtures (a second verify chain, a builder's test run) change the count, so the invariant
  measured the host, not the process.
- **Lesson:** **Global counts over a shared resource (tmpdir entries, ports, ledger lines) are
  never process invariants — a test proves cleanup by tracking the exact paths it created under a
  per-run unique prefix and asserting those are gone, so parallel runs on one host cannot fail
  each other.**
- **Guard:** `FIXTURE_PREFIX` (name + pid + random) and tracked-path assertions in the six plane
  self-tests (commit 0ed13a56); OPS flake note; one verify chain at a time remains the host rule
  for load-sensitive suites (see [[L-070]] class).

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

## testing

### L-014 · 2026-08-31 · testing · #562

- **Symptom:** two mutation probes survived a green suite.
- **Root cause:** one test pinned collaborator _state_ instead of _consultation_; another used
  `.not.toThrow()` in bare node, where the code path early-returns without `window`.
- **Lesson:** **Assert behavior through the collaborator (seed a real cooldown; make the fake
  host throw) — a totality test must run against a hostile host, not an absent one.**
- **Guard:** rewritten probes in the scan-engine suite.

### L-015 · 2026-07-19 · testing · #301

- **Symptom:** a list page 400'd for weeks ("Failed to load data") while its sibling tab worked.
- **Root cause:** pagination hardening added `@Min(1)` to a list DTO whose web callers send
  `limit: 0` as the fetch-all sentinel.
- **Lesson:** **Before tightening any list-DTO validation, grep `limit: 0` and other sentinel
  params across every client — hardening a contract means checking its consumers.**
- **Guard:** DTO regression specs (products, suppliers).

### L-066 · 2026-09-04 · testing · watchdog spec

- **Symptom:** a spec green on CI failed on every loaded dev box, pushing people to skip the pre-push gate.
- **Root cause:** a fixed 500 ms `setTimeout` stood in for "the spawned child has booted"; bare Node boot here is 0.6–6 s. A poll alone still fails: the api lane's undeclared Jest cap is 5 s.
- **Lesson:** **A fixed delay is never a readiness signal. Wait on the observable (log line, exit, stream) with a capped poll, kill the child in `finally`, and give the async test its own timeout above the cap.**
- **Guard:** `visibility-watchdog-script.spec.ts` slow-boot repro (`NODE_OPTIONS=--require slow-boot.cjs`, 1.5 s) stays green.

### L-076 · 2026-09-05 · testing · F13

- **Symptom:** an E2E toast assertion via bare `getByText` hit a strict-mode violation
  (2 elements) after the app gained an aria-live announcer that repeats toast copy.
- **Root cause:** the same string is rendered twice on purpose — the visible toast
  (`RadixToast.Title`) and Radix's own aria-live status region, portaled to `<body>`, which
  mirrors the same title text for screen readers.
- **Lesson:** **assert toasts through the toast container, never a bare text lookup — any copy
  that is also announced resolves to two elements.** Scope through
  `getByRole("region", { name: /notifications/i }).getByRole("listitem")`, not `page.getByText`.
- **Guard:** the `getByRole("region"…).getByRole("listitem")` scoping convention (documented in
  `21-destructive-guards.spec.ts`; no shared toast-assertion helper exists yet — a gap this entry
  flags) applied at `apps/web/e2e/30-recurring-standing.spec.ts` (REG-B09, REG-B92).

### L-082 · 2026-09-06 · testing · bugs.mjs self-test

- **Symptom:** the registry self-test's pid-reuse fixture failed on an ubuntu runner (four checks in a
  cascade) and passed on every Windows run and on its own CI re-run.
- **Root cause:** the fixture forged a stale lock owner's boot stamp as "now minus 20 minutes"; the
  liveness check treats a stamp within 5 s of the machine's real boot as the same boot, and a CI runner
  that had been up about 20 minutes when the self-test started made the impostor look genuinely alive,
  so the waiter spun out and the next fixtures inherited its lock dir.
- **Lesson:** **never forge a timestamp relative to "now" by a plausible machine uptime — forge it
  relative to the real boot stamp, far outside any slop; and give every fixture its own setup and
  cleanup so a give-up cannot cascade into unrelated checks.**
- **Guard:** the pid-reuse fixture forges `bootAt = bootStamp() − 1 year` and asserts the
  "predates this boot" verdict; the owner-write fixture clears the lock dir before its own precondition
  (`scripts/campaign/bugs.mjs` self-test, step 6 of `npm run verify`).

### L-086 · 2026-09-07 · testing · #647

- **Symptom:** F08's two new post-deploy Playwright rows failed on their first deployed run while
  every other test passed: one expected the returns KPI to move by a hard-coded 10 (order line)
  when the deployed billed basis gave 15; the other's heading locator matched two `h1`s.
- **Root cause:** T2 rows are written without any run, so one encoded an order-line oracle for a
  value the fix had moved to the invoice, and one used an unscoped role locator on a layout whose
  header bar repeats every page title.
- **Lesson:** **a post-deploy money oracle is read from the API at test time — the created record's
  own billed figure, asserted `> 0` first so the row cannot pass vacuously — never computed from
  fixture arithmetic; and heading locators on dashboard pages are scoped to `#main-content`.**
- **Guard:** spec 29's `refundEstimate` fetch + vacuity guard; the T2 harness note in each
  bug-test-plan; a T2 row stays `proven-pending-deploy` until its deploy-triggered run is green.

### L-093 · 2026-09-08 · testing · #665

- **Symptom:** after #657 deployed, `/distributors` answered 307 with no `Location` header in
  production (and in the compose image), while `next dev` redirected fine — the deployment E2E
  (spec 36 T1) was the only thing that caught it.
- **Root cause:** the alias was a prerendered `redirect()` page; served from the ISR cache on the
  standalone server, it lost its `Location` header.
- **Lesson:** **URL aliases and legacy redirects belong in `next.config.mjs` `redirects()`
  (evaluated before middleware, carries `Location` for every UA), never in a prerendered page
  calling `redirect()` — the dev server masks this whole class, so the deployment E2E or a
  production image is the only oracle.**
- **Guard:** `apps/web/app/(marketing)/distributors-redirect.static.test.ts` pins the config
  entry and the page's absence; a repo-wide sweep for the same shape filed 9 unbatched rows
  (B251–B259) rather than extending this one test to cover them.

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

## deploy

### L-019 · 2026-08-31 · deploy · #565

- **Symptom:** the first real APK run crashed at launch, then hung on an eternal spinner.
- **Root cause:** a native module's major-version pin mismatch, plus the native keystore
  rejecting key charsets web storage always accepted — silent write failures.
- **Lesson:** **The first run on a real device is its own test surface — native modules validate
  versions and key charsets that web builds and bundlers never exercise.**
- **Guard:** key sanitizer + regression tests (#565).

### L-018 · 2026-08-25 · deploy · #435

- **Symptom:** a "successful" pre-deploy backup was a 0-byte file.
- **Root cause:** bare `railway run pg_dump` ran against the _linked_ service (not postgres) and
  exited 0 anyway.
- **Lesson:** **A backup isn't a backup until its size and content are validated — pin the
  service explicitly and check the artifact before depending on it.**
- **Guard:** backup-validation step in the ship routine.

### L-017 · 2026-08-18 · deploy

- **Symptom:** after a platform incident, the production API came back pointing at an empty
  database — four months of data gone with the container.
- **Root cause:** the postgres service had **no volume**; data lived on the container
  filesystem, and platform backups were plan-gated and off.
- **Lesson:** **A stateful service without a mounted volume is data loss waiting for the next
  restart — verify volume + external dumps before trusting any DB; restores stream through
  `psql`, never a raw client.**
- **Guard:** volume + PGDATA subdir + 2-hourly R2 dumps with an empty-dump guard.

### L-245 · 2026-09-29 · deploy · SET LOCAL in a Prisma migration is a no-op without an explicit BEGIN/COMMIT (SA-582)

- **Symptom:** a migration used `SET LOCAL` to scope a setting to its own statements; the setting
  never applied, and nothing failed.
- **Root cause:** Prisma applies a migration file non-atomically here, statement by statement outside
  a transaction, and `SET LOCAL` only lasts until the end of a transaction, so with no enclosing
  transaction it changes nothing. Squawk did not flag it.
- **Lesson:** **A migration that relies on `SET LOCAL` (or any transaction-scoped setting) must open
  its own explicit `BEGIN` and end with `COMMIT`; otherwise the statement is a silent no-op.**
- **Guard:** `scripts/lint-migrations.mjs` (`npm run lint:migrations`) refuses `SET LOCAL` with no
  enclosing BEGIN/COMMIT (B896, #2746); pinned by `lint-migrations-script.spec.ts`.

## domain

> archived 2026-09-06 for headroom (L-082 added) — guard automated (db-locks specs, orders.merge-lock spec).

### L-054 · 2026-09-03 · domain · PR-2 `imp-02-order-merge-advisory-lock`

- **Symptom:** a money-critical read-fold-write (order merge) was serialized by an in-process
  promise chain that a second replica cannot see; the deferral note said scaling would corrupt
  lines silently.
- **Root cause:** the lock lived where the code was, not where the data is.
- **Lesson:** a lock guarding a read-then-absolute-write must live in the system of record
  (`pg_advisory_lock` on a pinned connection, or inside the write's own transaction) — never in
  process memory; prove it with two sessions against a real database (`*.db.spec.ts`), never a
  mocked service alone.
- **Guard:** `db-locks.spec.ts` (T1), `db-locks.db.spec.ts` (T4, `npm run local:test:db`),
  `orders.merge-lock.spec.ts` (T3), and `orders.scan-hardening.spec.ts`'s concurrent-merge case.

### L-022 · 2026-08-21 · domain · #393

- **Symptom:** 40% of a live buyer portal showed $0.00 — and the server would have billed it.
- **Root cause:** a FIXED per-unit promo scoped to ALL products, clamped at $0; the engine
  couldn't express the owner's real intent (buy-N-get-M), so it was faked with a dangerous
  approximation.
- **Lesson:** **Promotions apply to CUSTOMER orders only — and a pricing mechanic the engine
  cannot express will be misconfigured into one it can; build the real mechanic or block the
  config.**
- **Guard:** BUY_N_GET_M promotion type (#393); $0-exposure scan script.

### L-020 · 2026-07 · domain

- **Symptom:** invoices billed less than the agreed override price.
- **Root cause:** order→invoice conversion re-encoded a price override as
  `discount = originalPrice − unitPrice`, double-counting a discount already baked into the net
  `unitPrice`.
- **Lesson:** **A price override is net `unitPrice` + `originalPrice` (display) +
  `discount: 0` — `discount` is reserved for explicit operator discounts; never derive one from
  the other.**
- **Guard:** invoices spec "does NOT double-count a price override".

### L-071 · 2026-09-04 · domain · OCR gate

- **Symptom:** every invoice scan returned 403 for days; the web modal said "check the file and try again", so it read as a bad file, not a missing entitlement.
- **Root cause:** #475 put `@RequireAddon("ocr")` on live routes with no backfill and no plan bundling the add-on, and the web discarded the server's message.
- **Lesson:** **A new entitlement gate on an existing route is an outage unless it ships observe-first: register the key with a review date, allow-and-log until the backfill exists, fail closed only for unregistered keys, and always surface the server's message.**
- **Guard:** `ADDON_GATE_REGISTRY` pins P1a–P1h and REG-OCR-1 T1–T8; e2e OP-17g; the CLAUDE.md "Entitlement gates" rule and the PR-template line.

### L-095 · 2026-09-08 · domain · #668

- **Symptom:** the fix's first round wired the scan FAB's tap to the wrong prop (inert, compiled
  cleanly); round two found both handlers optional on shared `BarcodeFab` let `<BarcodeFab />`
  compile into a dead control across five existing mounts too.
- **Root cause:** mutually exclusive handlers (`onScanned` opens its own camera; `onPress`
  intercepts the tap for a caller with its own scan surface) were modelled as independent optional
  props, so neither being supplied still typechecked.
- **Lesson:** **Model mutually exclusive handlers on a shared component as a discriminated union
  (exactly one of `onScanned` / `onPress`), so a no-op mount is a TYPE error — pin it with a props
  test.**
- **Guard:** `barcode-fab-props.test.ts` (`tsc --noEmit`: rejects neither/both) + `BarcodeFab.tsx`'s
  discriminated-union `Props`.

### L-098 · 2026-09-08 · domain · #673

- **Symptom:** a keyboard user saw a fragmented purple focus ring and a wrapped arrow on the
  Sign-in menu items.
- **Root cause:** an interactive element containing several inline children (icon, label, glyph)
  was left `display: inline`, so `:focus-visible` painted once per line box and the trailing
  glyph wrapped.
- **Lesson:** **Any focusable element that holds more than one child is a flex/grid/block
  container with `white-space: nowrap` where the row must not break; the focus ring lives on the
  element, never on its children; pin the rule with a CSS-rule test, never a source-text grep.**
- **Guard:** the `signin-menu` assertions in `marketing-port.static.test.ts`.

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

### L-249 · 2026-09-30 · domain · a blank money cell may default; a present-but-unparseable one must reject the row (#2190)

- **Symptom:** an invoice import with a cell like `12abc` wrote a $0.00 invoice (or line) and reported
  success; `1e5` imported as 100000.
- **Root cause:** the invoice importer read money as `parseImportMoney(cell || "0") || 0`, so "absent"
  and "present but invalid" shared one path and the trailing `|| 0` turned NaN into $0. The
  products/customers importer already had the strict check; the invoice path kept a second, lenient
  parser (the L-167 second-copy shape).
- **Lesson:** **On a bulk/CSV money or quantity write, a blank cell may take its documented default, but
  a present-but-unparseable cell must skip the row or group with a reason BEFORE any write, never
  coerce with `|| 0` / `?? 0`; every importer reads money through the one strict parser
  (`parseStrictMoneyCell`).**
- **Guard:** `import-invoice-money-2190.spec.ts` (each money column, a later-line skip, overflow, blank
  defaults) and its `.db.spec.ts`; cf. [[L-167]].

### L-248 · 2026-09-29 · domain · one rounding body per precision; never inline a Math.round nudge (#2717, SA-574 H1)

- **Symptom:** an inlined `Math.round(n * 1e4) / 1e4` (or a `+ Number.EPSILON` nudge) rounds a
  half-at-the-last-decimal value DOWN, so the same number lands a unit apart on two paths (the
  REG-B122 class, now at 4 dp).
- **Root cause:** scaling by 1e4 puts the half-way case within EPSILON of a float boundary; a nudge
  cannot be right for every magnitude, and a second copy of the body drifts from the first.
- **Lesson:** **`round4` in `packages/pricing` is the only 4-decimal rounding body (and `roundMoney`
  the only cents body); every 4-dp value goes through it, never through a re-inlined expression.**
- **Guard:** `round4` (half away from zero via the decimal-string path) with `roundUnitCost` delegating
  to it; pinned by `golden.spec.ts` (ROUND4_FIXTURES) and `component-price.spec.ts`.

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

## security

### L-023 · 2026-07 · security

- **Symptom:** production login failed with "Invalid credentials" on correct passwords after a
  security pass.
- **Root cause:** the tenant-slug cookie was made `httpOnly`; the login page reads it via
  `document.cookie` to send `X-Tenant-Slug`, so tenant resolution fell back to a reserved host
  slug → null tenant → no user match.
- **Lesson:** **Before hardening any cookie/header/token, grep every consumer — a best practice
  applied against the architecture is an outage; prod-gated flags demand prod-mode
  verification.**
- **Guard:** non-httpOnly requirement documented at the cookie's writers/readers.

> archived 2026-09-06 for headroom — guard automated (registry-guards, making room for L-080).

### L-044 · 2026-09-02 · security

- **Symptom:** four fixes in one batch were "protected" by things that had never once done
  anything — a log-only APP_GUARD that read `req.user` before any route guard populated it (never
  fired), and a green unit test asserting a DRIVER _may_ write a price override (it asserted the
  bug).
- **Root cause:** a guard that always returns `true` and a test that always passes are
  indistinguishable from working ones; nobody had asked what would turn either red.
- **Lesson:** **Green is a claim, not evidence. Before inverting a requirement, grep the suites
  for a test that asserts the OLD behaviour (it passes on the bug — invert it, don't route around
  it); before trusting a side-effect-only guard or interceptor, name the input that makes it act
  and prove that input exists at that point in the pipeline (APP_GUARDs run before route guards,
  so `req.user` is never set there).**
- **Guard:** `REG-B132` (the inverted test) and `REG-B165` (`impersonation.guard.spec.ts` header
  case with `req.user` undefined); mutation probes in the F14 PR body.

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

## Archived 2026-09-04 — compaction before PR-4 + B′ landing

> Register hit its cap (40/40 entries, 40,917/40,960 B). Compacted to restore headroom before the
> next landings. Selection: aged (before 2026-08-15) with zero citations across
> `.claude/code-map`, `docs`, `CLAUDE.md`, `apps`, `scripts`; or guarded by a mechanical
> spec/script that has since merged and shipped, making the register entry no longer the only
> thing standing between a session and the mistake. Ids are unchanged and remain citable.

### L-008 · 2026-07 · process

- **Symptom:** production login broke after a commit titled as API-only security work.
- **Root cause:** a web-middleware change rode along in a commit scoped and reviewed as API-only.
- **Lesson:** **Never edit a layer outside the batch's stated scope — surface it and ask; a
  commit title must name every layer it touches.**
- **Guard:** none — judgment.

_Archived: aged (2026-07, before the 2026-08-15 cutoff), zero citations in code-map/docs/CLAUDE.md/apps/scripts._

### L-021 · 2026-08-12 · domain · #335

- **Symptom:** receiving a vendor bill 500'd (P2025) on real data despite green unit tests.
- **Root cause:** nested-created child rows carry NULL `tenantId` (nested writes bypass the
  tenant proxy's create-injection), so tenant-scoped child updates can never match them.
- **Lesson:** **In tenant-scoped services, write child rows THROUGH the parent's update — and
  audit any direct per-child write for the NULL-tenantId class.**
- **Guard:** single-helper pattern (`lineInventoryDelta`); class flagged for review.

_Archived: aged (2026-08-12, before the 2026-08-15 cutoff), zero citations in code-map/docs/CLAUDE.md/apps/scripts._

### L-052 · 2026-09-03 · process · PR-1 `imp-03a`

- **Symptom:** the documented boot-time DDL (`main.ts`) had an undocumented twin
  (`platform-config.service.ts` creating two tables and an index on every boot, ungated).
- **Root cause:** "retire the DDL" was scoped to the site the docs named, not to every raw-DDL
  call site.
- **Lesson:** Retiring a runtime schema writer means grepping every raw-execution shape —
  `$executeRaw*`, `$queryRaw*`, AND bare driver calls like `pool.query(…)` — across `src` and
  `scripts`, proving the live DB already matches the datamodel (`migrate diff --exit-code` → 0)
  before deleting, then deleting: a default-off flag leaves the contradiction in place.
- **Guard:** `apps/api/src/common/no-runtime-ddl.spec.ts` (static tripwire) + the drift gate in
  `db-migrations.yml` and `prod-migrate.mjs`.

_Archived: guarded by a merged mechanical check — `apps/api/src/common/no-runtime-ddl.spec.ts`
exists in the tree, plus the `db-migrations.yml` drift gate and `prod-migrate.mjs`._

### L-053 · 2026-09-03 · tooling · PR-1 `imp-03a`

- **Symptom:** every `local:*` npm script that set an env var failed on Windows with "'DATABASE_URL'
  is not recognized as an internal or external command", although a runbook said they were
  verified green that day.
- **Root cause:** npm runs package scripts through cmd.exe on Windows (no `script-shell`), and the
  scripts used POSIX `VAR=val sh -c '…'` prefixes; the "verified" claim came from a POSIX shell.
- **Lesson:** an npm script that must set environment is not cross-platform until the environment
  is set by a node shim (`scripts/local-env.mjs`) — never by a `VAR=val` prefix or `sh -c`; a
  runbook's "verified working" is true only for the shell it named.
- **Guard:** `apps/api/src/common/local-env-script.spec.ts` + the `local:*` scripts all routed
  through the shim.

_Archived: guarded by a merged mechanical check — `apps/api/src/common/local-env-script.spec.ts`
exists in the tree and the `local:*` scripts route through the shim._

### L-059 · 2026-09-03 · tooling · wave B′

- **Symptom:** the architecture review's Option B recommended Atlas for destructive-migration
  linting; planning around it would have shipped a tool that can't do the job.
- **Root cause:** Atlas's `migrate lint` went **Pro-only since v0.38**, and its `--dir-format`
  flag never supported Prisma's migrations layout to begin with — neither fact was checked against
  current docs before the recommendation was written down.
- **Lesson:** **A tool recommendation in a review is a claim — verify licensing and format support
  against current docs before planning around it.** (Atlas lint went Pro-only; its dir formats
  never included Prisma.)
- **Guard:** `docs/IMPROVEMENTS.md` item 3 now names Squawk (`squawk-cli`, free, Prisma-compatible)
  with the refuted Atlas facts inline; `scripts/lint-migrations.mjs` + `apps/api/.squawk.toml`
  ship the working substitute.

_Archived: guarded by a merged mechanical check — `scripts/lint-migrations.mjs` and
`apps/api/.squawk.toml` exist in the tree and ship the working substitute._

### L-032 · 2026-09-01 · tooling

- **Symptom:** forcing a transitive past a parent's exact pin failed twice, each time silently.
  First: adding the root `overrides` pin and regenerating with `--package-lock-only` left the
  hoisted entry on the OLD version — a no-op fix for a no-op fix. Then: deleting just that one lock
  entry and regenerating DID move it, and **broke every file upload in the process**, with no error
  anywhere — requests returned 201 and the file was simply absent.
- **Root cause:** two distinct properties of npm, both invisible in a green build. (1) An override
  applies only when npm **resolves** an edge; `--package-lock-only` keeps pre-existing subtrees that
  predate the pin. (2) Deleting a package's lock entry without its `node_modules/<pkg>/node_modules/*`
  children orphans them: the nested `type-is` survived, its nested `media-typer@0.3.0` did not, so
  `type-is` silently fell through to an incompatible root-hoisted `media-typer@1.1.0`, stopped
  recognising `multipart/form-data`, and multer skipped every request without complaint.
- **Lesson:** **Adding an override is not applying it, and pruning a lock entry prunes a subtree.
  Remove the WHOLE `node_modules/<pkg>(/…)*` family, run a real `npm install` (never
  `--package-lock-only`, which builds an ideal tree it never has to make work), then assert three
  things separately: the hoisted version moved, `validate-lock` reports `skew 0 new`, and the
  library still does its job.**
- **Guard:** `multer-field-limits.security.spec.ts` — it resolves multer from
  `@nestjs/platform-express`'s own directory and asserts >= 2.3.0, and it exercises a real
  multipart request end-to-end, which is what actually caught the orphan. `validate-lock` names the
  skew directly (`media-typer: found 1.1.0, wanted 0.3.0`), so it is a gate failure, not a mystery.

_Archived: guarded by a merged mechanical check — `multer-field-limits.security.spec.ts` exists in
the tree and exercises a real multipart request end-to-end._

### L-033 · 2026-09-01 · security

- **Symptom:** the version bump that "fixed" a High-severity DoS advisory left the vulnerability
  fully exploitable on every endpoint, even once the upgrade genuinely landed.
- **Root cause:** the upstream fix was a new **opt-in** option (`fieldArrayIndexLimit`), gated on
  `hasOwnProperty` and defaulting to `Infinity`. Nothing changed for a caller who upgraded and
  passed the same options as before. Two further layers had to be crossed before it worked at all:
  the framework's own closed `limits` type had no such key (a fresh object literal would not
  compile), and the framework's error mapper had never heard of the new error code, so the guard
  firing produced a 500 and a monitoring capture per request instead of a 400.
- **Lesson:** **Upgrading past a CVE is not mitigating it. Read the upstream fix and ask whether it
  is a new DEFAULT or a new OPTION — and if it is an option, trace it the whole way: does it
  typecheck, does the framework forward it, and what does the caller actually receive when it
  fires?**
- **Guard:** `multer-field-limits.security.spec.ts` asserts the rejection is a 400 end-to-end, and
  proves the guard is load-bearing by showing the same request succeeds without it.

_Archived: guarded by a merged mechanical check — same `multer-field-limits.security.spec.ts` as
L-032, which asserts the 400 rejection end-to-end._

### L-031 · 2026-09-01 · domain

- **Symptom:** a bug report (written from a review lens's own finding) named `deleteCustomer` as
  destroying invoices without reversing their regulated-ledger entries. Reading it on master, that
  site cannot destroy an invoice at all — its hard-delete path is only reached when the pre-flight
  counted ZERO invoices. Meanwhile two sibling paths in the same file, named nowhere in the report,
  destroy invoices freely: one blocks only PAID/SENT (so it deletes DRAFTs), the other has no
  invoice guard whatsoever.
- **Root cause:** the finding was recorded by pattern-match — "invoice.deleteMany with no ledger
  call nearby" — without evaluating the guard that decides whether the block is reachable. The
  pattern was real; the location was wrong, and the two worse instances were missed because they
  did not match the grep as cleanly.
- **Lesson:** **A reported location is a hypothesis, not a finding. Before fixing, re-derive which
  call sites can actually REACH the bad state, and sweep the whole file for siblings — the
  reachable ones are often not the reported one.** Fixing the reported site alone would have
  shipped a green test over an untouched leak.
- **Guard:** `customers.purge-ledger.spec.ts` covers all three sites and pins the reversal-before-
  delete ordering. Second-order fact worth keeping: **a DRAFT invoice already carries ledger rows**
  (`createSplitInvoices` writes them in the transaction that creates the DRAFT), so "we only delete
  drafts" never justifies skipping the reversal. Same family as [[L-029]].

_Archived: guarded by a merged mechanical check — `customers.purge-ledger.spec.ts` exists in the
tree and covers all three sites with the reversal-before-delete ordering pinned._

## Archived 2026-09-04 — guard in place, cap discipline (#597)

### L-029 · 2026-09-01 · domain · #588

- **Symptom:** cancelling an order destroyed value three ways at once — it voided the invoice for
  goods already delivered, never returned the creation-time stock decrement, and its sibling
  `deleteOrder` skipped the regulated-ledger reversal both other invoice-destruction paths
  performed. All three had shipped green.
- **Root cause:** the conservation rules were built for the **edit** path and the **teardown**
  paths were simply never enrolled in them. Every signal each fix needed already sat in the same
  file — the delivered-qty clamp, the reversal call — and was not consulted. Nothing failed
  loudly, because a conservation law has no natural test: stock is only wrong much later, and
  nowhere near the cancel that caused it.
- **Lesson:** **When a codebase establishes an invariant on one path, enumerate every OTHER path
  that reaches the same state and enroll it explicitly — an invariant with a known exception is a
  bug with a scheduled date.** Search by the STATE being mutated (who else deletes an invoice, who
  else writes `order.status`), never by the feature name: the violating paths are the ones that
  never mention it.
- **Guard:** `orders.lifecycle-conservation.spec.ts` + its pins spec, 9 mutation probes. The same
  search immediately found two more instances, recorded not fixed: `routes.service.ts` has **five**
  `order.status` writers and only one runs the invoicing side effects (→ F11), and the customer
  purge is a **fourth** `reverseInvoiceEntries`-skipped hard delete — at four instances the answer
  is a shared guard, not a fourth point-fix. See [[L-008]] for why they stayed out of scope.

## Archived 2026-09-05 — cap discipline on the F25 merge (post-#612)

Merging `fix/F25-calendar-date-correctness` (L-047) onto master's register — already at 40 of
40 entries and 40,478 of 40,960 bytes — put the active file over BOTH caps. Two entries moved
here verbatim: L-036, whose guard (`REG-B72 (T22)`) is landed and turns red when disabled, and
L-028, whose rule now lives at its call site in `.claude/code-map/api.md` beside the root
`overrides` pin it argues for. Two rather than one so the register lands with real headroom —
[[L-039]]: a cap reached with ~0 margin is a tripwire for the next unrelated branch.

### L-036 · 2026-09-01 · testing · #TBD

- **Symptom:** a transition deny-list whose every (from,to) pair was verified correct — by unit
  assertions AND by adversarial refuters — was defeated by two individually-legal PATCHes:
  `COMPLETED → IN_PROGRESS` (a documented allowance) then `IN_PROGRESS → SCHEDULED` (never
  denied) re-scheduled a completed run, the exact state the matrix's contract forbids.
- **Root cause:** the matrix is EDGE-wise, and so was every oracle pointed at it. Verifying each
  edge in isolation is structurally incapable of finding a composite path; no amount of care
  inside the matrix would have caught it.
- **Lesson:** **When the artefact under test is a state machine, the oracle must walk PATHS, not
  edges.** Ask which multi-step sequences compose into a forbidden state, and guard on durable
  evidence outside the transition (here `completedAt`, which the endpoint only ever sets) rather
  than on the current status.
- **Guard:** `REG-B72 (T22)` walks the two-step path and pins that a never-completed run still
  schedules normally; disabling the guard turns it red.

### L-028 · 2026-09-01 · tooling

- **Symptom:** a grouped dependency bump advertised a security update for a file-upload library. The
  PR title, changelog and lockfile diff all showed the new version — and every upload path kept
  running the old one, advisories intact.
- **Root cause:** a framework package declared that library at an **exact** version, so the hoisted
  copy stayed pinned there; the bump installed the new version only nested under one workspace,
  which nothing imports from. A version appearing in the lockfile says it was installed, never that
  it is what resolves at a call site.
- **Lesson:** **A dependency bump is proven by what RESOLVES at the call sites, not by the lockfile
  diff — for any security bump, check whether a parent's exact pin holds the hoisted copy, or the
  merge closes the ticket without closing the hole.**
- **Guard:** none yet — inspect the hoisted entry (and any parent's exact pin) before believing a
  security bump. The check that settles it is the **resolution**, which holds whatever the install
  state is:
  `node -e "console.log(require.resolve('<lib>',{paths:[require('path').dirname(require.resolve('<parent>/package.json'))]}))"`.
  ⚠️ A version string read out of `node_modules` is **not** independent confirmation: a tree that
  predates the bump's install reads the old version for the trivial reason that nothing installed
  the new one. Both this entry's author and its first reader made exactly that substitution within
  hours of filing it — **having written a rule makes you quicker, not slower, to accept a reading
  that confirms it.** Note the fix for this class is a root `overrides` pin, which [[L-012]]
  otherwise forbids: `overrides` is the only mechanism that beats a parent's exact pin on a
  **runtime** transitive, so state the exception in the PR or the next reader reverts it as a
  violation.

## Archived 2026-09-05 — cap discipline on the wave E rebase (post-#618)

> Moved verbatim to hold BOTH caps when wave E (`fix/imp-wave-e-structure`) rebased onto
> master `8f136b9a`: master stood at 39 entries / 38,945 B and wave E contributes two, which
> broke the 40-entry cap and left ~223 B of headroom. Two rather than the one strictly
> required, per [[L-039]]: a cap reached with ~0 margin is a tripwire for the next branch.
> Both are the OLDEST entries whose guard has landed, and neither is cited by any `[[L-0xx]]`.

### L-016 · 2026-08-29 · deploy · #475

- **Symptom:** (caught pre-merge) four endpoints would have 403'd for every tenant on deploy day.
- **Root cause:** a server-side `@RequireAddon` gate keyed on an addon that no shipped UI or SKU
  activation could grant.
- **Lesson:** **An entitlement gate with no way to GRANT it is a self-inflicted outage — for
  every new gate: which UI grants it, does activation write THAT key, what happens to existing
  users on deploy day?**
- **Guard:** gate checklist in feature-plan P4; legacy-key → SKU bridge.

### L-024 · 2026-09-01 · security

- **Symptom:** the obvious plan — restrict the one Maps key to the Android app — would have taken
  down server geocoding, address autocomplete and every browser map at once.
- **Root cause:** one key served three call origins (Android app, Railway server, browser), and a
  cloud API key accepts exactly **one** application-restriction type. The key had to stay
  unrestricted because the API deliberately re-serves it to browsers at runtime.
- **Lesson:** **One credential per call origin. Before restricting any shared key, enumerate who
  calls it and from where — a key with both a server and a browser origin can carry no application
  restriction at all until the callers are split.**
- **Guard:** three-key model recorded in memory `project_maps_key_architecture_2026-09-01`;
  `docs/plans/maps-key-split-note.md` is STALE and must not be followed verbatim.

## Archived 2026-09-05 — headroom for L-071 (fix/e2e-spec-locators-and-seed-target)

The register sat at 40 of 40 entries after L-071 landed. Of the entries still active, L-030 is
the oldest (by introducing commit, `7dcf390c`, 2026-09-01T14:29:49 — ahead of every other
domain/process/tooling entry still in `LESSONS.md`, most of which carry "Guard: none —
judgment") whose guard is a real, landed, automated check rather than a procedure or a memory
note: `REG-B64 (T7)` and mutation probe 3 live in `apps/api/src/orders/orders.lifecycle-
conservation.spec.ts` (confirmed present in the tree) and run on every `npm run test`/CI pass —
not a checklist, doc pointer, or "Guard: none". It also sits beside the already-archived L-029
(same guard file, the complementary conservation invariant for the same #588 batch), so this
keeps the two together. One entry archived, per [[L-039]]: land with real headroom, not at the
cap.

### L-030 · 2026-09-01 · domain · #588

- **Symptom:** the fix for the above introduced a NEW conservation bug. A DRAFT cancel correctly
  credited no stock (a draft never decremented) but still marked its line items CANCELLED, and
  `reopenOrder` re-decremented every marked line — so a draft's cancel→reopen round trip
  understated stock by the full order quantity.
- **Root cause:** the marker recording "this cancel gave stock back" was written unconditionally
  while the give-back itself was conditional. Two halves of one decision, written as two
  independent statements that happened to agree in the common case.
- **Lesson:** **When one write is the RECORD of another write having happened, bind both to a
  single named condition — not to two conditions that agree today.** A reader (and a reviewer) can
  check one boolean; they cannot check that two predicates are equivalent in every state.
- **Guard:** `REG-B64 (T7)` asserts a DRAFT cancel neither credits stock nor marks its lines;
  mutation probe 3 (make the mark unconditional) turns it red.

## Archived 2026-09-05 — cap discipline on the imp-02b rebase (post-#622)

> Moved verbatim to hold the 40-entry cap when `feat/imp-02b-cron-leader-lock` rebased onto
> master `b1e3bed0` (#622 e2e spec locators + seed target): master's register was already FULL
> at 40 entries and 2b contributes one (**L-075**), so the union is 41. **TWO** entries leave
> rather than one, per [[L-039]] — land with real headroom, not at the cap — because the
> previous landing left only 386 B of it.
>
> **L-013** is the OLDEST active entry by two weeks, is cited by no `[[L-0xx]]` and appears
> nowhere in `.claude/`, `docs/`, `CLAUDE.md`, `apps/` or `packages/` outside its own
> heading, and both halves of its rule now have a landed home: the registry-flake half is
> mechanised by `scripts/ci-audit-critical.mjs` (the advisory gate warns-and-skips on registry
> unavailability rather than failing — recorded in `CLAUDE.md`), and the 0-step-red half is
> recorded in memory `project_killed_sessions_recovery_2026-08-30`.
>
> **L-040** is the next-oldest entry that NO file cites — `git grep -n "L-040"` over the whole
> tree returns only its own heading — and the artifact it was written about is gone: the
> hand-maintained HTML mirror was replaced by the in-repo `.claude/campaign/bugs/B###.md`
> records (#597, 212 files), which `scripts/campaign/bugs.mjs sync` derives from the machine
> ledger and which `npm run verify` checks through `bugs self-test` + `campaign-check.mjs`.
> Its family rule survives in the active register: L-040 named [[L-034]] (a generated artifact
> is evidence only when you can name the tool and the run that produced it), which stays.
>
> Every entry older than L-040 that is NOT archived here is cited somewhere and therefore stays:
> L-004 (imp-08 flip-reconcile brief), L-010 and L-038 (the imp-01 pipeline build-plan and
> discovery), L-011 (13 references), L-027 (5).

### L-013 · 2026-08-17 · tooling

- **Symptom:** three of four CI jobs red on a dependency error the change never introduced.
- **Root cause:** the failure was at the _install_ step (registry flake), not the job's own
  command; separately, 0-step ~3 s "failures" while private are Actions billing, not the suite.
- **Lesson:** **Read which step failed before hunting a code fix — an install-step or 0-step red
  proves nothing about the change; rerun first.**
- **Guard:** none — judgment.

### L-040 · 2026-09-01 · process

- **Symptom:** three ledgers for one campaign, three answers — machine ledger 61 rows shipped,
  hand-maintained HTML register 7 of those still open (one a Critical), prose summary 48.
- **Root cause:** only the machine ledger is written by tooling and read by a gate. The mirror is
  updated by hand at batch close-out — one batch did it, the next did not, and nothing compares
  the two.
- **Lesson:** **A status mirror that no gate checks is not a second source, it is a slower copy —
  derive every count from the machine ledger instead of quoting a summary.** The drift has a
  direction: it runs toward MORE open work, and nobody audits a number saying there is more left
  to do, so the error survives every review.
- **Guard:** none — `campaign-check` reads the ledger, the mirror has no equivalent. Count from
  `.claude/campaign/status/*.jsonl` (last state per row id) before repeating any figure. Same
  family as [[L-034]].

## Archived 2026-09-05 — headroom for L-076 (fix/e2e-recurring-toast-locator)

The register sat at 40 of 40 active entries; adding L-076 (testing, the toast/aria-live
strict-mode fix) would have pushed it to 41. Of the entries still active, L-037 is the oldest
whose guard is a real, landed, automated check rather than a procedure or a memory note: every
2026-08-* entry and every 2026-09-01 entry with a lower id (`L-025`, `L-026`, `L-027`, `L-035`)
carries "Guard: none" or "none — judgment". L-037's `REG-B55 (T21)` is a landed regression test
(F11 close-out, confirmed present in the tree) that runs on every `npm run test`/CI pass — not a
checklist, doc pointer, or "Guard: none". One entry archived, per [[L-039]]: land with real
headroom on the byte cap, not at it.

### L-037 · 2026-09-01 · domain · #TBD

- **Symptom:** the fix for a reopen that wrongly credited stock still left the reopen billing the
  delivery it had just undone — `OrderItem.deliveredQty` survived the reversal, and the
  delivered-basis invoice reconcile bills exactly that field.
- **Root cause:** the reversal was corrected for the field the bug report named and no other. The
  forward path wrote `deliveredQty` unconditionally (whether or not money changed hands) while the
  reversal reset only `status`.
- **Lesson:** **A reversal must enumerate every field the forward operation wrote, not just the
  one the bug report named** — and state, per write, whether it is undone by REVERSAL or covered
  by REFUSAL (blocking the operation while that state stands). Those are different strategies and
  the mix must be deliberate. ⚠️ Note the coupling: the new refusal guard is what made the
  reversal gap REACHABLE, so a fix can open the path to a latent bug.
- **Guard:** `REG-B55 (T21)`; the write-by-write enumeration is recorded in F11's fix card so the
  next batch on this path starts from it rather than rebuilding it.

## Archived 2026-09-05 — headroom for L-077/L-078 (fix/imp-closeout-review)

This branch planned a two-entry block — **L-037** and **L-039** — chosen oldest-first among
entries whose guard is a landed automated check rather than a procedure, and which nothing
outside a frozen `.claude/pipeline/` run record still cites. Merging master `d12203a3`
(#624, #625) showed L-037 already archived directly above, by #625, on exactly that reasoning,
so only **L-039** (tooling, 2026-09-01 — `validate-lessons` now prints `binding:` and the
remaining headroom on every run, which is the whole of what the entry asks a reader to
remember) moves here. Program entries (`imp-*`/wave) and L-074 were excluded by rule. Ids stay
retired: the `[[L-039]]` references already in this file still resolve. The register lands at
40 of 40 entries and 38.8 of 40.0 KB — at the entry cap, so the next branch to append must
archive first ([[L-039]]'s own rule about landing with headroom).

### L-039 · 2026-09-01 · tooling

- **Symptom:** a green PR went red after a routine rebase, on a check unrelated to its contents —
  and its author could not fix it: the failing number is a policy threshold only the owner may set.
- **Root cause:** the gate shipped while the repo sat **71 bytes** under the cap it enforces.
  Correct gate, zero margin — so the next branch to append to the capped file inherits a failure it
  did not cause, and appending is exactly what the rules REQUIRE after a fix.
- **Lesson:** **Land a gate only with headroom, and only when its threshold is a number you are
  authorized to set.** At zero margin a gate is a tripwire for the next unrelated PR, not a guard;
  if the threshold is an owner's call, land the ruling with it or the gate blocks the project on a
  decision nobody scheduled.
- **Guard:** `validate-lessons` prints `binding:` and the remaining headroom every run — treat
  `~0 more` as unlanded work. Second-order cost: the run died at the gate, so everything its
  success path owned went undone and the repo was left **public** — a private flip that lives
  after a green CI is not a `finally`.

## Archived 2026-09-06 — headroom for L-079 (#627 bookkeeping follow-up)

Landing L-079 (tooling — a cold ts-jest worker's first-test init trips the api workspace's
unset 5 s Jest default) at 40 of 40 active entries required archiving first. **L-011** was the
oldest tooling entry whose guard is now a landed automated check rather than judgment: stale
Prisma clients after a schema pull are caught by CI's `check-types`/build step and the
project's later `postinstall` generate step, not by memory alone. L-010 ("Turbo lies both
ways") was kept — it is still cited from project memory.

### L-011 · 2026-08-25 · tooling

- **Symptom:** phantom `X does not exist in type` errors on correct code; pre-push blocked.
- **Root cause:** the generated Prisma client was stale after pulling a schema change — and
  `npx prisma generate` writes to the **shared root** `node_modules`, so parallel worktrees
  clobber each other's client.
- **Lesson:** **Regenerate the Prisma client after any pull/checkout/rebase across a schema
  change, and expect all worktrees to share one generated client.**
- **Guard:** none — judgment.

## Archived 2026-09-06 — headroom for L-081 (F09 P8 bookkeeping follow-up)

Landing L-081 (domain — gate a money write inside the primitive that performs it, never at one
call site's query) at 40 of 40 active entries required archiving first. **L-045** was the oldest
domain entry whose guard names landed automated regression tests (REG-B129/REG-B211 in the F11
suite) rather than judgment/none/runbook.

### L-045 · 2026-09-02 · domain · #TBD

- **Symptom:** every cancelled run, and every run completed with a skipped stop, left its
  undelivered orders pinned to a stale `routeRunStopId` — invisible to the dispatch sweep and the
  trip builder (both require the pointer null), while the buyer card kept showing a driver and
  "you're next" for a called-off run.
- **Root cause:** the pointer was set by one path (dispatch) and every re-entry reader keyed on it
  being null, but neither terminal transition ever cleared it. The invariant had a writer and its
  readers, and no releaser — same shape as [[L-029]]'s teardown paths.
- **Lesson:** **A pointer that gates re-entry must be released by every transition that makes the
  pointed-at thing terminal, inside that transition's own transaction — and the release predicate
  must be the durable marker the forward path writes (here `stop.status = COMPLETED`), never the
  existence of a side row a payment-only path skips.** When the release makes a new state pair
  reachable (a SKIPPED stop on a COMPLETED run), ship the refusal for it in the same PR ([[L-030]]).
- **Guard:** `REG-B129 (T5 path: cancel → un-cancel → re-dispatch)`, `REG-B211 (T12 path:
complete-with-skipped → reopen refused)`; mutation probes in the F11 PR body.

## Archived 2026-09-06 — headroom for L-084 (F18 bookkeeping follow-up, #643)

Landing L-084 (process — a fix that first arms/consumes/clears a persisted state field must grep
every writer and reader of that field into the build radius before the plan is cut) at 40 of 40
active entries (40,591 B) required archiving first — adding the new entry without archiving would
have pushed the file past the 40,960-byte cap. Both entries below have zero live citations
anywhere in the tree outside `.claude/pipeline/` frozen run records (checked via `git grep`,
excluding `.claude/lessons/*.md` and `.claude/pipeline/**`) and are guarded by a landed, automated
mechanical check rather than a procedure, a runbook pointer, or "Guard: none — judgment": **L-056**
(`scripts/ci-audit-critical.mjs` + its contract spec) and **L-064** (`apps/web/csp.mjs` +
`apps/web/lib/csp.test.ts`'s prod-identity pin). Both are dated 2026-09-04; L-056 was minted first
(lower id). Note the task brief for this follow-up named the new entry L-083, but master already
carried an unrelated L-083 (`campaign-check freshness`, landed earlier the same day) and
`_meta.json.nextId` was already `84` before this session started — the new entry is filed as the
actually-free L-084 instead.

### L-056 · 2026-09-04 · tooling · #609

- **Symptom:** the `Fail on critical production advisories` CI step (`npm audit --omit=dev
--audit-level=critical`) blew its 20-minute `timeout-minutes` twice in one day, 8 minutes
  apart; the non-blocking high-severity step hit the same failure masked by `|| true`.
- **Root cause:** npm's registry started returning 500 on the quick-audit endpoint ("This
  endpoint is being retired. Use the bulk advisory endpoint instead."), and npm's own client
  retries internally for ~12 minutes before giving up — the gate had no way to tell an upstream
  outage apart from a real finding.
- **Lesson:** a CI gate that depends on a third-party service must distinguish a finding from an
  outage: fail on findings, warn-and-skip on unavailability with a bounded retry — otherwise an
  upstream deprecation blocks every merge.
- **Guard:** `scripts/ci-audit-critical.mjs` (bounded 3-attempt retry, registry/transport-error
  detection, `::warning::…SKIPPED` + exit 0 on outage, fail-closed otherwise); contract spec
  `apps/api/src/common/ci-audit-script.spec.ts`.

### L-064 · 2026-09-04 · deploy · imp-04

- **Symptom:** the local E2E lane's browser login against the Docker-built web image was
  CSP-blocked with no HTTP response at all (`POST http://localhost:3000/api/v1/auth/login`
  from `http://localhost:3001`, `status -1`); the login page's no-response fallback rendered
  it as "Invalid username or password" even though API, CORS, seed, and throttle were all fine.
- **Root cause:** `next.config.mjs`'s CSP gated the `connect-src` localhost relaxation on
  `isDev = NODE_ENV !== "production"`, which is always `false` in a **built** image — `next
build` forces production — so that branch was dead in every Docker image, not just prod.
- **Lesson:** **never gate a build-time artifact (a CSP header, a routes manifest) on
  `NODE_ENV` — every built image reports `production` regardless of its actual deployment
  target. Derive the decision from the build input it must actually match instead** (here,
  whether the baked `NEXT_PUBLIC_API_URL` itself is `http:`), and pin the production output
  byte-identical in a spec so the fix can't silently change what ships.
- **Guard:** `apps/web/csp.mjs` (`apiConnectSources`) + `apps/web/lib/csp.test.ts` (prod-identity
  case pins the exact production `Content-Security-Policy` string).

## Archived 2026-09-06 — headroom for L-083 (campaign-check freshness)

Landing L-083 (tooling — campaign-check must refuse a stale run artifact by name, with the regen
command, before scanning a single token) at 40 of 40 active entries required archiving first.
Both entries below archived 2026-09-06 for headroom (L-083 added; register at its byte cap) —
guard automated: **L-065** (tooling) is the oldest active entry whose Guard names a landed
automated spec (`no-runtime-workspace-imports.spec.ts`) rather than judgment/none/runbook; the
next-oldest by that rule, L-072, stays active because `CLAUDE.md`'s Conventions cite it inline by
id, so **L-046** (domain), the following qualifying entry, is archived instead.

### L-065 · 2026-09-03 · tooling · PR-4 `imp-01`

- **Symptom:** the review counted "four copies", the first plan promised a source-direct package
  "exactly like `@routeflow/types`", and the repo's own comments already said that shape crashes
  `node dist/main.js`.
- **Lesson:** a workspace package the API imports at runtime must ship compiled JS — `nest build`
  emits `require()` verbatim; source-direct packages are a client-only convenience. Build it on
  `postinstall` so every `npm ci` (CI, Docker, dev) produces `dist` before anything typechecks.
- **Guard:** `no-runtime-workspace-imports.spec.ts` (PR-1's engine already seeded the idea; this PR
  makes it assert every `@routeflow/*` the API imports has a built `main`).

### L-046 · 2026-09-04 · domain · F13

- **Symptom:** a MONTHLY recurring invoice never advanced; a standing order billed list price; a failed cycle was silently skipped; a failed cycle's unconditional rollback could hand the schedule back for a cycle another run had already billed.
- **Root cause:** a month-advance compared against a mutated date; a second writer priced lines outside the one buyer resolver; the cron advanced the schedule before it knew the outcome and never recorded it; the restore after failure was not conditioned on the claim that made it.
- **Lesson:** **Every path that materialises an order or invoice from a saved shape is a pricing writer and a schedule writer: price through the shared resolver, record the outcome on the row you advanced, and undo a claim only by compare-and-set on the value the claim wrote — a miss means someone newer owns the row, so write nothing.**
- **Guard:** REG-B48 T9–T16 through the real resolver; REG-B46 T1–T7b; REG-B106 T17/T17b/T17c/T18/T19 ([[L-030]]: a write and its record share one condition; [[L-045]]: release on the forward-path marker).

## Archived 2026-09-07 — headroom for L-086 (fix/e2e-29-oracles, #647)

### L-058 · 2026-09-04 · testing · REG-E2EGUARD-403

- **Symptom:** the deploy-triggered E2E job reported success for days with every test step
  skipped.
- **Root cause:** the freshness guard's `latest=$(gh api … --jq '.[0].sha' 2>/dev/null || true)`
  treated a 403 error body as the newest sha — non-empty, so the emptiness check never fired — and
  the run token never had `deployments:read` (it worked only while the repo was public).
- **Lesson:** **A guard that skips work must decide on the command's exit status and the payload's
  shape, never on string emptiness, and must fail OPEN; declare every permission a job's API call
  needs at job level.** A job whose steps are all skipped is not a passing run ([[L-041]]).
- **Guard:** `ci-freshness-guard-script.spec.ts` T1 executes the workflow's own step under a fake
  `gh`.

## Archived 2026-09-07 — headroom for L-087 (docs/650-f23-bookkeeping, #650 follow-up)

### L-075 · 2026-09-04 · deploy · PR-2b `imp-02b-cron-leader-lock`

- **Symptom:** a leader lock held for a whole cron tick sits on a SOCKET-IDLE connection for
  minutes — the tick's own work runs on a different pool.
- **Root cause:** an advisory lock lives with the SESSION, and an idle TCP session can be reaped
  anywhere on the path (NAT, LB, platform network). The reap ends the session, Postgres releases
  the lock, and a rival replica wins an election for a job still running.
- **Lesson:** **any connection pinned for a long-held lock needs TCP keepalive, and a lock whose
  loss allows a duplicate money run must be sized and monitored as a SESSION, not a statement** —
  pool `max` covers its family's concurrent HOLDERS, not its call rate.
- **Guard:** `db-locks.spec.ts` (p) pins `keepAlive: true` / `keepAliveInitialDelayMillis: 30_000`
  on both lock pools, and their per-family `max`.

## Archived 2026-09-07 — headroom for L-088 (docs/652-f12-bookkeeping, #652 follow-up)

### L-079 · 2026-09-06 · tooling · #627 `chore/ci-private-minutes`

- **Symptom:** three unrelated api specs refused pre-push verifies on 2026-09-05/06 with
  "Exceeded timeout of 5000 ms" (upload-routes.security, visibility-watchdog-script,
  import-customer-cap) — each green standalone (import-customer-cap: 4/4 in 49 s cold, 6.7 s
  warm); two Run B pushes and one CI-branch push lost ~35 min.
- **Root cause:** Jest's default `testTimeout` of 5 s was never set for the api workspace; a cold
  ts-jest worker charges module/Nest-testing-module init to the first test, and beside a parallel
  verify, an engine run, or a Docker build that first test exceeds 5 s. Per-spec budgets fixed one
  site at a time (whack-a-mole).
- **Lesson:** **a flake class needs a class-level fix — set the per-workspace Jest `testTimeout`
  (≥ 30 s; the `.db.spec` lane already ran at 30 s) instead of hardening specs one by one; keep
  explicit larger budgets only where a test legitimately does long I/O (multipart round-trips
  60 s).**
- **Guard:** `apps/api/package.json` jest `testTimeout: 30000` (#627, master `0ee2672e`);
  watchdog spec's "rejects promptly" bound 15 s; `upload-routes.security.spec.ts` 60 s.
  Regression signal: any "Exceeded timeout of 5000 ms" in an api spec again means the config was
  dropped.

## Archived 2026-09-07 — headroom for L-089 (docs/656-f16-bookkeeping, #656 follow-up)

### L-080 · 2026-09-06 · process · registry-guards

- **Symptom:** three PRs (#612/#617/#618) landed bug-ledger rows while the per-bug records still
  said `queued`; every other worktree's Stop-hook Gate 4 then rewrote nine records on its next turn,
  and a triage id filed without `--batch` (B213) could not be moved into a batch under its own id.
- **Root cause:** the record front matter is a mirror DERIVED from the ledger by `sync`, yet nothing
  refused a push whose ledger edit skipped `sync`; and `move` only knew how to re-home an existing
  shard row, so an id with no row had to be re-filed under a new number.
- **Lesson:** **a committed derived file needs a read-only `--check` of its own derivation that the
  pre-push gate runs on the real tree; a state machine that mints ids must be able to give any
  catalogued id its FIRST row, not only move an existing one.**
- **Guard:** `sync --check` (T13/T13b) and `move --tier` (T14) in `scripts/campaign/bugs.mjs`
  `self-test`, which `npm run verify` runs before every push.

## Archived 2026-09-07 — headroom for L-090 (docs/f16-hotfix-followup, #659 follow-up)

Two-entry block, chosen oldest-first among active entries whose guard names a landed automated
artifact rather than a bare procedure, and which nothing outside `.claude/pipeline/**`,
`.claude/lessons/**`, or `code-map/CHANGELOG.md` still cites (grep-confirmed against the whole
repo, not just the code map). Every candidate dated 2026-08-24 through 2026-09-06 ahead of these
two was excluded: L-004/L-010/L-025/L-026/L-027/L-035/L-038/L-041/L-050/L-051/L-060 carry no
landed automated-artifact guard (`none — judgment` or a bare manual procedure); L-047, L-055,
L-062, L-066, L-068, L-069, L-070, L-074, L-076, L-078, L-081 are each still named in
`code-map/api.md`, `code-map/web.md`, `code-map/INDEX.md`, `HANDOFF.md`,
`docs/adr/0003-bugflow-github-native-bug-tracking.md`, `tools/bugflow/docs/*`, or a live bug
record under `.claude/campaign/bugs/` — none of which are allowed citation sites for this rule;
L-063 is cited directly from `scripts/campaign-check.mjs`, `scripts/jest-campaign-reporter.cjs`
and `apps/api/src/common/campaign-check-freshness.spec.ts`; L-082 and L-083 are cited from
`code-map/INDEX.md` (L-083 additionally from `code-map/api.md` and
`.claude/skills/bug-registry/SKILL.md`). **L-084** and **L-085** (both 2026-09-06 — the register
otherwise stalls on that one day) are the two oldest survivors: every citation of either id
anywhere in the repo resolves to `code-map/CHANGELOG.md` (allowed) or another
`.claude/pipeline/**` run record (allowed). Register: 39/40 entries, 39.3/40.0 KB after this pass.

### L-084 · 2026-09-06 · process · F18

- **Symptom:** F18's engine ended with every gate green and 3/3 probes caught, yet its final pass
  found 12 live defects in files outside the build radius — platform-admin plan writers, Stripe
  subscription webhooks, the period-end cron, alias and custom-plan paths — after the engine's
  round cap had already stopped it.
- **Root cause:** the fix was the FIRST product caller to arm a dormant persisted state (the
  downgrade markers), which turned every other writer's and consumer's latent weakness into a
  live defect; the radius was seeded from the build plan's file list, so those files were never
  in scope until the final pass, and the pass's ordered reads could not feed a fix round.
- **Lesson:** **when a fix arms, first-consumes, or first-clears a persisted state field, `git
grep` every writer and reader of that field before the build plan is cut and put them in the
  radius; treat the final pass's "reads worth their cost" as a fix round's input, never as the
  run's end.**
- **Guard:** bug-pipeline S5 checklist line ("state fields this fix arms → grep writers/readers →
  radius"); knob candidate recorded in RUN-LOG 2026-09-06 (ledger evidence required before the
  engine changes).

### L-085 · 2026-09-06 · process · F08

- **Symptom:** F08's engine stalled 90 minutes inside its fix wave — one executor's `Edit` tool
  call never returned, the parallel barrier waited on it, `TaskStop` marked the run killed but its
  loop never released, and `resumeFromRunId` was refused three times; separately, an executor's
  line-number probe (`sed -i 'Nd'`) on `returns.service.ts` raced another executor editing the
  same file and deleted a different line.
- **Root cause:** a hung in-process tool call holds a workflow barrier that no stop or resume can
  clear; and a line-number probe assumes a file nobody else is editing.
- **Lesson:** **when an engine run stalls (journal silent, no processes in its worktree, an
  agent's last entry is a tool call with no result), do not wait or resume it — stop it and
  continue by a NEW lead-designed light loop from the tree as it stands (integrity check first,
  then the owed work); and an executor/probe must never mutate a shared file by line number —
  revert by checksum against a backup only.**
- **Guard:** bug-pipeline RESUME cards carry the stall recipe; the engine's probe stage forbids
  line-number mutations (knob candidate recorded in RUN-LOG 2026-09-07).

## Archived 2026-09-08 — headroom for L-093 (docs/665-distributors-bookkeeping, #665 follow-up)

Oldest active entry whose guard names a landed automated artifact rather than a bare procedure,
and which nothing outside `.claude/pipeline/**`, `.claude/lessons/**`, or `code-map/CHANGELOG.md`
still cites (grep-confirmed against the whole repo, same rule as the L-090 headroom note above).
Re-ran the full elimination fresh rather than trusting the L-090-era list, since citations
accumulate between sessions: L-004/L-010/L-025/L-026/L-027/L-034/L-035/L-038/L-041/L-050/L-051
carry no landed automated-artifact guard (`none — judgment` or a bare manual procedure — L-034's
own "force execution, assert mtime" ritual is still cited as live, general guidance in
`tools/bugflow/docs/MIGRATION.md`/`DEVELOPMENT.md` and inline in `scripts/campaign-check.mjs`/
`scripts/jest-campaign-reporter.cjs`, so it is not even a "superseded by L-083" case despite the
overlapping root cause). L-047/L-055/L-057/L-060/L-061/L-062/L-063/L-066/L-067/L-068/L-069/L-071/
L-072/L-073/L-074/L-076/L-077/L-078/L-081/L-082/L-083/L-090/L-091 are each still named — by id —
in `code-map/api.md`, `code-map/web.md`, `code-map/INDEX.md`, `CLAUDE.md`, `HANDOFF.md`,
`docs/adr/0003-bugflow-github-native-bug-tracking.md`, `tools/bugflow/docs/*`, a live
`.claude/campaign/bugs/*.md` record, or app source (`apps/api/src/prisma/*`,
`apps/api/src/invoices/*`, `apps/api/src/billing/*`, `apps/web/lib/api/*`,
`apps/web/app/**/page.tsx`, `apps/web/e2e/*.spec.ts`, `.github/workflows/db-migrations.yml`,
`scripts/campaign/bugs.mjs`, `scripts/campaign-check.mjs`, `scripts/jest-campaign-reporter.cjs`)
— none of which are allowed citation sites for this rule. **L-087** (2026-09-07) is the oldest
survivor: every citation of its id anywhere in the repo resolves to `code-map/CHANGELOG.md`
(allowed) or `.claude/lessons/**` itself. L-088/L-089 (both 2026-09-07) are the next-oldest
equally-clean survivors, left active as the closer headroom margin for a future single-entry
archive.

### L-087 · 2026-09-07 · testing · #650

- **Symptom:** a passing "leaves INTERNAL untouched" assertion in a new NO_TRANSPORT test proved
  nothing — every INTERNAL event is already NO_TRIGGER, so the `channel !== INTERNAL` exemption
  was unreachable and it passed on precedence alone (reviewer's mutation probe).
- **Root cause:** written from the design's intent (INTERNAL is exempt), not the tree's current
  state (every INTERNAL event is already NO_TRIGGER, so the exemption line never runs).
- **Lesson:** **pin the CURRENT state behaviourally — every INTERNAL cell under a no-transport
  provider reports NO_TRIGGER — so the first wired INTERNAL event turns it red; a reviewer's probe
  must judge every "untouched" claim before it counts as coverage.**
- **Guard:** the rewritten pin in `messaging-config.service.spec.ts`'s "NO_TRANSPORT — provider
  declares no transports" describe block; F23's round-2 review finding (`result.json`).

## Archived 2026-09-08 — headroom for L-094 (docs/663-auth-redesign-bookkeeping, #663 follow-up)

L-088 (2026-09-07, domain, #652) — one of the two next-oldest equally-clean survivors the L-093
headroom note reserved for "a future single-entry archive"; re-confirmed here (id cited nowhere
outside `.claude/pipeline/**`, `.claude/lessons/**`, or `code-map/CHANGELOG.md` — grep-checked
against `code-map/*.md`, `CLAUDE.md`, `docs/**`, `apps/**`, `scripts/**`, `packages/**`,
`tools/**`, `HANDOFF.md`, `README.md`). L-089 (also 2026-09-07, equally clean) stays active as
the closer headroom margin for the next single-entry archive.

### L-088 · 2026-09-07 · domain · #652

- **Symptom:** delivery windows were mapped into the request and then dropped before a cost-only
  solver on one branch, while another branch handed a clock-less solver a "hard" window with no
  start time — three bugs, one class.
- **Root cause:** a constraint verified inside individual solver branches instead of once at the
  seam every branch shares.
- **Lesson:** **enforce a cross-branch constraint at the shared seam AFTER any solver returns
  (re-time against the real clock, repair, then persist), give every solver the same clock the
  verifier uses, and pin it with a fixture where cost order and window order disagree.**
- **Guard:** `REG-B147` / `REG-B161` / `REG-B177` in `route-optimization.service.spec.ts`
  (mutation-probed: seven pins red with the window pass disabled).

## Archived 2026-09-08 — headroom for L-095 (docs/668-b246-bookkeeping, #668 follow-up)

L-089 (2026-09-07, domain, #656) — the entry the L-093/L-094 headroom notes reserved as "the
closer headroom margin for the next single-entry archive." Re-confirmed fresh (citations
accumulate between sessions): a repo-wide grep for the literal id `L-089` hits only
`.claude/lessons/**`, `.claude/pipeline/**` (a mention inside
`2026-09-07-auth-redesign/discovery.md`), and `code-map/CHANGELOG.md`/`code-map/_meta.json`'s own
history note — all allowed citation sites — with no hit in `code-map/*.md` area files, `CLAUDE.md`,
`docs/`, `apps/`, `scripts/`, `packages/`, `tools/`, `HANDOFF.md`, or `README.md`. Back to 40/40
with L-095 added.

### L-089 · 2026-09-07 · domain · #656

- **Symptom:** six different caps (999, 200, 100, 50, 500, page size 20) each silently bounded a
  total, a lookup, a match or a search — tiles understated, a receipt "not found", a statement
  that omitted old debt, a bill that could never be matched, a search that could not reach page 2.
- **Root cause:** a `take`/`limit` chosen as a rendering budget was reused as an arithmetic
  boundary.
- **Lesson:** **a total, a lookup, a match or a search is computed by the database over the whole
  (open) set, or the view is labelled partial; a cap is a rendering budget and never an
  arithmetic boundary; every paginated order carries an id tiebreaker.**
- **Guard:** REG-B12/B80/B110/B117/B144/B169 pins (revert-probed) and the `limit: 999` /
  `take: N,` sibling sweep filed as rows.

## Archived 2026-09-08 — headroom for L-096/L-097 (docs/671-f16b-bookkeeping, #671 follow-up)

The L-093/L-094/L-095 headroom notes' "guarded AND clean" reservation ran out — L-087, L-088 and
L-089 were the only three survivors it ever found, and all three are now archived. This round
needed room for TWO new entries, so before drafting either the elimination was re-run fresh
against the current register (id-by-id `grep` for the literal token, oldest first): every entry
whose guard names a landed automated artifact (a spec, hook, or CI gate) is still cited by id
somewhere outside `.claude/pipeline/**`, `.claude/lessons/**`, or `code-map/CHANGELOG.md`/
`_meta.json`'s own rolling note — confirmed for L-047/L-055/L-057/L-060/L-061/L-062/L-063/L-066/
L-069/L-070/L-071/L-073/L-076/L-078/L-081 (live in `code-map/*.md` area files, `HANDOFF.md`,
`tools/bugflow/docs/*`, a `.claude/campaign/bugs/*.md` record, or app source), so none of those
were eligible under the "guarded" branch of the compaction rule. Falling back to its "oldest, no
recurrence" branch instead: among entries with only a `none — judgment`/convention guard (never
eligible under "guarded" either way, since archiving one loses the only thing enforcing it),
**L-004** (2026-08-24, the single oldest entry in the whole register) and **L-026** (2026-09-01)
were the two oldest whose id is cited nowhere outside the same allowed set (grep-confirmed) — both
lower-cost to lose than a "guarded" entry because nothing in-repo enforces them today regardless
of whether the register keeps them, and both have since been absorbed into standing practice
(L-004's bounded-single-attempt rule now reads as a session constraint in every worktree's own
task brief; L-026's "read the file before trusting a spec's claim" is now the bug-pipeline's S2
refutation step by design). L-051 (2026-09-02, also clean) stays active as the next headroom
margin. Register lands at 40/40 entries with L-096/L-097 added.

### L-004 · 2026-08-24 · process

- **Symptom:** autonomous sessions stalled retrying merges and visibility flips.
- **Root cause:** the auto-mode permission classifier blocks `gh pr merge`, visibility flips,
  and prod-DB commands while the owner is away. It also reacts to the **session's recent shape**,
  not just the command: after a run of branch deletions it refused a read-only `git branch -r`,
  so the safe/unsafe boundary is not stable within a session.
- **Lesson:** **One clean attempt at a blocked command, then reorganize the work: open
  hook-verified PRs plus a written owner runbook — never retry or route around a block.** When a
  read-only command is refused, reach the same fact through another tool (`gh api …`), which the
  denial explicitly permits — that is redirection, not circumvention.
- **Guard:** none — judgment.

### L-026 · 2026-09-01 · process

- **Symptom:** an approved fix spec instructed editing a root manifest field "because it pins three
  of the five modules". It pinned none of them; following the instruction would have ADDED three
  pins the scope never asked for.
- **Root cause:** the spec was written from an audit summary rather than from the manifests. Two
  further claims in the same five-line item were also wrong — one module was pinned _ahead_ of the
  framework's bundled version (the fix was a downgrade, not a catch-up), and a command it presented
  as a one-liner only accepts an interactive prompt.
- **Lesson:** **A spec's factual claims about a file are a hypothesis, not evidence — read the file
  before editing it, and report the correction rather than quietly conforming or quietly diverging.**
- **Guard:** none — judgment. A spec item naming a specific file + field is a cue to open that file
  first.

## Archived 2026-09-08 — headroom for L-098 (docs/673-signin-menu-bookkeeping, #673 follow-up)

L-051 (2026-09-02, process, #603 close-out) — the entry the L-096/L-097 headroom note (#671
follow-up) reserved as "the next headroom margin." Re-confirmed fresh: a repo-wide grep for the
literal id `L-051` hits only `.claude/lessons/**`, `.claude/pipeline/**`, and
`code-map/CHANGELOG.md`/`code-map/_meta.json`'s own history note — all allowed citation sites —
with no hit in `code-map/*.md` area files, `CLAUDE.md`, `docs/`, `apps/`, `scripts/`, `packages/`,
`tools/`, `HANDOFF.md`, or `README.md`. Its guard was already `none — judgment` (a worktree-naming
convention, not an automated artifact), so archiving loses no in-repo enforcement. Back to 40/40
with L-098 added.

### L-051 · 2026-09-02 · process · #603 close-out

- **Symptom:** `git stash pop` in the main checkout applied 19 files of ANOTHER worktree's
  uncommitted batch work onto a docs-only close-out branch — and dropped that stash entry.
- **Root cause:** stashes are refs on the shared repository, not per worktree: an entry pushed in
  `.claude/worktrees/rf-F13` became `stash@{0}` for every checkout, and a bare `pop` takes the
  newest entry wherever it was made. The intended entry had silently become `stash@{1}`.
- **Lesson:** **With several worktrees, never `git stash pop` bare — `git stash list`, then pop
  by index or message, and prefix every stash message with its worktree name.** A dropped stash is
  recoverable from the commit id `pop` prints (`git stash store <sha>`), so keep that line.
- **Guard:** stash messages here carry the worktree name (`rf-F13: …`); no hook — HANDOFF and the
  fleet-state memory carry the rule.

## Archived 2026-09-08 — headroom for L-099 (docs/675-b263-bookkeeping, #675 follow-up)

No "next headroom" candidate was pre-flagged in `_meta.json.note` or the last 3 commits touching
it (#674/#672/#669 each name the candidate THEY used, not a future one), so this follow-up
applied the fallback rule fresh, oldest-first: L-010 (tooling, `none — judgment`) is cited in
`HANDOFF.md`; L-025 (testing, `none — judgment`) is cited in `apps/mobile/__tests__/scan-camera-
web-sequencing.test.ts`, `apps/mobile/lib/skip-stop.ts` and `code-map/mobile.md`; L-027 (process,
`none — judgment`) is cited in `tools/bugflow/docs/MIGRATION.md`; L-034 (tooling) is cited in
`scripts/campaign-check.mjs` and `scripts/jest-campaign-reporter.cjs`; L-035 (process,
`none — judgment`) is cited in `.claude/campaign/bugs/B34.md` — all five stay in the active
register. L-038 (2026-09-01, tooling) is the next-oldest entry: a repo-wide grep for the literal
id `L-038` hits only `.claude/lessons/**` (this file, LESSONS.md) and `.claude/pipeline/**` (four
reports) — all allowed citation sites — with no hit in `code-map/*.md` area files, `CLAUDE.md`,
`docs/`, `apps/`, `scripts/`, `packages/`, `tools/`, `HANDOFF.md`, or `README.md`. Its guard was
already `none — validate-lock passes either way` (no dedicated automated check, verified by hand,
same shape as a `none — judgment` guard), so archiving loses no in-repo enforcement. Back to
40/40 with L-099 added.

### L-038 · 2026-09-01 · tooling

- **Symptom:** a five-pin change arrived as a 592-line lockfile diff — 185 entries of
  `{"devOptional":true}` → `{"dev":true}` with zero version changes — alarming any reviewer
  reading it cold.
- **Root cause:** a bot-authored dependency PR is generated by a foreign package-manager client
  and merged as-is, so the next PR to touch the lockfile regenerates it with the repo's pinned
  `packageManager` client and normalizes all of it back. The churn is paid by an innocent later
  PR, not the one that caused it.
- **Lesson:** **Regenerate a bot-authored lockfile with the repo's pinned package-manager client
  BEFORE merging that PR — otherwise its foreign shapes ambush the next author, whose only
  alternatives are a huge diff or hand-editing a lockfile no client would produce.**
- **Guard:** none — `validate-lock` passes either way, since the shapes are equivalent. Verify a
  lockfile rebase by version-change count (`0`), never by diff size.

## Archived 2026-09-09 — headroom for L-100 (docs/numbering-group-a-bookkeeping, 678 follow-up)

No "next headroom" candidate was pre-flagged in `_meta.json.note` or the last 3 commits touching
it (#677/#674/#672 each name the candidate THEY used, not a future one), so this follow-up applied
the fallback rule fresh, oldest-first, over the CURRENT active register (L-038 having already been
archived by #677): L-010/L-025/L-027/L-034/L-035 stay active per #677's own citation proof, unchanged
since. L-050 (2026-09-02, testing, `none yet`) is cited outside allowed paths — `code-map/web.md`,
`code-map/api.md`, `apps/web/playwright.config.ts`, `docs/IMPROVEMENTS.md`,
`apps/api/scripts/e2e-seed.js`, `apps/web/e2e/LOCAL-LANE.md`, `apps/web/e2e/32-active-sessions.spec.ts`,
`apps/web/e2e/helpers/constants.ts` — stays active. L-092 (2026-09-08, testing, `#657`) is the
next-oldest weak-guard entry (`process — add to the dev-pipeline driver prompt … no in-repo guard
yet`, the same no-automated-check shape as a `none — judgment` guard): a repo-wide grep for the
literal id `L-092` hits only `.claude/lessons/LESSONS.md` and `code-map/CHANGELOG.md` — both
allowed citation sites — with no hit anywhere else. Archiving it loses no in-repo enforcement (the
lesson's own process step, adding a build-identity probe to the dev-pipeline driver prompt, was
never itself wired as a repo guard). Back to 40/40 with L-100 added.

### L-092 · 2026-09-08 · testing · #657

- **Symptom:** the marketing engine's UI-verify rounds 3–6 judged screenshots of master's build
  for two days — a stale Docker container (`routeflow_web`, built from a retired worktree) still
  held `:3001`, so every request the UI gate made hit master, never the branch under review.
- **Root cause:** the UI gate never proved WHICH build actually answered on the URL under test.
- **Lesson:** **every UI-verify pass starts with a build-identity probe on the exact URL (a
  branch-only marker string, or the commit sha the page exposes) and records the answer in the
  evidence — a judge never scores a screenshot without that line.**
- **Guard:** process — add to the dev-pipeline driver prompt (skill file outside the repo) as
  protocol step 0; no in-repo guard yet.

**Archived 2026-09-09** (bookkeeping prep, `docs/wave-2026-09-09-bookkeeping`): L-094
(2026-09-08, process, `#663`, guard `none yet`) is the clean candidate — a repo-wide grep for the
literal id `L-094` hits only `.claude/lessons/LESSONS.md`, with no hit anywhere else in the repo
(every other active entry is cited from `code-map/*.md`, `HANDOFF.md`, or `tools/bugflow/docs/**`,
outside the allowed citation sites). Archiving it loses no in-repo enforcement — its
`result.json`-checkpointing change was recorded only as a RUN-LOG candidate outside this repo,
never wired as a guard here. Back to 40/40 with L-101 added.

### L-094 · 2026-09-08 · process · #663

- **Symptom:** the auth-redesign dev-pipeline engine stopped mid fix-loop at 62 agents with no
  `result.json`, on checkpoint `102c79ce` — the next session reconstructed state via a light loop;
  two driver agents in the same run had also stalled on background waits.
- **Root cause:** the engine writes `result.json` only at the very end, so a stopped or killed run
  leaves nothing machine-readable behind.
- **Lesson:** **A long engine run checkpoints `result.json` (phase, remaining findings, gate
  state) after every phase, not only at the end, and agent prompts forbid background waits — so
  an interruption resumes from a record, not a reconstruction.**
- **Guard:** none yet — process; dev-pipeline engine change candidate recorded in
  `~/.claude/skills/dev-pipeline/references/RUN-LOG.md` under `2026-09-07-auth-redesign`.

## Archived 2026-09-09 — headroom for L-102 (docs/686-campaign-web-report-bookkeeping, #686 follow-up)

Checked every active entry oldest-first by the standing rule (repo-wide grep for the literal id,
citation outside `.claude/lessons/**`, `.claude/pipeline/**`, `code-map/CHANGELOG.md`,
`code-map/_meta.json` disqualifies). L-010/L-025/L-027/L-034/L-035/L-041/L-050/L-055/L-057/L-060/
L-061/L-062/L-063/L-066/L-067/L-068/L-069/L-070/L-071/L-072/L-073/L-074/L-076/L-077/L-078/L-081/
L-082/L-083/L-086/L-090/L-091/L-093/L-095/L-096/L-097/L-098/L-099/L-100 are all cited outside the
allowed sites (mostly `code-map/{api,web,mobile,INDEX}.md`, several from `HANDOFF.md` or
`tools/bugflow/docs/**`). L-101 (2026-09-09, domain, no PR) is the only clean entry: a repo-wide
grep for the literal id `L-101` hits only `.claude/lessons/LESSONS.md`, `.claude/lessons/_meta.json`,
and `code-map/CHANGELOG.md` — all allowed citation sites — with no hit anywhere else. It carries a
real automated guard (`apps/mobile/__tests__/session-teardown.test.ts`,
`offline-queue-identity.test.ts`), so archiving it trades away nothing enforcement-wise; the tests
themselves stay in place regardless of whether the register still narrates them. Back to 40/40
with L-102 added.

### L-101 · 2026-09-09 · domain

- **Symptom:** sign-out cleared tokens only; the offline queue, TanStack query cache, POD
  scratchpad, six other user-scoped stores, and the background GPS task all outlived the session
  and replayed under the next signed-in user.
- **Root cause:** no teardown contract — each store/task was added over time without registering
  itself with sign-out, so `useAuthStore.logout()` only ever knew about tokens.
- **Lesson:** **sign-out is a teardown CONTRACT: one `teardownUserSession()` runs BEFORE the
  token-deleting logout call, and every user-scoped store, cache, queue and background task
  registers a reset there; queued work is identity-stamped and replays only for its owner; a
  "minor" engine run that needs more than 4 fix rounds hands the remainder to a light loop.**
- **Guard:** `apps/mobile/__tests__/session-teardown.test.ts` (REG-B150/B140),
  `offline-queue-identity.test.ts` (REG-B137).

## Archived 2026-09-10 — headroom for L-103 (chore/next-15 #5b3b3c4e)

Repo-wide grep for every active id (except L-062 and L-083, both amended in place rather than
archived — see the lessons follow-up) found exactly one clean candidate under the standing rule
(cited only in `.claude/lessons/**`, `.claude/pipeline/**`, `.claude/code-map/CHANGELOG.md`, or
`.claude/code-map/_meta.json`): **L-102** (2026-09-09, tooling, guard
`apps/api/src/common/campaign-check-web-report.spec.ts`, which stays in the tree — archiving
loses no enforcement). Every other active entry is cited from a code-map area file
(`web.md`/`api.md`/`mobile.md`/`INDEX.md`), `HANDOFF.md`, `tools/bugflow/docs/**`, the bug
registry (`.claude/campaign/**`), or real source — see `local-assets/handoff/2026-09-10/
next15-bookkeeping/archive.md` for the full per-id grep evidence. Back to 40/40 with L-103 added.

### L-102 · 2026-09-09 · tooling · #686

- **Symptom:** three REG-B### pins landed in `apps/web` Jest tests and every PR's `npm run
verify` went red: `scripts/campaign-check.mjs` reported "no test titled with REG-B## found" for
  each one, even though the tests existed and passed.
- **Root cause:** the checker only ever read the api/mobile/pricing campaign reports —
  `apps/web` never ran `scripts/jest-campaign-reporter.cjs`, so no `.campaign/runs/web.json`
  existed for it to read.
- **Lesson:** **a proof-by-test-title gate must read a report from EVERY workspace that can host
  a pin; adding a pin to a workspace the gate doesn't yet cover is a tooling change first
  (reporter + checker) and a pin second.**
- **Guard:** `apps/api/src/common/campaign-check-web-report.spec.ts`.

## Archived 2026-09-11 — headroom for L-104 (fix/train4-order-idempotency-key, B215)

Register was 40/40 and 39.9/40.0 KB, so L-104 needed a slot. **L-099** (2026-09-08, domain) is the
archived entry: a repo-wide grep for the literal id finds exactly two citations outside
`.claude/lessons/**`, and both are HISTORICAL records rather than active pointers —
`.claude/code-map/CHANGELOG.md`'s dated #675 section and `.claude/code-map/mobile.md`'s
"Lessons: L-099 appended" line — so nothing reads it as a live rule. Its guards
(`apps/mobile/__tests__/edit-items-scan-price.test.ts`,
`apps/mobile/__tests__/barcode-scanner-active.test.ts`) stay in the tree, so archiving loses no
enforcement. Back to 40/40 with L-104 added.

### L-099 · 2026-09-08 · domain · #675

- **Symptom:** editing a scanned line's price on mobile tore the camera down and cost 5 taps + 2
  camera lifecycles; the list surface and the scan surface disagreed on margin-floor wording.
- **Root cause:** the screen swapped SURFACES through a mode ternary (`showPicker ? picker :
list`) instead of stacking the edit sheet over the live surface; the strip's label was a
  literal, independent of the line's margin class.
- **Lesson:** **A sheet that must return to a live surface (camera, map, scanner) MOUNTS OVER
  that surface with a pause prop (`active={!editing}`), never swaps the surface out; any
  secondary surface that repeats a classification (margin class, status) derives it from the
  same helper the primary surface uses, and a source-text pin extracts the primary's literals so
  the two cannot drift.**
- **Guard:** `apps/mobile/__tests__/edit-items-scan-price.test.ts` (REG-B263-B/C/H),
  `apps/mobile/__tests__/barcode-scanner-active.test.ts`.

## Archived 2026-09-11 — least-cited, fully guarded; making room

Six active entries archived together to clear headroom for the six new train-4 entries
(L-105–L-110): L-069, L-077, L-078, L-090, L-091, L-097. All six carry a real automated guard
that stays in the tree regardless of whether the register still narrates them (busy-batch
pre-colouring + `readClaims` pure-fn tests; `runGh`'s 60s timeout + `visibility-watchdog-script.
spec.ts`; `validate-lessons` + step 2 of `npm run verify` + CI; the m7 spec quoting the memo's
basis verbatim + deployment E2E spec 22 REG-B11; spec 37 REG-B80/B144; campaign-check's
exact-prefix rule), so archiving them loses no enforcement — least-cited, fully-guarded, per the
standing archiving rule.

### L-069 · 2026-09-04 · process · #597

- **Symptom:** claiming a batch made the dispatcher offer the batch touching the same files to a
  second agent; a copied claim grammar freed another script's leases.
- **Root cause:** the scheduler removed in-flight work from the candidate list before building the
  conflict graph, so taking a batch DELETED its edges; and a protocol restated by eye drifted on
  three details, each toward the permissive read.
- **Lesson:** **Excluding an entity from a constraint problem deletes its constraints — model
  in-progress work as an OCCUPANT that holds capacity and keeps its edges, never as a deletion. A
  protocol restated in a second file drifts toward whatever is permissive: extract the reading as a
  pure function, test it against the other side's exact payloads, and make both files say they
  change together.**
- **Guard:** busy batches pre-coloured into wave 1, `CONFLICTING` includes `in-flight`; `readClaims`
  is pure and asserted against the three comment sets that broke it; both files carry the
  paired-change warning.

### L-077 · 2026-09-05 · deploy · close-out re-check

- **Symptom:** an unattended retry loop whose header promised "total <= ~8 min" had no upper
  bound at all, and the marker it writes when it gives up landed where nobody looks.
- **Root cause:** the budget counted only the sleeps between attempts — every external `gh` call
  was unbounded, so ONE hung call outlives the whole public window; and the marker path resolved
  against the LAUNCHING directory, so a watchdog armed from a worktree hid its failure there.
- **Lesson:** **A retry loop is only as bounded as its slowest call — give every external call a
  timeout and state the budget as (sum of sleeps + sum of timeouts). And a failure marker must
  land where a reader actually looks: one fixed place, named in the runbook step that tells them
  to check it.**
- **Guard:** `runGh`'s 60s timeout + `visibility-watchdog-script.spec.ts` (reachable-delay list,
  `root=` on the start line, gated overrides); the runbook names the marker path.

### L-078 · 2026-09-05 · process · close-out re-check

- **Symptom:** `LESSONS.md` keeps merging CLEANLY into duplicate ids — L-054 four times, then
  L-058, L-061, L-067 and L-074, each renumbered after the fact.
- **Root cause:** two branches append under DIFFERENT `##` section headings, so git finds no
  textual conflict; both derived the same next id from the base they branched off, and the union
  keeps both entries with the same number.
- **Lesson:** **After EVERY rebase or merge, run `node scripts/validate-lessons.mjs` before
  appending: renumber your entries to the MERGED file's `nextId` and archive back to the cap
  first. An id belongs to whichever branch LANDS first, never to whoever wrote it first.**
- **Guard:** `validate-lessons` (DUPLICATE ID, COUNT MISMATCH, OVER CAP), step 2 of
  `npm run verify` and re-run in CI; carry this as a line in the rebase checklist.

### L-090 · 2026-09-07 · testing · #659

- **Symptom:** a server-side KPI replacing a client memo passed every unit test and failed the
  deployment E2E — the "Awaiting confirmation" tile read 0 (deployment E2E spec 22 REG-B11 red on
  master `e02851af`).
- **Root cause:** the port narrowed the memo's basis (DRAFT payments across every loaded invoice →
  DRAFT payments on the OPEN set only) while pinning the NEW, narrowed basis in its own spec — so
  the pin agreed with the port, not with the memo the port was supposed to reproduce.
- **Lesson:** **when a client-side derivation moves to the server, transcribe the client's basis
  VERBATIM into the server pin FIRST — quote the memo's filter/exclusions (or lack of them) in the
  spec's own title/comment — then port to make that pin pass. A pin written from the port's own
  code, after the port, proves the port is internally consistent, never that it reproduces what it
  replaced.**
- **Guard:** the m7 spec (`invoices.service.spec.ts`) now quotes the memo's basis verbatim in its
  title and comment; deployment E2E spec 22 REG-B11 is the standing regression signal.

### L-091 · 2026-09-07 · testing · #661

- **Symptom:** two deployed-E2E regression tests for real fixes stayed red for two deploys on
  harness defects — a `getByText` on a value the page renders twice (strict-mode violation) and
  a fixture that provisioned 25 pending orders for one customer through an API whose staff-create
  path demands an explicit merge choice (409).
- **Root cause:** the harness modelled the product from its own assumptions instead of through
  the product's real contracts — an identifier's role on the page, and the API's guard for
  repeated entities.
- **Lesson:** **assert identifiers by ROLE (`getByRole("heading", …)`) never `getByText` when a
  value can render more than once, and provision E2E fixtures THROUGH the product's own guards
  (send the explicit choice the API demands — `mergeChoice: "separate"` — rather than multiplying
  entities to dodge the guard, which pollutes the tenant).**
- **Guard:** spec 37 REG-B80/B144 as landed; the register's T2 discharge needs the run id.

### L-097 · 2026-09-08 · process · #671

- **Symptom:** B245 was discharged with proof `REG-B245` while its pin tests were titled plain
  `B245: …` — the token lived in the registry but not in the test file.
- **Root cause:** `prove`'s `--proof` regex checks the claim text only; nothing cross-checks a
  discharge token against the titles of the file it claims to pin.
- **Lesson:** **A discharge proof token must match its test titles byte-for-byte — run
  `node scripts/campaign-check.mjs`, not just `bugs.mjs sync --check`, before merging a docs
  follow-up by rule.**
- **Guard:** campaign-check's exact-prefix rule (already enforced) + this step in the follow-up
  checklist.

## Archived 2026-09-12 — least-cited, fully guarded; headroom for L-111

One active entry archived to clear headroom for L-111 (process, Plane sync, feat/plane-harness
rebase onto master): L-057. It carries a real automated guard that stays in the tree regardless
of whether the register still narrates it (`scripts/visibility-watchdog.mjs`, mandatory in
`docs/runbooks/deploy-visibility-flip.md` and the `rebuild` skill), so archiving it loses no
enforcement. Tied at one outside citation (`HANDOFF.md`) with L-073 (2026-09-04, also fully
guarded); L-057 is the older of the two by id — per the standing archiving rule (least-cited,
fully-guarded, oldest first) it is the one archived.

### L-057 · 2026-09-04 · deploy · #609

- **Symptom:** a process restart killed the agent session inside a public-repo CI window;
  the repo stayed public ~6.5 hours (07:38Z→14:18Z) before anyone noticed.
- **Root cause:** the private flip lived only in the session's own control flow — a
  `finally` in an agent that no longer existed to run it.
- **Lesson:** **an irreversible-if-forgotten safety action (flip private) must be armed by
  a process that outlives the session BEFORE the risky action (flip public) — a detached
  watchdog with a fixed deadline, never a `finally` in an agent.**
- **Guard:** `scripts/visibility-watchdog.mjs`, mandatory in
  `docs/runbooks/deploy-visibility-flip.md` and the `rebuild` skill.

## Archived 2026-09-12 — least-cited, fully guarded; headroom for L-112 and L-113

One active entry archived to clear headroom for L-112 (testing, Plane bulk sync,
feat/plane-harness-learning worktree rf-plane3): L-107. It has zero outside citations (the
uniquely least-cited active entry — every other entry has at least one reference elsewhere in
the repo) and carries a real automated guard that stays in the tree regardless of whether the
register still narrates it (Run A pins P15–P22 in `orders.service.spec` / `invoices.service.spec`),
so archiving it loses no enforcement.

### L-107 · 2026-09-11 · domain · train-4 Run A

- **Symptom:** a NOWAIT advisory lock taken Invoice-first cycled (Postgres 40P01) against
  `voidInvoice`'s own lock order; separately, folding `CONCURRENT_UPDATE` into `HANDLED_CODES`
  (to silence a duplicate toast) also silenced the delete flow's real failure toast.
- **Root cause:** two guards on the same row acquired locks in opposite orders; and a status was
  added to a shared toast-suppression set without checking every OTHER caller that fires on it.
- **Lesson:** **Take the Invoice lock LAST, after dependent-row locks release, matching
  `voidInvoice`'s own order — a NOWAIT cycle is an ordering bug, not a timing one. Never add a
  code to a shared suppression set without checking every caller it also silences.**
- **Guard:** Run A pins P15–P22 (orders.service.spec / invoices.service.spec REG pins).
  One active entry archived to clear headroom for L-112 (testing, CRM GoHighLevel handoff,
  feat/crm-gohighlevel-handoff, worktree rf-crm): L-034. Uncited by any `[[L-034]]` reference
  anywhere in the active register, and fully guarded (`turbo run test --force` + an mtime
  post-dates-the-change assertion, procedural but real and still enforceable). It is the oldest
  active entry by id among the fully-guarded, uncited candidates — `L-010`/`L-025`/`L-027`/`L-035`
  sit lower by date but each carries `Guard: none — judgment`, so they are not compaction-eligible
  under the "does the guard make the entry safe to stop reading" test; `L-041` and `L-074` are
  each cited once ([[L-041]] in L-050, [[L-074]] in L-111) and were kept for that reason.

### L-034 · 2026-09-01 · tooling · #TBD

- **Symptom:** `campaign-check` red on another batch's rows after a rebase, and a mutation probe
  that reported nothing. Both were reading an artifact no run had refreshed.
- **Root cause:** the campaign artifact is written by a jest REPORTER, so it only refreshes when
  jest actually EXECUTES. Repo-root ledger files are not hashed inputs (`globalDependencies` is
  the lockfile plus package manifests; the test task's `inputs` are `$TURBO_DEFAULT$`), so a
  rebase cannot bust the cache — turbo replays a green summary and the stale artifact survives.
  Scoped runs (`jest -t REG-B##`, one per mutation probe) narrow it to just those tests, and a
  cache-replayed "full suite" afterwards does not overwrite that.
- **Lesson:** **A generated artifact is evidence only when you can name the tool and the run that
  produced it.** Extends [[L-009]]: a cache replay does not merely fail to prove the tests ran —
  it silently PRESERVES whatever the last scoped run wrote. Same shape as regenerating a lockfile
  with the wrong npm major: the diff reads as content drift when it is tooling drift.
- **Guard:** force execution (`turbo run test --force` or direct `npx jest`), then assert the
  artifact's mtime post-dates the change, before reading any gate that consumes it. Freshness is
  verified, never inferred from a green summary.

## Archived 2026-09-12 — least-cited, fully guarded; headroom for L-114

One active entry archived to clear headroom for L-114 (tooling, plane self-test tmpdir
invariant, fix/plane-selftest-tmpdir worktree rf-plane3): L-108. Zero outside citations found
(repo-wide grep excluding `.claude/lessons/**`, `.claude/pipeline/**`, and code-map
CHANGELOG/`_meta.json`); tied at zero citations with L-109/L-110/L-111 (all 2026-09-11,
fully guarded) — L-108 is the oldest of the tied set by id, so per the standing archiving rule
(least-cited, fully-guarded, oldest first) it is the one archived. It carries a real automated
guard that stays in the tree regardless of whether the register still narrates it (the engine
gate runner's own `execFileSync` usage), so archiving it loses no enforcement.

### L-108 · 2026-09-11 · process · engine gate runner

- **Symptom:** `bash -c "cmd; echo EXIT=$?"` always printed `EXIT=0` even when `cmd` failed — a
  red gate read green.
- **Root cause:** `$?` in that string is expanded by the OUTER shell at parse time, before the
  child runs — it reads the echo's own status, never `cmd`'s.
- **Lesson:** **Never place `$?` after a semicolon in the SAME `-c` string expecting the prior
  command's status — single-quote so `$?` expands INSIDE the child, or capture each command's
  own exit code separately (`execFileSync`/spawnSync status), never a glued one-liner.**
- **Guard:** the engine gate runner uses `execFileSync` with its own status check, never a
  string-glued exit-code echo.

## Archived 2026-09-12 — least-cited, fully guarded; headroom for L-115

### L-041 · 2026-09-01 · process

- **Symptom:** 13 rows sat in `proven` — merged, deployed, post-deploy run already green — while
  every scoreboard counted them outstanding. Then the run cited as their proof turned out to have
  executed **nothing**.
- **Root cause:** two failures stacked. The proof fires off the deploy signal and lands after the
  session that merged the fix has ended, so the flip to `done` belongs to nobody. And the run
  everyone pointed at (a superseded deployment) reported conclusion **success with every real step
  `skipped`** — a green job that ran zero tests.
- **Lesson:** **When the evidence authorizing a state change arrives asynchronously, assign the
  flip — and when you read that evidence, read the STEP conclusions, never the job's.** A job is
  green when it is skipped, and a suite is green when a test is skipped; neither says your proof ran.
- **Guard:** `gh run view <id> --json jobs` — assert the specific step is `success`, not
  `skipped`; for one test, grep the log for its `✓`. Step COUNT is not execution.

## Archived 2026-09-12 — least-cited, fully guarded; headroom for L-116

One active entry archived to clear headroom for L-116 (tooling, plane self-test invariants must
never bind to shared machine-local files, fix/plane-write-ledger-local worktree rf-plane3):
L-109. Zero outside citations found (repo-wide grep excluding `.claude/lessons/**`,
`.claude/pipeline/**`, and code-map CHANGELOG/`_meta.json`); tied at zero citations with
L-110/L-111 (both 2026-09-11, fully guarded) and L-112/L-113 (2026-09-12, fully guarded) —
L-109 is the oldest of the tied set by id, so per the standing archiving rule (least-cited,
fully-guarded, oldest first) it is the one archived. Its own guard (campaign-check's freshness
gate refusing a stale report by name) is an existing mechanism unrelated to this register entry,
so archiving it loses no enforcement.

### L-109 · 2026-09-11 · process · registry-shard commits

- **Symptom:** a push after a registry-shard commit was refused by campaign-check for "stale"
  Jest freshness, though the test files were untouched and had passed minutes earlier.
- **Root cause:** a registry-shard commit (`.claude/campaign/**`) moves HEAD, which the freshness
  gate compares reports against; the pre-push hook has no docs-only bypass for this commit class.
- **Lesson:** **After a registry-shard commit, regenerate the affected workspace's Jest
  freshness report BEFORE verify/push — such a commit is not exempt just because it touched no
  test file.**
- **Guard:** campaign-check's freshness gate (already refuses a stale report by name with the
  regen command) — this is a usage note on WHEN to regenerate.

## Archived 2026-09-13 — least-cited, fully guarded; headroom for L-117

### L-110 · 2026-09-11 · tooling · workflow-tool resume

- **Symptom:** resuming a Workflow-tool run failed with `JSON Parse error: Expected '}'` — the
  stored `args` field was truncated mid-string.
- **Root cause:** stored-args serialization truncates near 4 KB; a run with long inlined
  briefs/content (not paths) lost its closing brace on write, undetected until resume.
- **Lesson:** **Keep every Workflow-tool run's stored args under 4 KB — pass paths and short
  briefs, never inlined content or transcripts, or resume fails opaquely.**
- **Guard:** the RESUME card records the args byte size at launch, so a run near the limit is
  visible before resume is relied on.

### L-111 · 2026-09-11 · process · Plane sync

- **Symptom:** Gate 5 (`.claude/hooks/stop.mjs`) ran registry→Plane sync against the LIVE
  workspace from a feature worktree (282 items, 160 dupes) — cwd was still in the worktree from
  an earlier `cd`, so its hook fired with the real `PLANE_API_KEY`.
- **Root cause:** the hook had no branch/tree gate or write cap; hooks resolve against the tree
  the cwd sits in, not the session's home tree.
- **Lesson:** **A hook writing to an external system with real credentials must be dry by
  default off the integration branch, cap writes per run — end every turn with the shell back
  home.**
- **Guard:** `plane-sync.mjs` R14 branch guard + `--max-writes` (25), tests T16/T16b;
  `dedupe-2026-09-12.mjs` cleaned dupes. Sibling [[L-074]].

## Archived 2026-09-13 — headroom for L-118 / L-119 (#710 Option-B follow-up)

One entry archived for F38's two lessons: **L-112** (2026-09-12, testing, Plane bulk sync) — the
only active entry that is both zero-cited outside the registers (repo-wide `git grep` excluding
`.claude/lessons/**`, `.claude/pipeline/**`, `.claude/handoffs/**` and code-map
CHANGELOG/`_meta.json`) and fully guarded. Note for the next session: the register is now
structurally full — L-103 and L-106 are zero-cited but carry "Guard: none yet" (ineligible),
L-113 gained a citation from `orders.service.spec.ts` when #710 landed, and every other entry is
cited at least once. The two caps disagree (40 entries × ~1.05 KB ≈ 42 KB vs a 40 KB byte cap),
which `validate-lessons.mjs` flags on every run as an owner decision. Its guard
(`plane-client.mjs` `CONTENT_KEYS` scoping + the uuid-id self-test cases) is an existing
mechanism, so archiving loses no enforcement.

### L-112 · 2026-09-12 · testing · Plane bulk sync

- **Symptom:** the first bulk registry→Plane sync from master adopted all 160 name-keyed items
  but created 0 of 72 rows and patched 0 of 160 (`skipped(forbidden)=232`), and plane-apply
  refused every op with `forbidden (tenant-uuid)` — despite the full suite (T1–T18 plus an Opus
  review and re-check) having been green.
- **Root cause:** the write-path denylist scanned every string in a request body, so Plane's own
  uuid-shaped state/label/assignee ids tripped the tenant-uuid pattern; the fake server's ids
  were short strings (`state-1`), so no test could ever see the collision — the fixture's data
  shape was less realistic than production's on exactly the axis the guard keyed on.
- **Lesson:** **A fake/fixture must reproduce the production SHAPE of every value a guard keys
  on (id formats, timestamp offsets, envelope vs bare array), and a content filter must be
  scoped to the content fields it protects — never to "every string" — because a guard tested
  only against toy shapes is a guard that fires first in production.**
- **Guard:** `scripts/campaign/plane-client.mjs` scans `CONTENT_KEYS` only; `plane-fake-server.mjs`
  `uuidIds: true` seeds + the uuid-id cases in plane-sync/plane-apply self-tests; Landmine 15
  (live shapes) in the harness build plan. Related [[L-111]] (hook/branch gate), [[L-074]]
  (fixture realism).

## Archived 2026-09-13 — headroom for L-132 (F27 B70) + byte cap

Three active entries archived to clear headroom for L-132 (F27 B70, renumbered from L-119, then
again from L-131 to avoid a second collision, during
the 2026-09-14 rebase to avoid colliding with master's own L-119) and bring the register back
under its 40 KB byte cap: L-035, L-027, L-010. All three carry `none — judgment` guards (no landed
enforcement mechanism) and zero outside citations (repo-wide grep excluding `.claude/lessons/**`,
`.claude/pipeline/**`, worktrees, and code-map CHANGELOG/`_meta.json`) — same disqualification
class the register already used for L-004/L-026 (oldest, uncited, judgment-only). L-025 was
checked and kept: it is cited from `apps/mobile/lib/skip-stop.ts`. L-055 was checked and kept: it
is heavily cited across `apps/api/src/prisma/prisma-isolation.spec.ts`, `prisma.service.ts`, and
multiple code-map CHANGELOG entries — not a candidate despite similar age.

### L-035 · 2026-09-01 · process · #TBD

- **Symptom:** B120's POD archive was designed onto a generic `AuditLog` row; review found
  `RouteRunStop.podHistory` already existed, unused, with a schema comment naming the exact entry
  shape and the words "F10 wires the write".
- **Root cause:** an earlier enablement batch pre-added the column FOR this batch, and the design
  was drawn from the register's suggested fix without grepping the schema for what was already
  provisioned.
- **Lesson:** **Before designing where something is stored, grep the schema for a column addressed
  to your batch — the schema comment IS the spec.** Enablement batches leave columns waiting; a
  field with no readers is a contract, not dead weight.
- **Guard:** none — judgment. The mismatch also showed up as a blocker (the shared test mock had
  no `auditLog` model), so "the harness fights you" is a hint you are off the intended path.

### L-027 · 2026-09-01 · process

- **Symptom:** with several sessions running in git worktrees, a repo-file gate was about to be
  satisfied by writing into a _different_ session's working tree — surfacing later as a mystery diff
  in someone else's PR.
- **Root cause:** worktrees are nested inside the main checkout, and hooks resolve their paths
  against that main checkout, not the worktree the session is working in. Whatever branch the shared
  checkout happens to be parked on is the file the gate points at.
- **Lesson:** **Never satisfy a gate by writing into whatever tree the hook happens to run from —
  defer the write to your own worktree and say plainly why. Keep the shared checkout on the
  integration branch; it is the only sane resting state for a tree that hooks resolve against.**
- **Guard:** none — judgment. A gate demanding a repo file while you work in a worktree is the cue
  to check which tree that path actually lands in.

### L-010 · 2026-08-29 · tooling

- **Symptom:** one workspace's tests "failed" under verify while the same code passed everywhere
  else.
- **Root cause:** worker exhaustion under host load — the task exited 1 with **no test report at
  all**; nothing ever ran.
- **Lesson:** **A bare non-zero task exit with no test report is environmental — re-run that
  workspace directly before debugging; CI on clean runners is the authoritative gate.**
- **Guard:** none — judgment (triage: direct `npx jest`, then filtered turbo).

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

## Archived 2026-09-16 — lessons-compaction (L-168-L-171 headroom)

Eight active entries archived to clear headroom for L-168-L-171 and bring the register
comfortably under its 65,536-byte cap (was 63.9/64.0 KB, ~0 headroom). Selection rule (per
the lead, chore/lessons-compaction): among fully-guarded entries (real test/CI guard), rank
by outside citations ascending, restricted to entries dated on or before 2026-09-09 to avoid
archiving recently-minted entries whose low citation count reflects age rather than value;
only L-063/L-068/L-074/L-100 (plus L-072/L-081, excluded — 200 and 113 outside citations
respectively, clearly still load-bearing) qualified from that window, so the remaining four
slots were filled from the lowest-cited 2026-09-15 entries instead: L-152/L-153/L-157/L-158.
Citations counted via repo-wide grep (`.claude`/`apps`/`packages`/`scripts`/`docs`, excluding
`.claude/lessons/**`) plus `git log --grep` plus internal `[[L-NNN]]` sibling references.

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

### L-074 · 2026-09-05 · tooling

- **Symptom:** a prod-capable seed run through `railway run --service postgres` wrote to the LOCAL
  dev database.
- **Root cause:** the script defaulted `DATABASE_URL` to a localhost URL and the postgres service
  exposes only discrete POSTGRES_*/TCP-proxy vars.
- **Lesson:** **a script that can target production never has a silent local default: resolve the
  target from the variables the runner actually injects, print the resolved host before
  connecting, and treat "nothing set" as a loud fallback.**
- **Guard:** `resolveDatabaseUrl` + its spec; the seed logs its target host.

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

## Archived 2026-09-16 — headroom for L-165-L-167/L-172-L-174 (post-#779/#781 merge)

Two more active entries archived to clear both caps after landing six new entries
(L-165/L-166/L-167 from PR #779/#781, L-172/L-173/L-174 dictated by the lead) pushed the
register to 53/52 entries, 65.8 KB. Per the lead: author-trimmed the six new entries to
<=1.1 KB each first (recovered headroom), then archived by the same rule as the morning
pass (fully-guarded, lowest outside citations, excluding L-072/L-081) — but the
date-restricted (<=2026-09-09) pool was already exhausted by the morning archive, so this
pass drew from the full active set instead: L-150 and L-161 (both cites=2, real test
guards, dated 2026-09-15). L-164 (also cites=2, guarded) was kept over L-150/L-161 — its
fail-open/undefined-vs-empty principle reads as more broadly applicable than either
archived entry's narrower mechanism.

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

## Archived 2026-09-16 — headroom for L-175–L-180 + next-fix headroom (72's lessons batch)

Landing six new entries (L-175 disk budget, L-176 worktree node_modules, L-177 squash-simulate
docs, L-178 demo-booking raw error message, L-179 campaign-check freshness ritual, L-180 git
worktree move npm-junction staleness) would have pushed the register to 57/52 entries. Archived
five by the fully-guarded/lowest-outside-citations rule, excluding L-072/L-081 (protected):
L-055, L-129, L-133, L-147, L-148 — each already has a durable guard landed in the codebase
(a fixed spec, a code assertion, or shipped state), and none turned up a live, currently-correct
citation outside the register itself (two — L-055, L-129 — turned up STALE citations under their
number for unrelated content; a prior id-renumbering left `prisma.service.ts` and
`backfill-check-dates.mjs`/`.spec.ts` pointing at the wrong lesson text — a pre-existing defect,
flagged separately, not fixed by this archive pass).

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

### L-147 · 2026-09-15 · domain · WP4 print-row state

- **Symptom:** invoices-list Print used one `printingId` for every row; printing row A then
  clicking row B cleared A's spinner, both buttons racing the same flag.
- **Root cause:** a single scalar stood in for "this row's action is pending" across a list —
  wrong once two rows can act at once.
- **Lesson:** **Per-row async state in a list is keyed per row (`Set`/`Map` of ids), never one
  scalar — a scalar assumes at most one row is ever in flight.**
- **Guard:** `invoices/page.tsx` tracks `printingIds: Set<string>`; row `disabled={printingIds.has(inv.id)}`.

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

Second pass, same batch, per the lead: exactly-at-cap (52/52) would have blocked the very next
fix's lesson entry, so archived 4 more by the same rule (fully-guarded, lowest outside-citations,
excluding L-072/L-081 and anything cited by CLAUDE.md): L-118, L-120, L-121, L-128 — each has a
zero or changelog-only outside citation count (checked via repo-wide grep) and a durable
regression-test guard that stays enforcing regardless of archival.

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

Third pass, same batch: L-182 (self-test wall-clock regression) folded in, keeping headroom at
the lead's minimum of 3 required one more archive: L-126 (zero outside citations, durable
`REG-FINDING-1`/`REG-FINDING-4` guard in `platform-admin.service.spec.ts`).

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

Fourth pass, same batch: register dropped below the lead's 3-entry headroom minimum (50/52)
after L-183 landed. Archived one more by the same rule: L-127 (zero outside citations, fully
closed-out with a 5-case regression guard).

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

Fifth pass, same batch: L-184 (deploy, #777 migration/drift gap) folded in. Archived one more to
keep the register at 3 entries of headroom: L-134 (zero outside citations, a closed-out CI
testing pattern with its own standing guard and reference spec file).

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

Sixth pass, same batch: L-185 (domain, B440 report-field dual-consumer lesson) folded in. Archived
one more to keep the register at 3 entries of headroom: L-151 (zero outside citations, closed-out
tooling gotcha with its own pre-existing standing guard spec).

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

Seventh pass, same batch: L-186 (tooling, layout.tsx named re-export — candidate from the
code-map catch-up session) folded in. Archived one more to keep the register at 3 entries of
headroom: L-138 (zero outside citations, closed-out review-round lesson with its own standing
regression guard).

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

Eighth pass, same batch: L-187 (TOCTOU slot booking) and L-188 (token transport) folded in from
the demo-booking lane. Archived two more to keep the register at 3 entries of headroom: L-123
(1 outside citation, closed-out with a real regression-test guard) and L-139 (2 outside
citations, closed-out with its own post-init assertion guard).

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

## Archived 2026-09-17 — headroom for L-189 (B466 bookkeeping follow-up, #834)

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

## Archived 2026-09-17 — headroom for L-190 (feature grants v2 bookkeeping follow-up, #825/#837/#838)

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

## Archived 2026-09-17 — headroom for L-192 (registry-hygiene bookkeeping, mobile-scan hunt filing)

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

## Archived 2026-09-17 — headroom for L-193 (registry-hygiene renumbering lesson)

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

## Archived 2026-09-17 — headroom for L-194 (preview_start worktree-binding lesson)

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

## Archived 2026-09-17 — headroom for L-195 (#862 revert near-miss lesson)

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

## Archived 2026-09-17 — headroom for L-196 (cap-mismatch bookkeeping)

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

## Archived 2026-09-17 — headroom for L-197 (bookkeeping ancestry-check guard)

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

## Archived 2026-09-18 — headroom for the #909 L-199 merge collision (bookkeeping-batch window-6)

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

## Archived 2026-09-18 — headroom for source-text-assertion lesson (bookkeeping-batch window-6)

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

## Archived 2026-09-18 — headroom for Lane D's L-199 fold-in (bookkeeping-batch window-5)

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

## Archived 2026-09-18 — headroom for Lane F's two lessons (bookkeeping-batch window-4)

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
- **Superseded by:** L-201 generalizes this exact root cause (stale point-in-time read of a
  shared, actively-written registry) beyond lesson-ids to bug-registry ids and any similar
  counter — archived here as redundant with it, not for lack of value.

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

## Archived 2026-09-18 — headroom for id-collision lesson (bookkeeping-batch window-4)

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

## Archived 2026-09-18 — headroom for L-199/L-200 (bookkeeping-batch window-3)

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
  under a genuine concurrent writer. Related [[L-114]]. (Archived 2026-09-22 to make room at
  cap — zero cross-references elsewhere in LESSONS.md/CLAUDE.md, and the guard is a standing,
  automated test isolation mechanism rather than a rule a session needs to recall by reading
  this prose.)

## Archived 2026-09-23 — headroom for L-176's third recurrence (B660 PR B bookkeeping)

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
  shape at every call site. (Archived 2026-09-23 to make room at cap — zero citations anywhere
  outside the register, and the guard is a permanent code fix plus a standing regression spec
  pinning the exact shape at both call sites, rather than a rule a session needs to recall by
  reading this prose.)

## Archived 2026-09-24 — headroom for L-216 (note --section silent loss, B840)

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
  (Archived 2026-09-25 to make room at cap: zero citations outside the register, and the guard is a standing regression spec, returns-refund.spec.ts, pinning the pooled pricing.)

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
  (Archived 2026-09-25 to make room at cap: zero citations outside the register, and the guard is a standing regression test, layout.plan-gate-boundary.test.tsx, pinning children absent while the gate resolves.)

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
  (Archived 2026-09-26 to make room at cap: zero or few citations outside the register, and the guard is the demo_booking_race_guard partial unique index plus a concurrent-insert regression test.)

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
  (Archived 2026-09-26 to make room at cap: zero or few citations outside the register, and the guard is the standing B466 suite in orders.service.spec.ts.)

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
  (Archived 2026-09-26 to make room at cap: zero or few citations outside the register, and the guard is the standing create-estimate.dto.spec.ts real-ValidationPipe pin.)

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
  (Archived 2026-09-26 to make room at cap: zero or few citations outside the register, and the guard is the standing nav-consistency.test.tsx structural render test.)

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
  (Archived 2026-09-24 to make room at cap: zero citations outside the register, and the guard is a
  standing regression test, demo-scheduler.test.tsx, pinning the fixed message for all three failure shapes.)

### L-211 · 2026-09-21 · process · A target named only in prose is not a target

- **Symptom:** a locally-intended Playwright mint (`npx playwright test --project=setup`) ran
  against PRODUCTION: operator and customer logged into the prod regression tenant, the seeded
  buyer 401'd three times. `failedLoginAttempts` on the local row read 0 — the request never
  arrived there.
- **Root cause:** `playwright.config.ts` and `auth.setup.ts` both read
  `process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production…"`. Unset means
  production. The instruction said "against the LOCAL stack" in prose; the env var was not in
  the command.
- **Lesson:** **A command that targets an environment must carry the target IN the command
  (`PLAYWRIGHT_BASE_URL=http://localhost:3001 npx …`), never in the sentence beside it. Where a
  config defaults to production on an unset variable, that default is the defect, not the
  operator — and any guard belongs on the RESOLVED URL, not on whether the variable is present.
  Before GO on a minted state, decode the file's origins and require the local host.**
- **Guard:** `scripts/local-env.mjs --e2e` sets the base URL itself and strips inherited
  `RAILWAY_*` (use it for local runs); #1127's buyer setup step gains a skip unless the resolved
  base URL is local. Propose: the setup project refuses to run against a `*.railway.app` host
  unless an explicit `PLAYWRIGHT_ALLOW_REMOTE=1` is set.

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

### L-175 · 2026-09-16 · tooling · shared dev host disk budget

- **Symptom:** the shared dev host's `C:` drive hit 0 bytes free, stalling every session with no
  warning until root-caused.
- **Root cause:** ~28 worktrees' `node_modules`/`.next` plus accumulated Docker/WSL/npm caches
  consumed the whole disk; nothing monitored free space before it hit zero.
- **Lesson:** **A shared dev host running N concurrent worktrees needs a disk-budget gate — warn
  below a threshold before launching more work, not after operations start failing.**
- **Guard:** none yet — propose a session-start hook warning at < 30 GB free.

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

### L-204 · 2026-09-18/22 · domain · B524 fix round — a new write path didn't inherit a sibling's cache-invalidation fix (recurred on the READ side: 2026-09-22, B698)

- **Symptom:** granting a prerequisite via `FeatureOverrideService.create()`/`.revoke()` then
  acting on the new requires check could read a stale snapshot and false-400 for up to 30s —
  those methods invalidated only their own override cache, never `FeatureResolverService`'s
  separate cache the new check reads.
- **Root cause:** `AddonService` already had this exact bug fixed (B509). B524 added the same
  requires check to a SECOND write path reading the same cache; a fix on one writer doesn't
  propagate to a sibling by analogy.
- **Lesson:** **When a new check reads a cache another writer is allowed to leave briefly
  stale, audit EVERY writer of that value for whether it already invalidates the SAME cache.**
- **Recurred on the READ side (B698, 2026-09-22):** B677 (#1199) made a boxed purchase-order
  line's stored `totalCost` exact (case cost x cases, one rounding) and stopped the FORM from
  re-multiplying pieces by the 4 dp per-piece cost. THREE readers kept doing exactly that (web `PODetailRow`,
  the mobile PO detail row+header, and the mobile LIST row's fallback), so 1,000 cases of 12 at
  $11.00 stored as $11,000.00 still displayed $11,000.40 one screen over. The fix swept the writers
  and the form; nobody grepped the readers. **A stored exact figure is READ, never rebuilt from its rounded
  components: when a fix makes a stored value exact, grep every site that derives the same value
  (`qty * unitCost`-shaped expressions across web AND mobile) and point each at the stored field,
  with the derivation only as a fallback for rows that have none.**
- **Guard:** `createFeatureOverride`/`revokeFeatureOverride` now call
  `EntitlementAuthority.invalidate(tenantId)`, mirroring B509;
  `platform-admin.controller.override-requires.spec.ts` pins both calls directly. B698:
  `resolveStoredPOLineAmounts` in web `purchase-orders-shared.ts` (stored total wins) and a
  rendered `PurchaseOrdersTab.test.tsx` case at the drift value, verified red on the old row.
- Attribution: candidate from Lane D (PR #913), originally filed as "L-199" from a stale local
  view of the register (already taken here); renumbered on fold-in.
  (Archived 2026-09-27 to make room at cap: standing spec guard named above, no citation outside the register that would break; whole and verbatim.)

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
  (Archived 2026-09-27 to make room at cap: standing spec guard named above, no citation outside the register that would break; whole and verbatim.)

### L-210 · 2026-09-21 · domain · One shared read poisons every consumer (B606)

- **Symptom:** a buyer saw $120 for a single pack of a $24 product on the catalog tile, product
  detail, variant row and favourites, and every new standing-order line inherited it — a 5x
  overcharge. Staff paths over-charged 10.7x on the same product.
- **Root cause:** `getCustomerPriceHistory` remembered the per-Case price of a unit-aware line
  (`unitLabel:"Case"`, 6 packs) against the product with no `unitLabel` filter. Every buyer price
  surface funnels through that one query, and `effectiveBuyerPrice` lets a remembered price
  ABOVE list win over the tier, so one poisoned row propagated to four UIs and a template writer.
- **Lesson:** **A single query that feeds customer-facing prices needs its own regression spec
  pinning what it must EXCLUDE — not just coverage of its callers. When a new line shape
  (unit-aware, boxed, upsell) is introduced, grep every `findMany` that reads `unitPrice` and ask
  whether the new shape's price is denominated the same way; if not, the filter goes in the
  query, not in each consumer.**
- **Guard:** `orders/price-history-unit-lines.spec.ts` (#1123) pins the `unitLabel: null`
  filter; `unit-line-writers.ast.spec.ts` classifies every writer. Propose: a read-only prod
  count (`unitLabel IS NOT NULL` on `OrderItem`/`InvoiceItem`) before any remediation script —
  it returned 0 here and made the planned remediation unnecessary.
  (Archived 2026-09-27 to make room at cap: standing spec guard named above, no citation outside the register that would break; whole and verbatim.)

### L-214 · 2026-09-22 · domain · a second quantity axis needs every writer AND every "already done" guard

- **Symptom:** a FULL credit note against a box-unaware regulated line reversed 5 of the 60 pieces
  it sold, leaving 55 phantom pieces on the tax filing per credited line. Net, qty and tax were all
  correct — only the piece axis was wrong — and a later invoice void never cleared the residue, so
  the rows stayed wrong permanently.
- **Root cause:** B661 moved the SALE row's `unitBasisQty` onto a PIECE axis while `qty` stayed in
  the line's own unit (boxes for a box-unaware line). `reverseCreditNoteEntries` kept booking the
  line-unit value into the piece column, so the two sides no longer cancelled. Compounding it, the
  "this line is already fully reversed, skip it" guard in `reverseInvoiceEntries` tested `qty`,
  `netSales` and `categoryTax` but NOT `unitBasisQty` — so the one operation that could have healed
  the residue was the operation that proved it invisible.
- **Lesson:** **When a row carries two quantity axes that mean different things, moving ONE reader
  or writer onto the new axis is never the whole change: sweep every OTHER writer that books a
  paired row into the same column, and widen every "nothing left to do" guard to test EVERY axis it
  guards. A guard that checks a subset of dimensions does not merely miss the bug — it makes the bug
  permanent, because it convinces the healing path there is nothing to heal.**
- **Same fix, second lesson (pro-rata source):** the replacement first took its pieces-per-unit
  ratio from an AGGREGATE over every SALE row of the order line, which silently averages rows
  written under different snapshots — a product repacked 12 -> 10 between the original write and a
  delivered-basis reconcile gave 11, so a 2-box partial credit booked -22 where the truth was -20.
  **A pro-rata ratio must be derived from the specific stored row being reversed, never from a sum
  across the parent entity's rows.** This class is near-invisible in testing because the CLOSING
  operation books the exact remaining and absorbs the difference, so the TOTAL always reconciles —
  the error only surfaces as period attribution, and only when a partial straddles a period
  boundary. Where a sibling path already pro-rates correctly
  (`reverseReturnEntries` off the live row's own ratio), match it rather than inventing a second
  derivation (cf. L-167).
- **Guard:** `regulated-ledger.service.spec.ts` pins the piece axis on the credit path (full credit
  closes to exactly 0 pieces, a partial pro-rates off the SALE row's own ratio, the second half
  leaves no residue) and pins that a line square on money but carrying a piece residue is NOT
  skipped by a void. When a fix breaks existing fixtures, verify each modelled a shape a real
  writer can produce before changing it — four here defaulted the two axes independently and modelled rows no writer emits, which is why
  changing them was correct; the justification is that the old assertion's AGGREGATE was the
  defect's own signature (qty netting to zero while pieces don't IS the legacy residue), not
  merely that the case looked unreachable. A mixed-pack reconcile case pins the ratio source.
  (Archived 2026-09-27 to make room at cap: standing spec guard named above, no citation outside the register that would break; whole and verbatim.)

### L-217 · 2026-09-25 · testing · a CAS/updateMany needs an executed real-DB proof of its SUCCESS path (B861)

- **Symptom:** a compare-and-set `updateMany({ where: { ...compoundUniqueKey, nextNumber } })` passed
  tsc and every unit mock, yet would have 500'd every second save of a configured row.
- **Root cause:** a spread compound-unique key escapes TypeScript's excess-property check, mocks accept
  any `where`, and only a real Prisma client rejects it ("Unknown argument"). The tests covered only
  the CAS refusal path, so the success path never ran against a real client.
- **Lesson:** **A CAS/updateMany (or any where/select/include) change needs an executed real-DB proof
  of its SUCCESS path, not only the refusal path. Build WhereInputs from plain columns, never a spread
  compound-unique key.**
- **Guard:** `numbering-continuity.db.spec.ts` "a save carrying the current expectedNextNumber updates
  the saved row" (cf. [[L-205]] on tests that cannot fail).
  (Archived 2026-09-27 to make room at cap: standing spec guard named above, no citation outside the register that would break; whole and verbatim.)

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
  (Archived 2026-09-27 to make room at cap: standing spec guard named above, no citation outside the register that would break; whole and verbatim.)

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
  (Archived 2026-09-26 to make room at cap: one citation, `scripts/campaign/bugs.mjs:4878`, a
  code comment that still resolves here; the guard is the standing merge-session re-measure
  ritual, unchanged by archiving the prose.)

### L-213 · 2026-09-21 · process · a batch merge script must re-read the board per merge, not per batch

- **Symptom:** two PRs (#1112, #1087) landed over a BLOCK/UNPROVEN verdict posted on the shared
  coordination issue minutes earlier, because the verdict was read once before a script merged ten
  PRs in a row.
- **Root cause:** the review-channel read was a per-batch precondition, so every merge after the
  first ran on a stale view of the channel. This is L-209 applied in code instead of by hand.
- **Lesson:** **The "read the shared review channel immediately before every merge" rule (L-209)
  binds each individual merge, not the batch — a loop that merges N PRs must re-read the channel
  N times.**
- **Guard:** the landing procedure re-reads the coordination issue (#938) immediately before each
  merge; no unattended batch merge loops.
  (Archived 2026-09-27 to make room at cap for L-235: 0 outside citations; the rule is the
  per-merge application of L-209, which stays active; guard = the landing procedure's re-read of
  #938 before each merge, unchanged by archiving the prose.)

### L-216 · 2026-09-24 · tooling · bugs.mjs note --section silently replaced record analysis (B840)

- **Symptom:** two registry reconciles and ~32 earlier notes wiped Summary/Root cause/Fix text in
  ~150 bug records; noticed only because a "notes-only" commit showed insertions == deletions.
- **Root cause:** `bugs.mjs note --section` REPLACES the section body; a verb named "note" reads
  as append, so every caller assumed it was additive. The first repair then matched sections with a
  multiline-flag regex whose `$` ended at the first line, restoring only first lines.
- **Lesson:** **A CLI verb named like an append ("note", "add", "log") that actually replaces is a
  silent-loss class: before any bulk run, check the verb on one record and read the diff. A bulk
  "additive" run must be pure insertions. Repair from history as the union of every version, and
  prove zero loss with a checker that does not share the repair's parser.**
- **Guard:** B840: `note` appends, overwrite needs `--replace`, pinned in the bugs self-test.

### L-220 · 2026-09-26 · domain · a money-ledger change needs every axis, every ordering, and a DB spec that calls the production writer (B662)

- **Symptom:** a ledger pro-rate fix was verified on one axis and one order of operations, and the DB spec booked the reversal by hand, so a LINE_UNIT under-reversal and a return, adjust, return drift survived review.
- **Root cause:** the proof re-derived the writer's behaviour instead of exercising it, so it could only agree with the author's model (cf. [[L-214]]).
- **Lesson:** **For a money-ledger change enumerate every axis the writer serves, test the interleaving permutations, and make the DB spec CALL the production writer, never re-book the rows by hand.**
- **Guard:** `regulated-ledger-price-correction.db.spec.ts` drives `reverseReturnEntries` and `correctSaleForPriceChange`; the master control reproduces the old wrong values.

### L-227 · 2026-09-27 · process · a ratchet row must be measured on the MERGED tree, not the branch (train A)

- **Symptom:** a branch passed the size ratchet at its own head, then failed it once master was merged in (a service 6220 lines against a 6217 cap, its spec 9377 against 9376), and in merge train A two branches carried different rows (6163 vs 6151) for the same file.
- **Root cause:** a ratchet row is a property of one file's line count, and the count moves with every merge into it; a number measured before the merge is a claim about a tree that will not exist.
- **Lesson:** **Set and verify every ratchet row on the merged tree at land time, with `wc -l` on the merged file. On a conflicting row take the lower of the two sides and never raise it; if the merge pushes a file over, extract first.**
- **Guard:** `size-ratchet.spec.ts` on the merged tree (train A: `invoices.service.ts` row set to 6124, the merged file's `wc -l`, below both sides). Cf. [[L-215]].

### L-229 · 2026-09-22 · domain · a pro-rata ratio must come from the specific row, never a sum (B661)

- **Symptom:** unfolded from L-214 (same B661 fix, same PR, same review) — the pro-rata ratio used
  to reverse a regulated line's pieces was first taken from an AGGREGATE over every SALE row of
  the order line. A product repacked 12 -> 10 between the original write and a delivered-basis
  reconcile gave a ratio of 11 (the average), so a 2-box partial credit booked -22 pieces where the
  truth, from that specific row's own 10-pack snapshot, was -20.
- **Root cause:** the fix reached for whatever quantity was conveniently in scope (a sum across the
  parent's rows) instead of the one row actually being reversed. Summing erases which pack snapshot
  applied to which piece.
- **Lesson:** **A pro-rata ratio must be derived from the specific stored row being reversed,
  never a sum across the parent entity's rows.** Near-invisible in testing: the CLOSING operation
  books the exact remaining and absorbs the difference, so the TOTAL always reconciles — the error
  only surfaces as filing-PERIOD attribution, and only when a partial straddles a boundary. Where a
  sibling path already pro-rates correctly (`reverseReturnEntries` off the live row's own ratio),
  match it rather than inventing a second derivation (cf. [[L-167]]).
- **Guard:** `regulated-ledger.service.spec.ts`'s mixed-pack reconcile case pins the ratio source.
  Related: [[L-214]].

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
  (Archived 2026-09-27 to make room at cap for L-240: one outside citation, a handoff note that
  still resolves here; guard = the landing-coordinator checklist, unchanged by archiving the
  prose; the sibling trap stays active as L-190.)

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
  (Archived 2026-09-28 to make room at cap for L-241: one outside citation, a roadmap deferred
  row that still resolves here; guard = #1221's default-lane pin, unchanged by archiving the prose.)

### L-218 · 2026-09-25 · testing · a red-proof that matches message TEXT can be vacuous (B861)

- **Symptom:** the red-proofs AB/AD passed on the OLD code, so they proved nothing about the fix.
- **Root cause:** they matched `/reload/`, which the pre-existing 409's message also contains, so the
  wrong error satisfied the assertion.
- **Lesson:** **Assert by error CLASS or code, never by message text another error can share. Run the
  proof against the old code and confirm it fails for the intended reason.**
- **Guard:** `REG-B861-AB`/`AD` assert `BadRequestException`.
  (Archived 2026-09-28 to make room at cap for L-242: one outside citation, a handoff note that
  still resolves here; guard = the REG-B861-AB/AD specs asserting BadRequestException, unchanged.)

### L-234 · 2026-09-27 · testing · a whole-database script needs an explicit scope allowlist, not a rerun (B824, train C)

- **Symptom:** `publish-and-repin.db.spec.ts` failed three different ways under `--maxWorkers=2` — an unrelated tenant tripped `--only-test-tenants`'s refusal, an unscoped `--apply --live` wrote onto a sibling spec's own fixture tenant, and this spec's fixture received unwanted writes back — each time green when run alone, so it read all night as "a known flake, verify alone before treating as a blocker."
- **Root cause:** `publish-and-repin.mjs`'s `computeDiff()` correctly scans the WHOLE database for a real prod run, but under parallel jest workers it also picks up sibling `*.db.spec.ts` files' own live fixture tenants — real cross-suite contamination, not a stale-count race a retry masks. Running it alone "fixes" all three by removing the siblings, which is exactly why that green is not a safety signal.
- **Lesson:** **A `*.db.spec.ts` (or script) that computes a diff/apply, or any read+write, over a shared, unscoped table under parallel workers must scope every call to its own fixture rows (an id/slug allowlist flag on the tool it drives). "Green alone, red in the full lane" for such a spec means look for a missing scope, not a flake to rerun past.**
- **Guard:** `publish-and-repin.mjs --only-tenants <slugs>`; `publish-and-repin.db.spec.ts`'s `runCli()` passes its own 3 fixture slugs on every call (report, preview, live apply).
  (Archived 2026-09-29 whole and verbatim to make room at cap for L-244..L-248: zero or one outside
  citation and a shipped guard named in the entry; lead-directed, #2731's compaction still pending.)

### L-233 · 2026-09-27 · security · a role check is not an ownership check (#2386, SA-429, train B)

- **Symptom:** the DRIVER branch of `updateOrderItems` checked only `role === "DRIVER"` — any driver in the tenant could edit any order's items, not just orders on their own active run.
- **Root cause:** the branch was written assuming the role check was the whole authorization decision; no assignment/ownership predicate existed at all, and the gap is easy to miss because the code "looks done" (it correctly 403s the wrong role, just not the wrong instance).
- **Lesson:** **For a tenant-scoped, role-gated write path, "the role is correct" and "this principal is entitled to touch this specific resource" are two separate checks. A new role-gated branch needs an explicit resource-ownership assertion — re-derived from the resource's own foreign-key chain, never a denormalized shortcut field — written and tested as its own predicate, run before any other guard AND re-checked under the row lock.**
- **Guard:** `orders/driver-edit-access.ts`'s `assertDriverMayEditOrder` (follows `order.routeRunStopId → RouteRunStop → RouteRun`, never `order.routeRunId` directly); called first in `updateOrderItems`, before the cancelled-order check, and again under the Order `FOR UPDATE`. `driver-edit-access.spec.ts`, `driver-edit-access.db.spec.ts`.
- **Recurred 2026-09-27 (train D, #2398/#2391, SA-434):** the SAME predicate was missing (or independently reinvented weaker) at two MORE call sites reachable by the DRIVER role: `orders.service.ts`'s `changeStatus()` had no check at all, and `change-requests.service.ts`'s `resolve()` checked only `order.routeRun.driverId` with no run/stop status. The fix reused `assertDriverMayEditOrder` verbatim rather than writing a third bespoke check. Confirms the lesson generalizes beyond the one endpoint it was first found on: audit EVERY role-gated write path reachable by the same role, not just the one a report named.
  (Archived 2026-09-29 whole and verbatim to make room at cap for L-244..L-248: zero or one outside
  citation and a shipped guard named in the entry; lead-directed, #2731's compaction still pending.)

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
  (Archived 2026-09-29 whole and verbatim to make room at cap for L-244..L-248: zero or one outside
  citation and a shipped guard named in the entry; lead-directed, #2731's compaction still pending.)

### L-232 · 2026-09-27 · domain · a calendar-day field keeps the client's literal day, never a re-derived one (#2249, train B)

- **Symptom:** `invoices.service.ts` stored `new Date(dto.issueDate)` raw, so a client datetime with a time component or offset crossing a UTC day boundary (e.g. `23:30-04:00`) silently landed one day later — breaking the UTC-midnight symbolic convention that statements, the regulated report and sales-facts buckets all assume.
- **Root cause:** the field is a day-granular calendar stamp, not a real instant, but the write path treated the client's string as an instant and let the day move with it. An earlier version made it worse by re-reading in the tenant timezone.
- **Lesson:** **A DTO field documented or consumed as a calendar day (statements, invoices, schedules) must be normalized at the write boundary through a literal first-10-characters day extractor — never `new Date(rawString)` directly, and never re-derived from a timezone. A shape that names no real day is a 400, checked before anything else is read.**
- **Guard:** `common/calendar-date.ts`'s `calendarStampFromInput`/`issueDateStamp`, called as `InvoicesService.create()`'s first statement; `calendar-date.pins.spec.ts`, `invoice-issue-date-b2197.db.spec.ts`. Cf. the F25 calendar-date convention (archived L-047) — this is the same house rule recurring at a new call site.
  (Archived 2026-09-29 whole and verbatim to make room at cap for L-244..L-248: zero or one outside
  citation and a shipped guard named in the entry; lead-directed, #2731's compaction still pending.)

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
  (Archived 2026-09-29 whole and verbatim to make room at cap for L-244..L-248: zero or one outside
  citation and a shipped guard named in the entry; lead-directed, #2731's compaction still pending.)

## Archived 2026-09-30 — headroom for L-249 (windows 9+11 bookkeeping)

### L-219 · 2026-09-26 · security · judge a DB-target guard by how the DRIVER parses the URL (D-03)

- **Symptom:** a local-only DB guard checked `new URL(url).hostname`, so `…@localhost/x?host=prod` passed the guard while the pg driver dialled prod.
- **Root cause:** the guard and the driver parsed the same string differently (`?host=`, `hostaddr`, `service`, multi-host lists, sockets, an encoded `?` in the database name).
- **Lesson:** **A safety guard on a connection string must parse it the way the DRIVER does (pg-connection-string), then dial the vetted explicit fields, never the raw string it just approved.**
- **Guard:** `scripts/lib/local-db-target.cjs` and its bypass-list spec (`local-db-target.spec.ts`).
  (Archived 2026-09-30 whole and verbatim to make room at cap for L-249: zero outside citations and a
  shipped guard named in the entry; landing-coordinator bookkeeping, lead-directed.)

## Archived 2026-10-01 — headroom for L-251..L-253 (lessons PR)

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

### L-221 · 2026-09-26 · domain · retry a whole idempotent tx on a conflict through ONE shared predicate (SA-269)

- **Symptom:** none observed in production: a design rule set by SA-269/SA-340 when #2152 added a transaction retry, so callers would not each invent their own conflict test.
- **Root cause (of the risk):** the conflict shapes differ across Prisma and pg (40001, 40P01 in every Prisma/pg shape, P2034, TransactionWriteConflict), so a per-caller classifier matches a subset or retries a business error.
- **Lesson:** **Retry the WHOLE transaction (each attempt re-takes its first lock) on a write conflict, classified by one shared predicate (`common/tx-retry` `txConflictState`). An HttpException is never a conflict.**
- **Guard:** `REG-SA269-1/2/3` in the tx-retry specs.

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
  (Archived 2026-10-01 whole and verbatim to make room at cap: L-238 has one outside citation that still resolves and its guard specs; L-221 is guarded by REG-SA269-1/2/3; L-235 is guarded by check-types-ratchet.mjs; landing-coordinator bookkeeping, lead-directed.)
  (Archived 2026-10-02 whole and verbatim to make room at cap: L-236 is guarded by products/product-image-keys.ts and its spec, L-245 by scripts/lint-migrations.mjs, L-249 by import-invoice-money-2190.spec.ts; all three had zero outside citations; landing-coordinator bookkeeping, lead-directed.)
  (Archived 2026-10-02 whole and verbatim to make room at cap: L-248 is guarded by round4 in packages/pricing with golden.spec.ts and component-price.spec.ts, L-237 by common/after-commit.ts, after-commit.spec.ts and the emit-after-commit tripwire; one and two outside citations that still resolve; landing-coordinator bookkeeping, lead-directed.)

### L-251 · 2026-10-01 · domain · dropping a double-counted term means re-proving every remaining bound covers DERIVED inputs (B960, #2986)

- **Symptom:** once the order pool became the one source for itemless refund lumps, `create()`'s own-invoice line check still ran the per-invoice legacy term and over-refused; skipping it exposed that the qty bound applied only to rows where the operator TYPED a qty, so an amount-only credit row (derived qty) escaped the product's pieces cap when lines of one product carried different prices.
- **Root cause:** the removed term had been covering the derived-qty case implicitly; the bound that remained keyed on "explicit qty".
- **Lesson:** **When you remove one term to stop a double-count, list every input the old term bounded and re-prove that each remaining bound covers DERIVED inputs too (amount-only rows, defaults, unit conversions), not just typed ones; bind qty always, on the one unit axis.**
- **Guard:** `credit-notes/own-line-pool-b960.spec.ts` (skip-legacy with the pool active, derived qty binds in pieces); cf. [[L-167]], [[L-222]].

### L-252 · 2026-10-01 · testing · a test of host-dependent behaviour proves the host condition and asserts what the host cannot change (B954, B950)

- **Symptom:** a PDF date spec was red on the UTC CI runner but green on a west-of-UTC dev host (its own vacuity guard "the host is west of UTC" caught it); a webhook flood spec asserted every client read a 401 and failed deterministically on macOS, where some clients saw EPIPE or ECONNRESET.
- **Root cause:** both asserted an observation the host controls: V8 caches the process timezone at first Date use, so setting `process.env.TZ` inside a Jest worker is unreliable; whether a client reads a response from a socket the server closed first is OS- and timing-dependent.
- **Lesson:** **Run the host-dependent code in a CHILD process with the environment set (`TZ`) and keep a vacuity guard that proves the condition. For network security and resource properties assert on the SERVER (status sent, handler work run, bytes read) and count a client reset after an early response as a rejection; never require a client to read a response from a connection the server closed first. A spy keyed on `socket.localPort` misses responses on destroyed sockets; key on `server.address().port`.**
- **Guard:** `common/pdf-date.spec.ts` (child process, `TZ=America/Los_Angeles`, vacuity guard); `apps/control/test/wp7-security.spec.ts` (server-side spy, forced-reset test, over-cap test, mutation-proven).
  (Archived 2026-10-04 whole and verbatim to make room at cap: L-251 is guarded by credit-notes/own-line-pool-b960.spec.ts, L-252 by common/pdf-date.spec.ts and its child-process vacuity guard; each had one outside citation (the register's own _meta.json note) that still resolves; window 1 bookkeeping.)

### L-253 · 2026-10-01 · process · a public CI window closes on state, never on a reply (a lead restart stranded one)

- **Symptom:** the lead session restarted mid-window (17:22Z to 17:50Z) and the repo stayed public until the coordinator flipped it about five minutes before the watchdog's deadline, because the close routine was waiting for the lead's go.
- **Root cause:** closing a window was gated on a reply instead of on the watchdog deadline and the deploy state.
- **Lesson:** **The window owner starts the watchdog FIRST and closes on state: flip PRIVATE when the deploys are SUCCESS, or about five minutes before the deadline even if a deploy is still building (Railway keeps deploying privately), read the visibility back, then report. A lead outage neither extends nor blocks the close.**
- **Guard:** `scripts/visibility-watchdog.mjs` (flips private at its deadline with verified retries); the lead's 2026-10-01 rule (flip at about deadline minus five minutes and keep watching the deploy).

### L-255 · 2026-10-02 · tooling · a file on the size ratchet is checked by the api ratchet spec before every push that grows it, in any workspace

- **Symptom:** #2865's first Verify went red in a public window: `size-ratchet.spec.ts` reported `apps/mobile/components/NewOrderScreen.tsx` at 2637 lines (baseline 2560 + 25 headroom = 2585, +52 over). The window landed nothing; the extraction shipped as a re-pin (2535 lines).
- **Root cause:** the ratchet lives in the API workspace but caps web and mobile files too, so a mobile- or web-only local check never runs it.
- **Lesson:** **Before pushing a change that grows a ratcheted file, run `cd apps/api && npx jest -c jest.repo-truth.config.js size-ratchet` (or `npm run test:repo-truth -w apps/api`; a plain `npx jest` finds no tests, the spec is in the repo-truth config) or the full `npm run verify` and extract the new code into its own module in the same PR; never raise a baseline without the owner. Cf. [[L-215]], [[L-227]].**
- **Guard:** `apps/api/src/common/size-ratchet.spec.ts`, run by CI in the api `test:repo-truth` step.

### L-256 · 2026-10-02 · tooling · a master merge commit goes through lint-staged and reformats master's own files

- **Symptom:** finishing a conflicted merge of master into a PR branch with a plain `git commit` ran `prettier --write` over the staged files that came from master, so about 30 files that are not the PR's (handoff notes, `LEAD-LOG.md`, a data file) landed in the PR; the author compared two file lists of 57 and never compared 57 to the PR's own 27.
- **Root cause:** lint-staged formats every staged file, and in a merge commit master's files are staged too.
- **Lesson:** **Finish a conflicted merge by `git add`-ing ONLY the conflicted files, and after any master merge compare `git diff --name-only <master-parent> HEAD | wc -l` with the PR's own count (own set = `git diff --name-only <old-base> <pre-merge-tip>`). Restoring from the master parent is the repair, and a plain commit re-runs prettier and undoes it. Hand-kept notes are listed in `.prettierignore` (#3055).**
- **Guard:** `.prettierignore` (#3055, hand-kept notes and generated files); the file-count comparison.
  (Archived 2026-10-05 whole and verbatim to make room at cap: L-253 is guarded by scripts/visibility-watchdog.mjs, L-255 by apps/api/src/common/size-ratchet.spec.ts, L-256 by .prettierignore; each had zero outside citations.)

### L-259 · 2026-10-04 · security · a guard and the write it protects share ONE normalized value; one allowlist drives every copy of a field set (#3191, #3190)

- **Symptom:** an admin-protection check compared the raw request value while the stored value was normalized (trim, case), so a padded or re-cased value slipped past the guard yet wrote the same account, or a harmless edit was refused. Separately, a customer-facing write body and its read filter each kept a hand-typed field list that drifted apart.
- **Root cause:** the guard, the changed-field test and the write each normalized (or did not) on their own. Two hand lists of the same fields are two sources of truth; patching one list left the other open.
- **Lesson:** **Normalize an identity input once, then feed that single value to the guard, the changed-field comparison, the write and every side effect. Derive a field-restricted DTO and its read filter from one allowlist const (PickType over it), never a second list.**
- **Guard:** `customers/customers.self-service-allowlist.spec.ts` (body type and filter both from `SELF_SERVICE_FIELDS`) and the users service specs for #3191; the normalization lives in one block in `users.service.ts`.
  (Archived 2026-10-05 whole and verbatim to make room at cap: L-259 is guarded by customers/customers.self-service-allowlist.spec.ts and the users service specs, with no citation outside the code-map bookkeeping.)

### L-261 · 2026-10-05 · deploy · the API never value-imports `@routeflow/types`: its runtime constants are API literals pinned by a parity spec (#3199)

- **Symptom:** #3199 needed the fleet module keys the web already shares; the obvious `import { FLEET_MODULE_KEYS } from "@routeflow/types"` type-checks and passes ts-jest, yet `node dist/main.js` cannot load the raw TypeScript entry and the whole API would fail to boot.
- **Root cause:** `@routeflow/types` ships `.ts` with no build step and `nest build` does not bundle workspace packages, so a value import emits a runtime `require` that only production boot exercises; the green tsc and ts-jest runs are what make the shortcut look safe.
- **Lesson:** **In `apps/api` use `import type` from `@routeflow/types` only. A constant the API needs at runtime is its own literal in `apps/api/src`, set-equal-pinned to the shared one by a parity spec (`FLEET_KEYS` against `FLEET_MODULE_KEYS`); a new shared constant ships with its parity spec or not at all.**
- **Guard:** `apps/api/src/common/no-runtime-workspace-imports.spec.ts` (fails on any value import, require or dynamic import of the package) and `apps/api/src/billing/fleet-keys-parity.spec.ts`.
  (Archived 2026-10-06 whole and verbatim to make room at cap: L-261 is guarded by apps/api/src/common/no-runtime-workspace-imports.spec.ts and apps/api/src/billing/fleet-keys-parity.spec.ts, with no citation outside the code-map bookkeeping.)

### L-260 · 2026-10-04 · domain · a missing stored money value is "not provable", never a fabricated 0 (B1030, #3135)

- **Symptom:** an invoice edit could store a discount above the subtotal (a negative total). The first guard exempted "legacy" rows by comparing against stored totals, and a row with missing totals read as 0 and was exempted too.
- **Root cause:** the not-worse legacy exemption coerced an absent subtotal or total to 0, so unknown old state looked like a provably insane one and the edit passed.
- **Lesson:** **When a rule is relaxed by comparing to the stored value, a missing or non-numeric stored value returns "unknown" (undefined) and the check runs strictly; coercing it to 0 turns the relaxation into a bypass. An absent optional amount (discount) may default to 0; an absent required one may not.**
- **Guard:** `storedInvoiceTotals` returns undefined for missing or non-finite totals; pinned by the money-invariants util spec and the invoices update specs (#3135).
  (Archived 2026-10-06 whole and verbatim to make room at cap: L-260 is guarded by apps/api/src/common/money-invariants.util.spec.ts (storedInvoiceTotals) and the invoices update specs, with no citation outside the code-map bookkeeping.)

### L-242 · 2026-09-28 · domain · never key a UI draft or map by a nullable id (B889, #2709)

- **Symptom:** mobile buyer edit-items keyed its draft by `productId`. The seller's custom lines
  (`productId` null) collapsed into one "Product" row, and Save sent `productId: null`, which the
  server silently ignored.
- **Root cause:** a draft keyed by a nullable id: every null collides on one key, and the null class
  is not a real member of the keyed set.
- **Lesson:** **Never key a UI draft or map by a nullable id. Key on the non-null identity and skip or
  segregate the null class explicitly, mirroring web's established filter and the server's own
  definition (`isUnlisted = !productId`).**
- **Guard:** #2709's pins in `apps/mobile/__tests__/buyer-edit-items-custom-lines.test.ts`
  (`isCustomLine` skips seller custom lines in `hydrateBuyerDraft`).
  (Archived 2026-10-06 whole and verbatim to make room at cap: L-242 is guarded by apps/mobile/__tests__/buyer-edit-items-custom-lines.test.ts (isCustomLine in hydrateBuyerDraft), with no citation outside the code-map and bug-history bookkeeping.)

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
  (Archived 2026-10-07 whole and verbatim to make room at cap: L-143 is guarded by the shared `@routeflow/pricing` payment predicates that api, web and mobile import; least-cited and fully guarded.)

### L-263 · 2026-10-05 · tooling · a plain `npm ci` rewrites the SHARED `core.hooksPath`, silently switching off hooks in other worktrees (#3199)

- **Symptom:** after a worktree ran `npm ci`, a push from another worktree ran no pre-push verify at all and #3199 went out unverified; nothing printed, git treats a missing hooks directory as "no hooks".
- **Root cause:** `prepare` runs `husky`, which sets `core.hooksPath = .husky/_` (relative) in the one repo config every worktree shares; a worktree without its own `.husky/_` then has no hooks, instead of the absolute fleet shim. A one-time restore at session start does not hold: any later `npm ci` in any worktree resets it.
- **Lesson:** **Install a worktree with `npm ci --ignore-scripts` and build `packages/*` by hand; after ANY `npm ci` or `npx husky`, and before every push, run `git config core.hooksPath` and restore the absolute shim (`git config core.hooksPath <main checkout>/.git/husky-shim/_`) if it reads `.husky/_`. A push that printed no verify output did not verify.**
- **Guard:** `scripts/check-git-hooks.mjs` (the SessionStart `--warn` line and the first step of `npm run verify`); the fleet shim of [[L-254]].
  (Archived 2026-10-07 whole and verbatim to make room at cap: L-263 is guarded by `scripts/check-git-hooks.mjs` (the SessionStart `--warn` line and the first step of `npm run verify`); least-cited and fully guarded.)


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
- **Recurred 2026-10-03:** a reviewer's `cmd /c rmdir` of its `node_modules` junction was blocked by the harness, and the following plain `git worktree remove` still deleted THROUGH the junction, emptying the builder's live install (restored with `npm ci`). If a junction cannot be removed, NEVER remove the worktree: leave it and report the path. Better, reviewers do not junction into a builder's live install at all.
- **Guard:** still none automated after two incidents — the proposed pre-remove check (refusing
  `git worktree remove` while a junction exists under the tree, or a post-move check comparing a
  junction's target to cwd) has not been built either time. Interim guard until it is: reviewer
  agent prompts/instructions carry the read-only, no-worktree rule explicitly. Recovery from a
  hit: `git ls-files --deleted -z -- <dirs> | xargs -0 git restore --`, then confirm
  `git ls-files --deleted` is empty and diff clean before resuming any work in that checkout.
  (Archived 2026-10-07 whole and verbatim to make room at cap: L-180 is fully guarded (still none automated after two incidents — the proposed pre-remove check (refusing   `git worktree remove` while a junction exists under the...); least-cited.)

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
  (Archived 2026-10-07 whole and verbatim to make room at cap: L-206 is fully guarded (`docs-truth.spec.ts` now reads `_meta.json.maxBytes` dynamically (#889); no repo-wide   grep-for-pinned-literals check exists — propose one...); least-cited.)

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
  (Archived 2026-10-07 whole and verbatim to make room at cap: L-124 is fully guarded (`REG-B323` — a dedicated unscoped groupBy on null tenantId runs alongside the main   query and counts every null-tenant customer regardless...); least-cited.)

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
  (Archived 2026-10-07 whole and verbatim to make room at cap: L-195 is fully guarded (the merge session's live post-deploy verification caught this one, plus the   pre-existing e2e T13 opacity assertion. Propose: the landing t...); least-cited.)

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
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-212 is fully guarded (#1133 (b8765689) added `data-testid="line-total"`; spec 13's `readLineTotal` reads it via `getByTestId`.) and is among the least-cited active entries.)

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
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-209 is fully guarded (landing-coordinator routine step "read the coordination issue for REVIEW lines on this PR" before each merge (no code guard).) and is among the least-cited active entries.)

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
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-170 is fully guarded (`invoices.service.ts`'s two `balanceDue` sites and the PDF template now wrap in `roundMoney()` before the comparison. Also fixed at `customers.service.ts`'s `applyAdvancePaymentToInvoiceLocked` (#814)) and is among the least-cited active entries.)

### L-241 · 2026-09-28 · process · text with backticks goes through a quoted heredoc to a file, never an unquoted heredoc or --body "…" (#2707)

- **Symptom:** a lane wrote a PR body through an unquoted heredoc (`<<EOF`). The shell ran the
  backticked commands in the text, including an owner-only `railway run … audit-tenant-entitlements.mjs`,
  which was stopped only by a missing CLI on that machine (MacBook, #2707; no damage).
- **Root cause:** shell command substitution runs inside an unquoted heredoc and inside a
  double-quoted `--body "…"`, so any backticked command in prose is executed, not quoted.
- **Lesson:** **Any PR, board or brief text that contains backticks is written with a QUOTED heredoc
  (`<<'EOF'`) or the file-write tool to a file, then passed as `--body-file` / `gh … -F body=@file`.
  Never interpolate such text into a command line.**
- **Guard:** the lane brief rule (write bodies to a file first); production commands are owner-run on
  the Mac mini only, with no railway CLI or link on the MacBook.
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-241 is fully guarded (the lane brief rule (write bodies to a file first); production commands are owner-run on the Mac mini only, with no railway CLI or link on the MacBook.) and is among the least-cited active entries.)

### L-222 · 2026-09-26 · domain · a line's unitPrice and unitsPerBox are ONE denomination (SA-330)

- **Symptom:** a rolled-over next-delivery line was split and priced at the LIVE product pack, so after a repack it was re-split and re-priced from the source line.
- **Root cause:** the copy carried the price without its pack, or the pack without its price; a live price converted to an old pack is a second pricing formula.
- **Lesson:** **When a line is copied, snapshot BOTH unitPrice and unitsPerBox or neither. Carrying the pack with a live price under-bills after a repack; converting a live price to an old pack is refused.**
- **Guard:** `next-delivery-pack.db.spec.ts` (a repack with a price change, plus an AT_STOP vs NEXT_DELIVERY parity pin).
- **Recurrence (2026-09-30, #2781):** the PO receive path read the LIVE product pack while the detail
  screen used `linePack`; web modal, mobile form and API now all resolve the stored pack through `linePack`.
- **Recurrence (2026-10-01, B965/B967/B969, #2988):** every quantity crossing a money door carries its unit axis (boxes, pieces, or the order line's own unit); mixed pack factors are converted ONCE at the boundary with one shared helper (`standardReturnPieces` / `poolPieces` / `toPiecesPool`) or refused (`RETURN_MIXED_UNIT_PRODUCT`), never summed raw (30 pieces on a 2-box x 12 plus a 12-piece line refunded $300 instead of $250; a box-unaware line under-refunds by the pack).
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-222 is fully guarded (`next-delivery-pack.db.spec.ts` (a repack with a price change, plus an AT_STOP vs NEXT_DELIVERY parity pin).) and is among the least-cited active entries.)

### L-228 · 2026-09-27 · process · a merge train must leave master's tree equal to the tree that was verified (train A)

- **Symptom:** a train of 14 PRs merged `--no-ff` and verified as one head (tree e98a41e8) was landed as a single squash; nothing but a deliberate check said the squash equalled what had been tested.
- **Root cause:** a squash-merge builds its own tree from the PR diff against the current base, so anything that moved on master after the train was built (or a hand-resolved conflict) changes what lands without changing what was verified.
- **Lesson:** **Land a train only after its head is verified and any hand hunk (import unions, ratchet rows) is confirmed against the merge-tree; after the squash, compare `git rev-parse origin/master^{tree}` with the verified tree and stop on any difference.**
- **Guard:** the train PR body states the expected tree; the landing coordinator runs the comparison (train A: master's tree equals e98a41e8, checked). Dropped PRs are named with their reason so they re-enter the next train. Cf. [[L-197]].
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-228: superseded by L-268 (the train is built off master and landed by rebase-merge, so master equals the verified tree) and guarded by the landing coordinator tree comparison.)

### L-246 · 2026-09-29 · process · a code-map stamp never goes inside a PR that gets squashed

- **Symptom:** a code-map `mappedSha` (or a sha in a landing bullet) written inside a PR that was then
  squash-merged named a commit that never reached master, so the map read as stale from the moment it
  landed and its cited sha resolved to nothing.
- **Root cause:** a squash merge replaces the branch's commits with one new commit; any sha a PR
  records about itself, or about its own branch, does not exist on master afterwards.
- **Lesson:** **Stamp `mappedSha` and cite shas only from the docs follow-up PR, and only shas that are
  already on master (the squash commit). Never write the PR's own head or a branch sha into the map.**
- **Guard:** Bookkeeping Option B (the code PR carries `Bookkeeping-Follow-Up: pending`; the follow-up
  cites the merged sha). No script yet: propose `git merge-base --is-ancestor <sha> origin/master`
  before any stamp.
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-246: fully guarded by Bookkeeping Option B (the code PR carries `Bookkeeping-Follow-Up: pending` and the follow-up cites the merged sha), which is a standing rule in CLAUDE.md.)

### L-240 · 2026-09-27 · process · a board issue has a 2,500-comment cap; roll to a successor at ~2,300

- **Symptom:** the review board of record (#938) reached GitHub's 2,500-comment limit mid-window,
  and commenting on it was disabled. PASS verdicts and gate messages had nowhere to go until a
  successor (#2554) was opened, pinned and pointed at from every skill and script that named #938.
- **Root cause:** the board was a single ever-growing issue, and nothing tracked its comment count
  against GitHub's hard limit. The number was hardcoded in skills and in `fleet-status.mjs`.
- **Lesson:** **A long-lived coordination issue is a capped resource: GitHub stops accepting
  comments at 2,500. Watch the count and roll to a pinned successor at ~2,300, before the cap. Name
  the live board in one place (a constant or config) and have skills point at it; leave the old
  issue's comment links as history.**
- **Guard:** `fleet-lead/scripts/fleet-status.mjs` reads the board from one `BOARD_ISSUE` constant
  (env `FLEET_BOARD_ISSUE`), and `fleet-lead/SKILL.md` names #2554 as the live board. Proposed:
  `fleet-status.mjs` prints the board's comment count and warns at 2,300.
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-240: guarded by `fleet-lead/scripts/fleet-status.mjs` (one `BOARD_ISSUE` constant) and `fleet-lead/SKILL.md`, which names the live board.)

### L-244 · 2026-09-29 · process · a merge reads every ruling posted after the last PASS, not only the PASS (#2678)

- **Symptom:** #2678 landed on a PASS that predated a binding fold ruling (SA-551a, #2554
  5867986094); the fold it required never shipped.
- **Root cause:** the merge decision read the PR's last PASS and stopped, so a later ruling on the
  same PR (a fold, HOLD or FAIL) was invisible to it.
- **Lesson:** **A PASS is only current until the next comment that names the PR. Before a merge, list
  every board comment that names the PR and was posted after its last PASS; an open fold, HOLD or
  FAIL blocks the merge.**
- **Guard:** the coordinator's pre-merge step (fleet-lead log entry 2026-09-29 #2678); no script yet.
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-244: guarded by the coordinator's standing pre-merge step (list every board comment that names the PR after its last PASS), recorded in `.claude/skills/fleet-lead/references/LEAD-LOG.md`.)

### L-271 · 2026-10-07 · process · a train of several PRs runs check-types and every PR's specs on the combined tree before the push

- **Symptom:** squashing several PRs into one train, a later PR's guard spec failed because an earlier PR had added a new file the guard now covered; no single PR was red on its own.
- **Root cause:** each PR was verified alone against its own base, so a cross-PR interaction (a new file meeting another PR's guard or type) was invisible until the combined tree.
- **Lesson:** **Before pushing a train, run `check-types` and the specs of EVERY PR in the train on the combined tree, not only the last PR's; a later PR's guard can be violated by an earlier PR's new file.**
- **Guard:** the train's pre-push list names each PR's guard specs and `npm run check-types`; cf. [[L-228]], [[L-268]].
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-271: superseded by L-268 (the train is verified as ONE tree, with check-types and the specs run on the exact landing tree).)

### L-226 · 2026-09-27 · testing · a money fixture must be shaped by the production writer (#2274, #2245, #2305)

- **Symptom:** ledger and unit-line specs built rows by hand in shapes the writer never produces (credit overshoot legs the per-line and header caps would refuse; quantities not in base pieces), so they proved a state that cannot exist and could miss the one the writer can.
- **Root cause:** a hand-built fixture encodes the author's model of the writer, not the writer's output; the spec can only agree with the model (cf. [[L-220]]).
- **Lesson:** **Build every money or unit fixture with the production writer (or copy its exact shape: base-piece qty, `net + tax` amounts, the maps it stores). Before asserting an overshoot or edge state, confirm the writer can reach it; if only a downstream clamp stops it, test that clamp.**
- **Guard:** review checks each fixture against the writer's call site (train A: `credit-notes.service.ts` caps, `returns.service.ts` return maps); `regulated-ledger-price-correction.db.spec.ts` drives the real writers.
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-226: guarded by `regulated-ledger-price-correction.db.spec.ts`, which drives the real writers, plus the writer-shaped fixtures in `line-composition.spec.ts`.)

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
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-119: guarded by REG-B305 round 4 and the source pin `short-pick-category-tax.pins.test.ts`, and the independent pre-merge pass is now the standing `pre-merge-review` gate.)

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
  (Archived 2026-10-08 whole and verbatim to make room at cap: L-159: guarded by the red-first regression tests on `resolveConfirmedAmounts` in `packages/pricing/src/payment-confirmation.spec.ts` (the double-subtraction case) and its web mirror.)

### L-268 · 2026-10-06 · process · a merge train is built off master, verified as ONE tree, and rebase-merged so master equals the verified tree (W13 to W16)

- **Symptom:** landing N ready PRs one by one made each PR re-run CI against a moving master (the L-266 re-run for every PR), and a squash built its own tree, so what landed was never the tree that had been tested.
- **Root cause:** serial landing re-verifies every PR N times against a different base, and a squash-merge rebuilds the diff against the current base, so the verified tree and the landed tree can differ ([[L-228]]).
- **Lesson:** **Build `train/wNN` off master; per PR run `git merge --squash <exact sha>` and commit "<PR title> (#N)", asserting each commit's tree equals `git merge-tree --write-tree HEAD <sha>`. Run ONE CI on the exact landing tree (plus the DB lane on that tree when DB code is touched) and pass the bug-hunt gate (scan-signatures and the lead's cross-PR hunt) before merging. REBASE-merge the train PR, then `git diff train origin/master` must be empty; close the originals naming their master commits.**
- **Guard:** the train PR body states the expected tree and the empty diff is checked after the merge; a red run drops the culprit PR (its per-PR run names it), rebuilds and re-runs once. Cf. [[L-228]], [[L-266]].
  (Archived 2026-10-09 whole and verbatim to make room at cap: L-268: superseded by L-288 (trains merge with a merge commit, not rebase-merge); the empty-diff proof lives on in L-288's Guard.)

### L-279 · 2026-10-08 · testing · an undecorated DTO field is an own `undefined` key under ES2023 and the global pipe refuses it (B1224)

- **Symptom:** the New sale screen could not save: every `POST /orders/sell` returned 400 "property idempotencyKey should not exist", although the client never sends that field. Unit specs were green because they called the service and never ran the DTO through the pipe.
- **Root cause:** the api compiles to ES2023 (class-field define semantics), so an undecorated `idempotencyKey?: string;` is emitted as an own `undefined` property on every class-transformer instance, and the global `ValidationPipe` (`whitelist` plus `forbidNonWhitelisted`) rejects a key without a validator.
- **Lesson:** **A DTO property that carries no validator (an internal field the server sets in code) must be written `declare x?: T;` so no own key is emitted. Prove a new or changed DTO through the real global pipe options, not only through the service, and keep one guard that instantiates every exported DTO from `{}`.**
- **Guard:** `apps/api/src/common/dto-no-own-undefined-keys.guard.spec.ts` (every exported `*.dto.ts` class has no own undefined key without a validator) and `apps/api/src/orders/dto/create-sale.dto.pipe.spec.ts` (the exact `main.ts` pipe options accept a body without the key and still refuse a client-sent one).
  (Archived 2026-10-09 whole and verbatim to make room at cap: L-279: guarded by `apps/api/src/common/dto-no-own-undefined-keys.guard.spec.ts` (every exported `*Dto` field is covered); no outside citation.)

### L-285 · 2026-10-08 · security · a scoping argument is required, never optional (B1211, #3322)

- **Symptom:** a cross-tenant link was followed: the sellable-parent and buyer-visibility predicates took an optional tenant parameter, and every call site that forgot it silently lost the scope.
- **Root cause:** an optional scope parameter makes "no scope" a valid call, so the check disappears without an error at exactly the sites that omit it.
- **Lesson:** **Make a tenant (or other scope) parameter required in the type, throw (fail closed) at runtime when it is missing, and let the compiler list every site. Making the two predicates tenant-required surfaced 11 production sites plus the order-write gate, all fixed.**
- **Guard:** `apps/api/src/buyer/buyer-tenant-required.spec.ts`.
  (Archived 2026-10-09 whole and verbatim to make room at cap: L-285: guarded by `apps/api/src/buyer/buyer-tenant-required.spec.ts`; no outside citation.)

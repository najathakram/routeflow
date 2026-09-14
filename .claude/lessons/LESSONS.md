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

### L-010 · 2026-08-29 · tooling

- **Symptom:** one workspace's tests "failed" under verify while the same code passed everywhere
  else.
- **Root cause:** worker exhaustion under host load — the task exited 1 with **no test report at
  all**; nothing ever ran.
- **Lesson:** **A bare non-zero task exit with no test report is environmental — re-run that
  workspace directly before debugging; CI on clean runners is the authoritative gate.**
- **Guard:** none — judgment (triage: direct `npx jest`, then filtered turbo).

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

## testing

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

### L-066 · 2026-09-04 · testing · watchdog spec

- **Symptom:** a spec green on CI failed on every loaded dev box, pushing people to skip the pre-push gate.
- **Root cause:** a fixed 500 ms `setTimeout` stood in for "the spawned child has booted"; bare Node boot here is 0.6–6 s. A poll alone still fails: the api lane's undeclared Jest cap is 5 s.
- **Lesson:** **A fixed delay is never a readiness signal. Wait on the observable (log line, exit, stream) with a capped poll, kill the child in `finally`, and give the async test its own timeout above the cap.**
- **Guard:** `visibility-watchdog-script.spec.ts` slow-boot repro (`NODE_OPTIONS=--require slow-boot.cjs`, 1.5 s) stays green.

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

### L-071 · 2026-09-04 · domain · OCR gate

- **Symptom:** every invoice scan returned 403 for days; the web modal said "check the file and try again", so it read as a bad file, not a missing entitlement.
- **Root cause:** #475 put `@RequireAddon("ocr")` on live routes with no backfill and no plan bundling the add-on, and the web discarded the server's message.
- **Lesson:** **A new entitlement gate on an existing route is an outage unless it ships observe-first: register the key with a review date, allow-and-log until the backfill exists, fail closed only for unregistered keys, and always surface the server's message.**
- **Guard:** `ADDON_GATE_REGISTRY` pins P1a–P1h and REG-OCR-1 T1–T8; e2e OP-17g; the CLAUDE.md "Entitlement gates" rule and the PR-template line.

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

### L-129 · 2026-09-14 · process · Phase 0 T10 deferred-gap markers

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

### L-130 · 2026-09-14 · testing

- **Symptom:** a new `*.db.spec.ts` passed against the compose stack but CI's "Replay migrations
  on a fresh database" job failed its `beforeAll` with "No PUBLISHED PlanVersion … run
  `npm run local:seed` first", then `afterAll` threw `Cannot read properties of undefined
(reading 'id')` and Jest hung on an unclosed pool.
- **Root cause:** `local:seed` publishes the plan catalog (global reference data the `PlanVersion`
  table starts empty of); CI's replay job runs `test:db` on a freshly migrated DB with no seed at
  all, so any spec that assumes seeded reference data is green locally and red in CI.
- **Lesson:** **a db spec creates every row it reads — including global reference data — in its
  own `beforeAll` (use an existing row if present, create a minimal one otherwise, remember what
  it created), tears down only what it created, guards every cleanup on the fixture existing, and
  always closes the pool in `afterAll` even when `beforeAll` threw.**
- **Guard:** CI's migration-replay job (fresh DB, no seed) is the standing check; the spec
  `apps/api/src/common/backfill-subscription-reconciliation.db.spec.ts` is the reference pattern.
  When a spec fabricates a reference row, derive any integer key or version from the table
  (`max(col) + 1`), never from `Date.now()` — `PlanVersion.version` is int4 and a timestamp-derived
  value overflowed it only on CI's fresh database, i.e. the one environment the fix targeted; a fix
  aimed at an environment you cannot run must be traced against that environment's schema and limits.

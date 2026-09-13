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

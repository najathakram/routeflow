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

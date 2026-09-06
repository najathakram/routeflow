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

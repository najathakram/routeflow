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

## tooling

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

### L-074 · 2026-09-05 · tooling

- **Symptom:** a prod-capable seed run through `railway run --service postgres` wrote to the LOCAL
  dev database.
- **Root cause:** the script defaulted `DATABASE_URL` to a localhost URL and the postgres service
  exposes only discrete POSTGRES_*/TCP-proxy vars.
- **Lesson:** **a script that can target production never has a silent local default: resolve the
  target from the variables the runner actually injects, print the resolved host before
  connecting, and treat "nothing set" as a loud fallback.**
- **Guard:** `resolveDatabaseUrl` + its spec; the seed logs its target host.

### L-065 · 2026-09-03 · tooling · PR-4 `imp-01`

- **Symptom:** the review counted "four copies", the first plan promised a source-direct package
  "exactly like `@routeflow/types`", and the repo's own comments already said that shape crashes
  `node dist/main.js`.
- **Lesson:** a workspace package the API imports at runtime must ship compiled JS — `nest build`
  emits `require()` verbatim; source-direct packages are a client-only convenience. Build it on
  `postinstall` so every `npm ci` (CI, Docker, dev) produces `dist` before anything typechecks.
- **Guard:** `no-runtime-workspace-imports.spec.ts` (PR-1's engine already seeded the idea; this PR
  makes it assert every `@routeflow/*` the API imports has a built `main`).

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

### L-062 · 2026-09-04 · tooling · imp-04

- **Symptom:** dropping `@routeflow/api#test` (forbidden by package-shape.spec.ts) left
  docs-truth.spec.ts/no-dead-deps.spec.ts's outside-workspace reads unhashed by any turbo task.
- **Lesson:** a tripwire spec reaching outside its own workspace must own a turbo task whose
  `inputs` name those files — a `<workspace>#<task>` override is one spec away from forbidden; a
  GENERIC task with explicit inputs survives.
- **Guard:** `turbo.json` `test:repo-truth`; `apps/api/src/common/turbo-inputs.spec.ts`.

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

## testing

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

## deploy

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

## domain

### L-071 · 2026-09-04 · domain · OCR gate

- **Symptom:** every invoice scan returned 403 for days; the web modal said "check the file and try again", so it read as a bad file, not a missing entitlement.
- **Root cause:** #475 put `@RequireAddon("ocr")` on live routes with no backfill and no plan bundling the add-on, and the web discarded the server's message.
- **Lesson:** **A new entitlement gate on an existing route is an outage unless it ships observe-first: register the key with a review date, allow-and-log until the backfill exists, fail closed only for unregistered keys, and always surface the server's message.**
- **Guard:** `ADDON_GATE_REGISTRY` pins P1a–P1h and REG-OCR-1 T1–T8; e2e OP-17g; the CLAUDE.md "Entitlement gates" rule and the PR-template line.

### L-046 · 2026-09-04 · domain · F13

- **Symptom:** a MONTHLY recurring invoice never advanced; a standing order billed list price; a failed cycle was silently skipped; a failed cycle's unconditional rollback could hand the schedule back for a cycle another run had already billed.
- **Root cause:** a month-advance compared against a mutated date; a second writer priced lines outside the one buyer resolver; the cron advanced the schedule before it knew the outcome and never recorded it; the restore after failure was not conditioned on the claim that made it.
- **Lesson:** **Every path that materialises an order or invoice from a saved shape is a pricing writer and a schedule writer: price through the shared resolver, record the outcome on the row you advanced, and undo a claim only by compare-and-set on the value the claim wrote — a miss means someone newer owns the row, so write nothing.**
- **Guard:** REG-B48 T9–T16 through the real resolver; REG-B46 T1–T7b; REG-B106 T17/T17b/T17c/T18/T19 ([[L-030]]: a write and its record share one condition; [[L-045]]: release on the forward-path marker).

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

## security

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

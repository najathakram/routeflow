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

## deploy

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

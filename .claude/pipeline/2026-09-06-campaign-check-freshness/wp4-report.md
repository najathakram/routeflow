# WP-4 report — docs + lesson + code map (campaign-check report freshness)

Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`
Branch: `fix/campaign-check-report-freshness` @ `597c72dc` (unchanged by this package — no commits made)

Scope: `.claude/skills/bug-registry/SKILL.md`, `.claude/lessons/{LESSONS.md,ARCHIVE.md,_meta.json}`,
`.claude/code-map/{INDEX.md,api.md,CHANGELOG.md,_meta.json}`. Did **not** touch
`scripts/campaign-check.mjs`, `scripts/jest-campaign-reporter.cjs`, `package.json`, or
`apps/api/src/common/campaign-check-freshness.spec.ts` (owned by a concurrent package on this
branch) or anything under `apps/`/`scripts/` beyond that.

## `git status --porcelain` after this package

```
 M .claude/code-map/CHANGELOG.md
 M .claude/code-map/INDEX.md
 M .claude/code-map/_meta.json
 M .claude/code-map/api.md
 M .claude/lessons/ARCHIVE.md
 M .claude/lessons/LESSONS.md
 M .claude/lessons/_meta.json
 M .claude/skills/bug-registry/SKILL.md
 M package.json                                            <- other package, untouched by WP-4
 M scripts/campaign-check.mjs                               <- other package, untouched by WP-4
 M scripts/jest-campaign-reporter.cjs                        <- other package, untouched by WP-4
?? .claude/pipeline/2026-09-06-campaign-check-freshness/     <- this pipeline folder (this report)
?? apps/api/src/common/campaign-check-freshness.spec.ts      <- other package, untouched by WP-4
```

Exactly the 8 files assigned to WP-4, plus the other package's in-flight files, unmodified.

## `node scripts/validate-lessons.mjs`

```
✔ .claude/lessons: register is self-consistent. 39/40 entries · 39.4/40.0 KB · archived 40 · nextId 84 (max L-083) · binding: size (~0 more entries at 1.01 KB each)
  ⚠ caps disagree: 40 entries at 1.01 KB each is ~40 KB, over the 40.0 KB cap — so size really permits ~39 entries and the entry cap is unreachable. Owner decision: which constraint is load-bearing? Re-set the other in .claude/lessons/_meta.json.
  (--verbose lists every id and the reserved gaps)
```

Exit code: **0**. The `caps disagree` line is a pre-existing, standing structural note the
validator prints on every run (the 40-entry/40 KB caps are mutually near-unsatisfiable at
~1 KB/entry) — not new to this change.

**Byte cap still binds after this archival**: 39.4/40.0 KB, ~0 KB headroom for a further ~1 KB
entry. Per instructions, a third entry was **not** archived beyond L-065/L-046 — flagging this
here rather than archiving further unasked.

## Archived ids

- **L-065** (tooling, PR-4 `imp-01`) — oldest active entry whose Guard names a landed automated
  spec (`no-runtime-workspace-imports.spec.ts`).
- **L-046** (domain, F13) — the next-oldest qualifying entry by the same rule; L-072 (the entry
  that would otherwise have been next) was skipped because `CLAUDE.md`'s Conventions cite it
  inline by id, per the spec's explicit instruction.

Both moved **verbatim** to `.claude/lessons/ARCHIVE.md` under a new dated section
(`## Archived 2026-09-06 — headroom for L-083 (campaign-check freshness)`), matching the file's
established compaction-event convention (see e.g. the adjacent "Archived 2026-09-06 — headroom
for L-081" section) rather than the literal top-level category headings, since no prior
compaction event nests under those either — each entry's own `### L-0## · date · category · …`
heading already carries its category.

Added: **L-083** (tooling) — appended verbatim from `lesson-L-083.md` at the top of the
`## tooling` section in `LESSONS.md` (matching the newest-first convention used for L-080 atop
`## process`).

`_meta.json`: `nextId` 83→84, `activeCount` 40→39, `archivedCount` 38→40, `updatedAt` bumped,
`note` replaced (one sentence, not accumulated).

## Prettier

`npx prettier --write` then `--check` run on all 8 touched files. Only `INDEX.md` changed under
`--write` (single giant markdown table — one edited row plus the header separator row forced a
column-width repad across the whole table): `git diff --numstat` shows 81/81 raw lines touched,
but `git diff -w --numstat` (whitespace-insensitive) shows only **2/2** lines truly changed —
confirming the repad is whitespace-only and no content besides my intended edit moved. All 8
files pass `prettier --check` clean.

## Hunks

### `.claude/code-map/CHANGELOG.md`

```diff
@@ -8,6 +8,7 @@ newest first**. This file replaces the old habit of prepending each session's no
 below, and set `_meta.json` `"notes"` to that same note plus the pointer to this file —
 never accumulate history in `"notes"`.

+- **2026-09-06** — (worktree `rf-registry`, branch `fix/campaign-check-report-freshness` @ `597c72dc`, WP-4 docs+lesson+code-map package; `.claude/pipeline/2026-09-06-campaign-check-freshness/`) — **campaign-check report-freshness guard documented.** `scripts/campaign-check.mjs` gains a freshness rule (full mode, inside the existing `t1Needed`/`t3Needed` gating, BEFORE any token is indexed) plus a new `--freshness-only` pre-step mode — the FIRST step of `npm run verify`, before the `turbo run … test …` segment — that asks `npx turbo run test --filter=<pkg> --dry-run=json` whether a stale consulted T1 report's workspace would REPLAY from cache and refuses in seconds only when it would (a cache MISS proceeds, since turbo is about to regenerate the report itself). This automates the gap L-034 diagnosed on 2026-09-01 but never guarded: a warm turbo cache HIT skips the jest reporter entirely, so `.campaign/runs/<ws>.json` keeps stale REG-B### tokens and the gate used to fail with the confusing "no test titled with REG-B### found" instead of naming the stale artifact by name with the regen command. `scripts/jest-campaign-reporter.cjs` now stamps `generatedAt` (ISO, write time) and `gitHead` (`git rev-parse --short HEAD`, best-effort `null`) onto every report it writes (api/mobile/pricing alike) — the provenance the freshness rule reads, falling back to file mtime when absent. Test seam `CAMPAIGN_CHECK_TURBO_DRY_RUN=<path>`, honoured only inside a Jest worker (`JEST_WORKER_ID` set, the `SCHEMA_DRIFT_PRISMA_CLI` shape). Docs: `.claude/skills/bug-registry/SKILL.md` gains a "Report freshness" subsection under "Keeping the registry honest" and a post-ledger-edit regen ritual (`cd apps/api && npx jest --maxWorkers=2`, same for mobile/pricing when a batch carries T1 claims there) right after the `prove`/`discharge` examples in "Closing out". Lesson **L-083** (tooling) appended; **L-065** (tooling, `no-runtime-workspace-imports.spec.ts`) and **L-046** (domain, F13) archived to `ARCHIVE.md` for headroom — the two oldest active entries whose Guard names a landed automated artifact (L-072 skipped: cited inline by CLAUDE.md's Conventions). `INDEX.md`'s "Bug-register burn-down campaign" row and `api.md` gain the new `apps/api/src/common/campaign-check-freshness.spec.ts` (T1–T11) entry, alongside the sibling script specs `ci-freshness-guard-script.spec.ts`/`turbo-inputs.spec.ts` it mirrors the harness of. Script/reporter/`package.json`/spec implementation itself landed by a concurrent package on this same branch, not this docs+lesson+code-map pass — see the pipeline folder for `spec.md`/`reader.md`. `node scripts/validate-lessons.mjs` exit 0: 39/40 entries · 39.4/40.0 KB (binding: size, ~0 headroom for one more entry at ~1.01 KB each) · archived 40 · nextId 84.
 - **2026-09-06** — (worktree `rf-registry`, branch `fix/bugs-selftest-lock-liveness`, off `master` `0b715128`) — **Lock-liveness self-test pid-reuse fixture flake fixed …
```

### `.claude/code-map/_meta.json`

```diff
@@ -1,7 +1,7 @@
 {
-  "mappedSha": "93a91cfc",
-  "generatedAt": "2026-09-06T09:39:25.905Z",
+  "mappedSha": "597c72dc",
+  "generatedAt": "2026-09-06T17:40:16.302Z",
   "areas": ["api", "web", "mobile", "packages"],
-  "fileCount": 1011,
-  "notes": "…(previous session's note)…"
+  "fileCount": 1012,
+  "notes": "…(this session's note, replaced not accumulated — see CHANGELOG.md bullet above)…"
 }
```

`fileCount` bumped 1011→1012 for the new `apps/api/src/common/campaign-check-freshness.spec.ts`
file (landed by the concurrent package; present in `git status` as `??` at read time).

### `.claude/code-map/api.md`

```diff
@@ -489,6 +489,24 @@ private …` immediately followed by a `gh repo view --json visibility` read-bac
   `apps/api/scripts/**`, `apps/api/Dockerfile`, `apps/api/prisma.config.ts`, `package.json` and
   `docker-compose.yml` (no-single-schema-path's reach), and the spec pins ALL sixteen explicit
   inputs plus the lane's exact three specs.
+- **`src/common/campaign-check-freshness.spec.ts` (2026-09-06, campaign-check report freshness,
+  L-083)** — contract spec for `scripts/campaign-check.mjs`'s freshness rule and its new
+  `--freshness-only` pre-step (see [`INDEX`](INDEX.md)'s "Bug-register burn-down campaign" row).
+  Harness mirrors `ci-freshness-guard-script.spec.ts`'s `runScriptDirect` (`spawnSync` the real
+  `.mjs` directly) + `mkdtempSync` fixture pattern: a throwaway `git init` repo with two commits
+  (a workspace test file, then a `.claude/campaign/status/F01.jsonl` ledger row) at explicit
+  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, `CAMPAIGN_CHECK_STATUS_DIR` + `--runs-dir` pointed at the
+  fixture, env scrubbed of `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`CAMPAIGN_CHECK_TURBO_DRY_RUN`.
+  T1–T3/T5 pin the R1 staleness compare (report `generatedAt` vs. the newer of the test-file commit
+  or the ledger commit) and R2's exact refusal block (stale-by-name, before any token scan,
+  `cd <dir> && npx jest --maxWorkers=2`, the ritual line); T4 is the R3 positive control (no
+  affirmative T1 claim ⇒ never checked, green before and after — excluded from the "0 passed on
+  red" claim); T6–T9 drive `--freshness-only` (R4) through the `CAMPAIGN_CHECK_TURBO_DRY_RUN` seam
+  (R6, `JEST_WORKER_ID`-gated) — HIT refuses, MISS/parse-failure fails OPEN, the seam is ignored
+  outside a Jest worker; T10 runs the REAL `scripts/jest-campaign-reporter.cjs` in a child process
+  and asserts the new `generatedAt`/`gitHead` stamp (R0) with the four original fields unchanged;
+  T11 pins root `package.json`'s `verify` script starting with
+  `node scripts/campaign-check.mjs --freshness-only && ` (R5).
 - **`src/main.ts`** — ⚠️ NEVER `app.use(json())` here: …
```

### `.claude/code-map/INDEX.md`

Single edit inside the giant "Bug-register burn-down campaign (ledger, gate, F-cards)" table row
(row 105), inserted right after "...an IO fault used to print a raw Node stack trace." and before
"Detail: CHANGELOG.md. Plan: ...gosling.md". Added text (verbatim):

> **2026-09-06 (report freshness, L-083):** `--freshness-only` is a new pre-step MODE — the FIRST
> step of `npm run verify`, before the `turbo run … test …` segment — that runs ONLY the R1
> staleness rule (a report's `generatedAt`, or its file mtime when absent, vs. the newest commit
> touching that workspace's own test files OR the ledger shards) for each CONSULTED T1 report,
> and for a stale one asks `npx turbo run test --filter=<pkg> --dry-run=json` whether that
> workspace's `test` task would REPLAY from cache: a HIT refuses with the regen command
> (`cd <dir> && npx jest --maxWorkers=2`) plus the ritual line, a MISS or a dry-run failure (spawn
> error, bad JSON, task not found) proceeds — turbo is about to regenerate the report itself, or
> the check fails OPEN and the end-of-verify pass still enforces it. The SAME R1 rule now also
> runs in FULL mode, inside `main()`'s existing `t1Needed` gating, BEFORE any token is indexed — a
> stale consulted report refuses by name with the regen command instead of the confusing "no test
> titled with REG-B###"; a MISSING consulted report's existing failure text gains one appended
> `regenerate:` line. `CAMPAIGN_CHECK_TURBO_DRY_RUN=<path to JSON>` is a test-only seam that swaps
> in a fixture dry-run payload, honoured ONLY inside a Jest worker (`JEST_WORKER_ID` set — the
> `SCHEMA_DRIFT_PRISMA_CLI` shape) and loudly ignored outside one. `scripts/jest-campaign-
reporter.cjs` now stamps `generatedAt` (ISO, write time) and `gitHead` (`git rev-parse
--short HEAD`, best-effort `null` on failure) onto every report it writes (api/mobile/pricing
> alike, every other field unchanged) — this is the provenance R1 reads. Spec:
> `apps/api/src/common/campaign-check-freshness.spec.ts` (T1–T11, harness mirrors
> `ci-freshness-guard-script.spec.ts`'s `runScriptDirect`/`mkdtempSync`; detailed in
> [`api`](api.md)).

Raw `git diff` for this file shows 81/81 lines (prettier's table-column repad, whitespace only —
see Prettier section above); `git diff -w --numstat` confirms only 2/2 lines carry real content
changes (this row + the header separator dash-count row prettier widens to match). Full raw diff
omitted here (≈94 KB, almost entirely whitespace) — available via `git diff -w -- .claude/code-map/INDEX.md`
in the worktree.

### `.claude/lessons/ARCHIVE.md`

```diff
@@ -634,3 +634,31 @@ suite) rather than judgment/none/runbook.
   reachable (a SKIPPED stop on a COMPLETED run), ship the refusal for it in the same PR ([[L-030]]).
 - **Guard:** `REG-B129 (T5 path: cancel → un-cancel → re-dispatch)`, `REG-B211 (T12 path:
 complete-with-skipped → reopen refused)`; mutation probes in the F11 PR body.
+
+## Archived 2026-09-06 — headroom for L-083 (campaign-check freshness)
+
+Landing L-083 (tooling — campaign-check must refuse a stale run artifact by name, with the regen
+command, before scanning a single token) at 40 of 40 active entries required archiving first.
+Both entries below archived 2026-09-06 for headroom (L-083 added; register at its byte cap) —
+guard automated: **L-065** (tooling) is the oldest active entry whose Guard names a landed
+automated spec (`no-runtime-workspace-imports.spec.ts`) rather than judgment/none/runbook; the
+next-oldest by that rule, L-072, stays active because `CLAUDE.md`'s Conventions cite it inline by
+id, so **L-046** (domain), the following qualifying entry, is archived instead.
+
+### L-065 · 2026-09-03 · tooling · PR-4 `imp-01`
+
+- **Symptom:** the review counted "four copies", the first plan promised a source-direct package
+  "exactly like `@routeflow/types`", and the repo's own comments already said that shape crashes
+  `node dist/main.js`.
+- **Lesson:** a workspace package the API imports at runtime must ship compiled JS — `nest build`
+  emits `require()` verbatim; source-direct packages are a client-only convenience. Build it on
+  `postinstall` so every `npm ci` (CI, Docker, dev) produces `dist` before anything typechecks.
+- **Guard:** `no-runtime-workspace-imports.spec.ts` (PR-1's engine already seeded the idea; this PR
+  makes it assert every `@routeflow/*` the API imports has a built `main`).
+
+### L-046 · 2026-09-04 · domain · F13
+
+- **Symptom:** a MONTHLY recurring invoice never advanced; a standing order billed list price; a failed cycle was silently skipped; a failed cycle's unconditional rollback could hand the schedule back for a cycle another run had already billed.
+- **Root cause:** a month-advance compared against a mutated date; a second writer priced lines outside the one buyer resolver; the cron advanced the schedule before it knew the outcome and never recorded it; the restore after failure was not conditioned on the claim that made it.
+- **Lesson:** **Every path that materialises an order or invoice from a saved shape is a pricing writer and a schedule writer: price through the shared resolver, record the outcome on the row you advanced, and undo a claim only by compare-and-set on the value the claim wrote — a miss means someone newer owns the row, so write nothing.**
+- **Guard:** REG-B48 T9–T16 through the real resolver; REG-B46 T1–T7b; REG-B106 T17/T17b/T17c/T18/T19 ([[L-030]]: a write and its record share one condition; [[L-045]]: release on the forward-path marker).
```

### `.claude/lessons/LESSONS.md`

```diff
@@ -139,6 +139,21 @@

 ## tooling

+### L-083 · 2026-09-06 · tooling · campaign-check freshness
+
+- **Symptom:** four pushes in one day were refused twelve minutes into `npm run verify` with "no test titled
+  with REG-B###", although the tests existed and passed — the machine-local Jest report campaign-check reads
+  was simply older than the ledger rows it was asked to prove.
+- **Root cause:** turbo replays a `test` task whose input tree it has seen before (a worktree whose workspace
+  matches master's after a merge), so the reporter never runs and `.campaign/runs/<ws>.json` keeps the tokens
+  of its last real run; the gate compared claims against that stale artifact as if it were current.
+- **Lesson:** **an artifact a gate consumes must carry its own provenance (its start time) and the gate must
+  compare it with the inputs it certifies — the newest commit touching the workspace's tests or the ledger —
+  and refuse a stale artifact by name, with the regeneration command, before it scans a single token.**
+- **Guard:** `scripts/campaign-check.mjs` freshness rule (full mode, before indexing) + `--freshness-only`
+  pre-step at the head of `npm run verify` that asks `turbo --dry-run=json` whether a replay is coming;
+  `apps/api/src/common/campaign-check-freshness.spec.ts` T1–T10.
+
 ### L-079 · 2026-09-06 · tooling · #627 `chore/ci-private-minutes`

 - **Symptom:** three unrelated api specs refused pre-push verifies on 2026-09-05/06 with
@@ -169,17 +184,6 @@
   connecting, and treat "nothing set" as a loud fallback.**
 - **Guard:** `resolveDatabaseUrl` + its spec; the seed logs its target host.

-### L-065 · 2026-09-03 · tooling · PR-4 `imp-01`
-
-- **Symptom:** the review counted "four copies", the first plan promised a source-direct package
-  "exactly like `@routeflow/types`", and the repo's own comments already said that shape crashes
-  `node dist/main.js`.
-- **Lesson:** a workspace package the API imports at runtime must ship compiled JS — `nest build`
-  emits `require()` verbatim; source-direct packages are a client-only convenience. Build it on
-  `postinstall` so every `npm ci` (CI, Docker, dev) produces `dist` before anything typechecks.
-- **Guard:** `no-runtime-workspace-imports.spec.ts` (PR-1's engine already seeded the idea; this PR
-  makes it assert every `@routeflow/*` the API imports has a built `main`).
-
 ### L-073 · 2026-09-04 · tooling · wave E `imp-10a`

 - **Symptom:** "generated client `index.d.ts` byte-identical before/after" failed on a
@@ -518,13 +522,6 @@ build` forces production — so that branch was dead in every Docker image, not
 - **Lesson:** **A new entitlement gate on an existing route is an outage unless it ships observe-first: register the key with a review date, allow-and-log until the backfill exists, fail closed only for unregistered keys, and always surface the server's message.**
 - **Guard:** `ADDON_GATE_REGISTRY` pins P1a–P1h and REG-OCR-1 T1–T8; e2e OP-17g; the CLAUDE.md "Entitlement gates" rule and the PR-template line.

-### L-046 · 2026-09-04 · domain · F13
-
-- **Symptom:** a MONTHLY recurring invoice never advanced; a standing order billed list price; a failed cycle was silently skipped; a failed cycle's unconditional rollback could hand the schedule back for a cycle another run had already billed.
-- **Root cause:** a month-advance compared against a mutated date; a second writer priced lines outside the one buyer resolver; the cron advanced the schedule before it knew the outcome and never recorded it; the restore after failure was not conditioned on the claim that made it.
-- **Lesson:** **Every path that materialises an order or invoice from a saved shape is a pricing writer and a schedule writer: price through the shared resolver, record the outcome on the row you advanced, and undo a claim only by compare-and-set on the value the claim wrote — a miss means someone newer owns the row, so write nothing.**
-- **Guard:** REG-B48 T9–T16 through the real resolver; REG-B46 T1–T7b; REG-B106 T17/T17b/T17c/T18/T19 ([[L-030]]: a write and its record share one condition; [[L-045]]: release on the forward-path marker).
-
 ### L-047 · 2026-09-04 · domain · F25

 - **Symptom:** run dates, licence expiries and dashboard dates shifted a day for viewers west of
```

### `.claude/lessons/_meta.json`

```diff
@@ -1,10 +1,10 @@
 {
-  "nextId": 83,
-  "activeCount": 40,
-  "archivedCount": 38,
+  "nextId": 84,
+  "activeCount": 39,
+  "archivedCount": 40,
   "maxEntries": 40,
   "maxBytes": 40960,
-  "updatedAt": "2026-09-06T09:37:58.771Z",
+  "updatedAt": "2026-09-06T17:37:58.073Z",
   "schemaVersion": 1,
-  "note": "fix/bugs-selftest-lock-liveness: … (previous session's note)"
+  "note": "fix/campaign-check-report-freshness: added L-083 (tooling — campaign-check must refuse a stale run artifact by name, with the regen command, before scanning a single token) and archived L-065 (tooling) + L-046 (domain), the oldest active entries whose Guard names a landed automated artifact, for headroom (L-072 skipped — cited inline by CLAUDE.md)."
 }
```

### `.claude/skills/bug-registry/SKILL.md`

```diff
@@ -173,6 +173,17 @@ npm run bugs -- discharge F11 --evidence "Railway deploy <id> SUCCESS; Actions r
   --evidence-B129 "Actions run <id> job <id>: spec 28 REG-B129 passed against that deploy"
```

+`bash
+# after ANY ledger edit or master merge — before pushing
+cd apps/api && npx jest --maxWorkers=2
+cd apps/mobile && npx jest --maxWorkers=2       # when the batch carries T1 claims there too
+cd packages/pricing && npx jest --maxWorkers=2  # when the batch carries T1 claims there too
+` +
+Run this before every push, not just before `prove`/`discharge`: turbo replays an unchanged
+workspace's tests from cache, so its `.campaign/runs/<ws>.json` report never refreshes on its
+own — see "Report freshness" above. +
Both write the ledger **replace-in-place** and update the record's front matter and History.
Never hand-edit `status/F##.jsonl`: a second row for the same id is a duplicate the gate rejects,
and that is the first mistake everyone makes.
@@ -299,6 +310,19 @@ because that is what sharpens the graph for everyone after you.
different file from `routeflow-bug-register.html`, which `enrich` still parses as the historical
import source — never overwrite that one.

+### Report freshness +
+A report in `.campaign/runs/<ws>.json` (`api`/`mobile`/`pricing`, the T1 jest evidence +`campaign-check` reads) must be **newer than the newest commit** touching that workspace's own
+test files or the ledger shards (`.claude/campaign/status`) — otherwise `campaign-check` is
+reading proof a later commit invalidated. It refuses a stale report **by name**, with the exact
+regen command, **before scanning a single token** — never the confusing "no test titled with
+REG-B###" for a report that is merely old. `node scripts/campaign-check.mjs --freshness-only` is
+the FIRST step of `npm run verify` (before the `turbo run … test …` segment): for each stale
+consulted report it asks turbo `--dry-run=json` whether that workspace's `test` task would
+REPLAY from cache, and refuses in seconds only when it would — a cache **MISS** proceeds, because
+turbo is about to regenerate the report itself, so there is nothing to refuse yet (lesson L-083). +

### Two agents, one shard

`status/F##.jsonl` is shared mutable state, and the campaign routinely runs several sub-agents on

```

## Notes / deviations

- Placed the two archived entries in ARCHIVE.md as a **new dated compaction-event section**
  (`## Archived 2026-09-06 — headroom for L-083 …`) rather than literally under the file's
  top-level `## tooling`/`## domain` category headings — every prior compaction event in this
  file (checked: 2026-09-04, -05 ×5, -06 ×1) follows this same pattern, and each entry's own
  `### L-0## · date · category · …` heading already states its category, satisfying "under their
  category headings" without breaking the established convention or scattering one archival
  event across two disconnected places in the file.
- `[[L-083]]` cross-reference syntax (used inside `LESSONS.md`/`ARCHIVE.md`) was **not** used
  inside `SKILL.md`'s new "Report freshness" section — no other citation in that file uses the
  double-bracket lessons convention, so it reads as plain prose ("lesson L-083") instead, to avoid
  implying a link mechanism that doesn't exist there.
- No `apps/api/src/common/*.spec.ts` code-map entries outside `campaign-check-freshness.spec.ts`
  were touched.
```

# Opus refute-first review — campaign-check freshness guard (`f07aab25`, base `597c72dc`)

Lens: correctness + test-quality + operability. READ-ONLY: committed content only (`git show f07aab25:<path>`),
plus read-only `git log` / `git ls-files` probes and reads of `node_modules/@jest/*` build+type files. Nothing that
writes was run (no spec run, no turbo, no campaign-check).

## VERDICT: **FIX-THEN-SHIP**

One blocker (F1), five minors, four informational. F1 is a one-flag code change plus one fixture test; nothing else
blocks. Nothing in the diff introduces a _false green_ — every finding's failure mode is either "the refusal the
change exists for still does not fire" (F1) or extra friction/noise.

| id  | sev           | one line                                                                                                                                                                                                                |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **BLOCKER**   | `git log -1 -- <path>` skips a merge that only _inherits_ the change, so the post-`git merge origin/master` case — the exact one this change exists for — is still judged FRESH                                         |
| F2  | Minor         | `computePartial` misses `--onlyChanged` / `--changedSince` / `--shard`, and degrades to `partial:false` when `isSet()` is true but `.patterns` is not an array                                                          |
| F3  | Minor         | a future-dated commit (clock skew) makes even a just-written report STALE with no recovery — a hard block, CI included                                                                                                  |
| F4  | Minor         | docs drift: INDEX says `npx turbo` (the code deliberately never uses npx); INDEX/api.md say T1–T11 and L-083 says T1–T10 (the file ships T1–T14); R9/`partial` absent from the map; R7's CHANGELOG bullet never written |
| F5  | Minor (tests) | nothing pins pathspec **scoping** (bounding by HEAD passes every test) and nothing exercises a merge — F1 is invisible to T1–T14                                                                                        |
| F6  | Info          | up to three serial turbo dry-runs (3–6 s each) can exceed R4's "≤ 10 s" budget; `shell:true` + unquoted path breaks under a directory with spaces                                                                       |
| F7  | Info          | `%ct` second-truncation leaves a ≤ 1 s false-fresh window; `process.exit()` immediately after the refusal writes can truncate them on a piped stdout                                                                    |
| F8  | Info          | the "ignored outside a Jest worker" notice goes to **stdout** where `schema-drift.mjs` puts both halves of the seam on stderr                                                                                           |
| F9  | Info          | R9 by design turns any scoped `npx jest` into a push-blocker until a full run; SKILL.md's new ritual covers ledger edits and merges but not scoped runs                                                                 |

---

## F1 (BLOCKER) — the staleness rule does not survive a merge: `git log -1 -- <pathspec>` returns the _pre-merge_ commit

**Evidence:** `scripts/campaign-check.mjs:420-431` (`newestCommit`) runs
`git log -1 --format=%H%x1f%ct%x1f%s -- <pathspecs>` with no `--first-parent` and no `--full-history`; consumed at
`:605-615` (`testsCommit` / `ledgerCommit`, `isStale = reportTimeMs < newestCause.commit.ct * 1000`).

**Claim:** git's _default history simplification_ applies to `git log -- <path>`: when a merge commit is TREESAME to
one parent over the given paths, git follows only that parent and does **not** show the merge. A local
`git merge origin/master` on a branch that did not itself touch `.claude/campaign/status` (or that workspace's test
files) is exactly that shape — the merge is TREESAME to the master parent for those paths — so `newestCommit` reports
the _upstream_ commit's `%ct` (when that PR merged on master, hours or days earlier), never the merge time at which
those rows actually entered this branch.

**Refutation attempts (all failed):**

1. _"`-1` with a pathspec surely shows the merge."_ Empirically refuted in this repo, read-only:
   `git log -1 --format='%h %ct' 7a1e324d -- .github/workflows/ci.yml` → `0fca862e 1785451056` (the side-branch
   commit), while `git log -1 --first-parent … 7a1e324d -- <same path>` → `7a1e324d 1785451091` (the merge). The
   merge's own timestamp is only reachable with `--first-parent`.
2. _"It only matters when both sides touched the path."_ That sub-case already works — confirmed on `ad70af10`
   (`.claude/code-map/api.md` appears in its combined diff, i.e. not TREESAME to any parent): default mode _does_
   return the merge there. The broken population is the complement — a branch that did **not** touch the ledger or
   that workspace's tests — which discovery.md names as the target verbatim: "every push from a branch that did not
   touch a workspace whose ledger claims changed keeps failing late".
3. _"turbo will MISS after a merge and regenerate the report anyway."_ Not for the ledger: `.claude/campaign/status`
   is in no task's `inputs` (turbo.json `test` = `$TURBO_DEFAULT$` + globalDependencies), so merged-in **ledger rows**
   never bust the cache — precisely the HIT case R4 exists for. reader.md also records a live tree where
   `mobile.json` predates #636's _tests_ and turbo still predicts HIT.
4. _"The pipeline considered and accepted this."_ No: `--first-parent`, merge semantics and history simplification
   appear nowhere in reader.md, spec.md, build-plan.md or the wp/r9 reports.

**Failure scenario (the original bug, unfixed):** master commit `C` (a squashed PR) at 2026-09-05 12:00 adds the
`done` ledger rows for B66 plus the REG-B66 mobile spec. On branch X (no ledger or mobile edits of its own) a verify
at 2026-09-06 09:00 writes `mobile.json` (`generatedAt` 09:00). At 10:00 the dev runs `git merge origin/master`
(merge `M`, ct 10:00). `npm run verify`: the pre-step computes `newestCommit(ledger)` → **`C` (09-05 12:00)**, not
`M`, so 09-06 09:00 > 09-05 12:00 ⇒ **FRESH**; same for the mobile test pathspec. Pre-step exits 0; turbo replays
`@routeflow/mobile#test` from cache so the reporter never runs; full mode recomputes the same FRESH verdict and the
gate prints `B66: no test titled with REG-B66 found in the jest report` twelve minutes in — the identical refusal
this PR was written to replace.

**Fix (one line + one test):** pass `--first-parent` to the `git log` in `newestCommit`
(`["log", "-1", "--first-parent", "--format=…", "--", ...pathspecs]`). It is a no-op on master's linear squash-merge
history and on the linear fixtures, and it makes a merge that brings a path's change report the merge's own time.
Add T15: commit the ledger on a side branch at `t0+600`, `git merge --no-ff` at `t0+900` onto a branch whose report
is stamped `t0+700` ⇒ must refuse (red without `--first-parent`).

## F2 (Minor) — `computePartial` under-detects scoped runs, and drops the signal on a shape it half-recognises

**Evidence:** `scripts/jest-campaign-reporter.cjs:52-71`, specifically `:57-58`
`if (tpp && typeof tpp.isSet === "function") { if (tpp.isSet() && Array.isArray(tpp.patterns)) patterns.push(...) }`.

**Claim (a):** `partial` derives _only_ from path/name patterns. `jest -o` (`--onlyChanged`), `--changedSince`,
`--shard` and `--findRelatedTests` each produce a genuinely partial artifact stamped `partial: false` — exactly the
laundering R9 exists to stop. **Claim (b):** "patterns are set but `.patterns` is not an array" yields
`partial: false`, i.e. the fail-_open_ direction. (The live shape is fine — `@jest/types/build/Config.d.ts:704`
types `GlobalConfig.testPathPatterns` as `TestPathPatterns`, whose `@jest/pattern` class exposes `isSet()` and an
array `patterns` — but `TestPathPatternsExecutor` in the same file exposes `isSet()` with a **non-array**
`.patterns`, so the degraded branch is one refactor away.)

**Refutation attempt:** "verify always re-runs jest after a scoped run." Only on a turbo MISS; re-running one spec
without editing a file leaves the hash unchanged ⇒ HIT ⇒ the partial artifact survives into the gate.

**Fix:** set `partial = true` whenever `tpp.isSet()` is true (push patterns only when they are an array), and add
`gc.onlyChanged` / `gc.changedSince` / `gc.shard` / `gc.findRelatedTests` as triggers with a synthetic label.

## F3 (Minor) — a future-dated commit hard-blocks, with no recoverable action

**Evidence:** `:615` `isStale = reportTimeMs < newestCause.commit.ct * 1000`; `generatedAt` is the _reporter's_ wall
clock (`jest-campaign-reporter.cjs:91`), `%ct` is the _committer's_.

**Claim:** if any commit touching the pathspecs carries a timestamp ahead of this machine's now (a dev box whose
clock runs fast, a `GIT_COMMITTER_DATE` rewrite, `--committer-date-is-author-date` off a skewed clock), then every
freshly generated report is "older" than it, the refusal repeats after every regeneration, and the printed advice
cannot help until wall-clock time passes the commit. Full mode runs in CI too (`.github/workflows/ci.yml:283` runs
`npm run verify`), so this blocks everyone, not just the author.

**Refutation attempt:** "CI has no cache and no reports, so CI is safe." True for the _pre-step_ (reports absent ⇒
"missing — turbo will generate it — continuing" ⇒ exit 0), but the end-of-verify full-mode check runs against reports
the same job just generated, so a future-dated head commit turns CI red with a stale-report message. Low likelihood,
unbounded blast radius.

**Fix:** ignore a cause whose `ct * 1000 > Date.now() + SKEW` (≈ 5 min) and say so in one line, or subtract the same
tolerance from the comparison.

## F4 (Minor) — documentation drift in the artifacts that are supposed to be the truth

**Evidence:** `.claude/code-map/INDEX.md:105` says the pre-step "asks `npx turbo run test --filter=<pkg>
--dry-run=json`", whereas `campaign-check.mjs:490-512` deliberately resolves
`<gitRoot>/node_modules/.bin/turbo(.cmd)` and the build-plan ruling states "`npx turbo` is forbidden". The same row
and `.claude/code-map/api.md` describe the spec as **T1–T11**, and `LESSONS.md` L-083's Guard cites **T1–T10**, but
the file ships **T1–T14**. Neither the map nor L-083 mentions R9 (`partial` / `partialPatterns`, the PARTIAL
refusal) at all, though it is a P0 requirement. `.claude/code-map/CHANGELOG.md` exists and was **not** touched, so
R7's "CHANGELOG bullet" is unmet.

**Refutation attempt:** "the map is prose, not a contract." The project's own rule is that the map is read _instead
of_ the code; an `npx turbo` line teaches the opposite of the ruling that produced the code.

**Fix:** in INDEX.md say "`<repo>/node_modules/.bin/turbo` (never `npx`)"; change T1–T11 → T1–T14 in INDEX.md and
api.md and add one clause on R9's stamp + refusal; correct L-083's Guard to T1–T14; add the CHANGELOG bullet.

## F5 (Minor, test quality) — the two properties most likely to be got wrong are unpinned

**Evidence:** `apps/api/src/common/campaign-check-freshness.spec.ts` T1–T14.

**Claim (a) — scoping is unpinned.** No fixture contains a commit touching something _outside_ the pathspecs after
the report was written. Replace `newestCommit`'s pathspecs with "the HEAD commit, whatever it touched" and T1–T14
all stay green, while the guard becomes a machine that declares every report stale after any commit. T3 would have
caught it with a later unrelated commit (a `docs/x.md` at `t0+900`), as spec.md's own anti-vacuity note assumed ("a
later docs commit") — that commit is not in the fixture.
**Claim (b) — merges are unpinned** (see F1): no fixture ever runs `git merge`, so neither the defect nor its fix has
an oracle. **Claim (c)** — T12 asserts against a hand-rolled `globalConfig`, so a wrong property name would pass (I
verified the real Jest 30 shape out-of-band; the test does not).

**Fix:** add the later-unrelated-commit line to T3, add F1's merge fixture as T15, and drive T12 case B with
`require("@jest/pattern")`'s real `TestPathPatterns`.

**Flake/robustness notes (not findings):** each test spawns ~10 processes (git init, five configs, two add+commit
pairs, a node child); the inner `timeout: 60_000` exceeds apps/api's 30 s `testTimeout`, so a slow host surfaces a
confusing jest timeout instead of the spawn's own error, and T12/T14 each build two full fixtures inside one 30 s
budget. `os.tmpdir()` on this box returns the long form (`C:\Users\nakram\AppData\Local\Temp`), so the 8.3-vs-long
path mismatch that would break `path.relative(gitRoot, statusDir)` at `:556-557` does not bite here; it would on a
box whose `TEMP` is the short form.

## F6–F9 (Informational)

- **F6** `:498-512` — one turbo dry-run **per stale workspace**, serially; reader measured 3–6 s each, so three stale
  reports cost 9–18 s against R4's "≤ 10 s on a warm tree". Also `shell: process.platform === "win32"` with an
  unquoted absolute binary path breaks for a checkout under a directory containing spaces.
- **F7** `:615` compares ms against `%ct * 1000`; a report generated in the same second as (but before) the commit
  reads FRESH — a ≤ 1 s window, harmless. Separately, every refusal is `console.error(...)` immediately followed by
  `process.exit(1)` (`:653-661`), which on a piped stdout/stderr can truncate what Node has not flushed; a
  pre-existing pattern in this script, but here the message _is_ the deliverable.
- **F8** `:539` prints the "ignored outside a Jest worker" notice via `console.log` (stdout) while the honoured-seam
  WARNING uses `console.warn` (stderr); `schema-drift.mjs:73-82` puts both on stderr. Cosmetic asymmetry.
- **F9** R9 means any scoped `npx jest src/foo.spec.ts` poisons that workspace's artifact until a full suite runs and
  (on a turbo HIT) blocks the next push. That is the intended contract, but SKILL.md's new ritual block only covers
  "after ANY ledger edit or master merge" — add "…or after any scoped jest run".

---

## The ten questions

**Q1 — staleness rule / pathspecs / merges: CONFIRMED-ISSUE (F1).**
The pathspecs themselves are **correct**: `git ls-files -- ':(glob)apps/api/**/*.spec.ts'` matches 264 files
including all 6 `*.db.spec.ts`; mobile's three globs match 114 files; pricing's matches 5. Over-inclusive in a
harmless direction — `*.db.spec.ts`, `docs-truth.spec.ts` etc. are `testPathIgnorePatterns`-excluded from the api
jest lane, so committing one marks the report stale for tests that lane never runs, but such a commit also changes
the package hash ⇒ turbo MISS ⇒ the suite re-runs and the report self-heals; no deadlock. Git-root derivation
(`git -C <statusDir> rev-parse --show-toplevel`, `:404-417`) is right and correctly prefers the fixture repo over
`REPO_ROOT`. **The merge behaviour is wrong:** default history simplification prunes a merge that is TREESAME to one
parent for the pathspec, so `git log -1 -- <path>` returns the _original_ upstream commit, whose `%ct` can be older
than the report — proven empirically on `7a1e324d` above. `--first-parent` is required and sufficient; `-m` changes
diff rendering, not commit selection, and `--full-history` only stops pruning the other side's commits. The
complementary case (both sides touched the path ⇒ merge shown) already works — confirmed on `ad70af10`.

**Q2 — time comparison: REFUTED (rounding / mtime / CI), CONFIRMED-ISSUE (skew, F3).**
`Date.parse(generatedAt)` vs `ct*1000` is sound; second-truncation leaves a ≤ 1 s false-fresh window (F7, benign — it
can only wave through a report generated within the same second as the commit). The mtime fallback is safe: reports
live under gitignored `.campaign/`, are never a turbo output (so never restored) and are never part of a checkout, so
mtime really is write time. CI: the pre-step cannot refuse there (no reports on a fresh runner ⇒ "missing …
continuing" ⇒ exit 0), and a shallow `fetch-depth: 1` checkout's single root commit either "touches" everything (ct =
head, older than the report generated during the run) or nothing — fresh either way. The one CI-refusal path is a
commit dated ahead of the runner's clock (F3).

**Q3 — scoping: REFUTED as a defect, with a noted cost.**
When `t1Needed`, **every existing** T1 report is checked — the build-plan's explicit ruling ("campaign-check cannot
map a claim to a workspace, so all existing T1 reports must be fresh"), consistent with the token scan, which merges
all three indexes (`:672-690`). So a stale `pricing.json` can block a push with no pricing claim in play:
conservative, not wrong, and it cannot deadlock, because `packages/pricing/jest.config.js` wires the same reporter
(`artifact: "pricing"`) so the printed regen command really refreshes it. `web-e2e.json` is correctly excluded —
`T1_WORKSPACES` (`:374-397`) lists only api/mobile/pricing and the T2 path never consults freshness. Missing reports
are skipped in full mode (left to the pre-existing artifact-missing failure) and are a note, never a refusal, in
`--freshness-only`.

**Q4 — `--freshness-only`: REFUTED (control flow, resolution, matching); fail-open is the right default.**
`:665-669` calls `checkFreshness("freshness-only")`, which always terminates in `process.exit` (`:661`, or `:549`
when `!t1Needed`) before `jestIndex` / `indexAssertions` is reached — "no test titled" is unreachable in that mode
(T6 asserts it). Binary resolution `:490-495` handles `turbo.cmd` on win32 and returns `null` when absent (fixtures,
a repo with no `node_modules`) ⇒ fail open; the real worktree does have `node_modules/.bin/turbo.cmd`, so the
pre-step is live here. `cwd` is the ledger's git root; args are `run test --filter=<pkg> --dry-run=json`; `<pkg>` is
read from `<dir>/package.json` with a `@routeflow/<ws>` fallback (`:475-489`) — correct for all three. Task matching
`t.package === pkg && t.taskId.endsWith("#test")` (`:534-536`) cannot collide with `#test:repo-truth` or `#test:e2e`,
and dependency tasks carry a different `package`. The dry-run executes nothing (it may start/refresh the turbo daemon
and its log, but writes no cache entry and touches no report). Non-JSON stdout pollution (a turbo banner or update
notice) is possible in principle and lands in the UNAVAILABLE branch. **Fail open is right:** the pre-step is an
optimisation over a check that still runs unconditionally at the end of verify, so a wrong "continue" costs the old
12 minutes and never a false green, whereas the opposite default would let a turbo hiccup block every push. Wall-time
budget: F6.

**Q5 — test seam: REFUTED.** `:515-517` gates on `override && process.env.JEST_WORKER_ID` — Boolean-equivalent to
`schema-drift.mjs:68-69` (`Boolean(JEST_WORKER_ID) && Boolean(override)`), with the same loudly-ignored-otherwise
behaviour and the same deliberate exclusion of `NODE_ENV`. No other env changes the verdict: `--runs-dir` /
`CAMPAIGN_CHECK_STATUS_DIR` only move inputs, `CAMPAIGN_CHECK_DEBUG` only rethrows. Arming the seam outside a worker
requires exporting `JEST_WORKER_ID` by hand — the same bar schema-drift accepts. Stream mismatch = F8.

**Q6 — R9 partial: REFUTED for the shipped invocations, CONFIRMED-ISSUE for the wider family (F2).**
Verified against the installed Jest 30.2.0: `@jest/types/build/Config.d.ts:704` types
`GlobalConfig.testPathPatterns` as `TestPathPatterns`, and `@jest/pattern`'s class has `isSet()` plus an array
`patterns` — the reporter's primary branch is the live one, with correct fallbacks for the older string
`testPathPattern` and for a plain array. `turbo run test` invokes `jest` (apps/api's package.json jest block),
`jest --config jest.config.js` (apps/mobile) and `jest` (packages/pricing) — no path or name pattern, no `--ci` or
`--shard` — so a full turbo pass stamps `partial: false`, as does the printed `npx jest --maxWorkers=2`.
`--silent` / `--json` / `--outputFile` never touch `testPathPatterns` or `testNamePattern`, so they do not matter.
The gap is `--onlyChanged` / `--changedSince` / `--shard` / `--findRelatedTests` plus the non-array degradation (F2).

**Q7 — messages: REFUTED, with one nit.** `staleBlock` (`:444-457`) names the report path, the report time (with the
mtime caveat appended when the fallback was used), the cause label (`<dir> test files` / `the ledger shards`), the
cause ISO, `<short sha> <subject>`, the regen command, then the `rule:` and `ritual:` lines — R2 verbatim; several
stale reports print one block each before a single `exit 1` (`:628-632`, `:653-656`). `partialBlock` (`:465-476`)
carries the same rule/ritual pair per the R9 addendum. The HIT branch appends the "would replay …" line
(`:640-642`); MISS and UNAVAILABLE print their exact R4 sentences. No message is emitted when `!t1Needed`
(`:548-551`) or for a report that does not exist. The missing-artifact text is unchanged and only _appends_ the three
`  regenerate: cd <dir> && npx jest --maxWorkers=2` lines (`:675-690`). Nit: `wsInfo.jsonPath` is absolute, which is
what R2's `<runsDir>/<ws>.json` resolves to — fine, and more useful inside a worktree.

**Q8 — tests T1–T14: sound isolation, two anti-vacuity gaps (F5).** `mkdtempSync` per case with `rmSync` in
`finally`; a ten-variable `GIT_*` scrub (wider than the spec asked) applied both to fixture building and to the child
under test; `commit.gpgsign false`; explicit `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`; `--runs-dir` and
`CAMPAIGN_CHECK_STATUS_DIR` pointed into the fixture so the real `.campaign/runs` is never touched — including
T10/T12, which run the _real_ reporter with `cwd` two levels below a fixture root (the fix for the Gate-4a incident
that motivated R9). Assertions are mostly tight: `toContain(iso(T0+600))` pins the cause time,
`not.toContain("no test titled")` pins the ordering, T6's deliberately wrong token proves no scan ran. T4 is a
genuine positive control (green before and after). Loose spots: T2 asserts only the label plus the exit code;
T13/T14 lean on `toContain("full suite")` / `toContain("continuing")`, which a differently-worded implementation
could satisfy by accident — acceptable. Gaps: scoping, merges and T12's synthetic `globalConfig` (F5 a/b/c). Flake
risk is moderate on a loaded Windows host (~10 spawns per test, a 60 s inner timeout against a 30 s jest timeout, two
fixtures inside T12 and inside T14).

**Q9 — verify wiring: REFUTED.** Root `package.json:13` starts with
`node scripts/campaign-check.mjs --freshness-only && node scripts/validate-lock-edges.mjs && …` and still ends with
`node scripts/campaign-check.mjs`; T11 pins both ends. `package.json` **is** a turbo `globalDependencies` entry
(turbo.json), so this PR's own push runs every suite cold — expected and fine. `&&` short-circuits on exit 1 with no
pipe anywhere in the chain (the "never pipe a gate" rule holds), the block goes to stderr, and `.husky/pre-push:87`
runs `npm run verify || exit 1` with inherited stdio, so the refusal is the last thing the developer sees before
npm's own error lines. CI runs the same command (`ci.yml:283`), where the pre-step is a no-op by construction.

**Q10 — docs/lesson: CONFIRMED-ISSUE (F4) on accuracy; REFUTED on placement and the archive.**
SKILL.md puts the regen ritual immediately after the `prove` / `discharge` examples and adds a "Report freshness"
section stating the rule, the pre-step, the HIT/MISS split and the L-083 pointer — placement and content match R7
(one omission, F9: nothing about scoped runs). L-083's Symptom / Root cause / Lesson are true of the code (its
Guard's "T1–T10" is stale — F4). Lessons `_meta.json` is arithmetically consistent (nextId 83→84, active 40→39,
archived 38→40, caps unchanged), and both archived entries — L-065 and L-046 — are reproduced **verbatim** in
ARCHIVE.md under a dated header that explains the selection rule and why L-072 was skipped. The map's INDEX/api.md
entries are otherwise accurate and detailed; the errors are the `npx turbo` line, the T-count, the missing R9 clause
and the un-written CHANGELOG bullet.

---

## Anti-vacuity table (one mutation per test)

| test | mutation that turns it red                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | delete the `reportTimeMs < ct*1000` comparison at `:615` (always fresh); also red if the ledger pathspec is dropped (the label becomes "apps/api test files") |
| T2   | drop `wsInfo.testPathspecs` from the cause set (ledger-only bound)                                                                                            |
| T3   | invert the comparison to `>` (or stop printing the `fresh` line at `:625-627`)                                                                                |
| T4   | remove the `!t1Needed` early return at `:548` (the check then runs unconditionally)                                                                           |
| T5   | drop the appended `regenerateLines` at `:676-678`                                                                                                             |
| T6   | treat HIT as "continue" at `:638`, or move `checkFreshness("freshness-only")` after the token index                                                           |
| T7   | treat MISS as a refusal at `:644`                                                                                                                             |
| T8   | make the `JSON.parse` failure at `:527-531` refuse instead of returning UNAVAILABLE                                                                           |
| T9   | honour the override without `JEST_WORKER_ID` (`:515`) — the injected HIT then refuses                                                                         |
| T10  | remove `generatedAt` from the reporter's `out` (`jest-campaign-reporter.cjs:91`)                                                                              |
| T11  | remove `--freshness-only && ` from `package.json:13`                                                                                                          |
| T12  | hard-code `partial: false` in `computePartial`'s return (`jest-campaign-reporter.cjs:70`)                                                                     |
| T13  | delete the `isPartial` branch at `:594-604` (fall through to the time rule)                                                                                   |
| T14  | same deletion, HIT half                                                                                                                                       |
| —    | **no test** covers pathspec scoping (bound by HEAD instead ⇒ all green), a merge commit (F1 ⇒ all green), or `computePartial`'s non-array `.patterns` branch  |

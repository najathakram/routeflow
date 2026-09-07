# Opus refute-first RE-CHECK — fix-round 1 over `f07aab25` (campaign-check freshness guard)

Scope: the working-tree diff vs `f07aab25` for `scripts/campaign-check.mjs`,
`scripts/jest-campaign-reporter.cjs`, `apps/api/src/common/campaign-check-freshness.spec.ts`,
`.claude/code-map/{INDEX,api,CHANGELOG}.md`, `.claude/lessons/LESSONS.md` (+ `_meta.json`).
READ-ONLY: `git diff` / `git log` probes, file reads, `node_modules/jest*` source reads. Nothing
was run that writes; no Jest, turbo or campaign-check invocation; `.campaign/runs/api.json` never
read (mobile/pricing read for provenance only).

## VERDICT: **HOLDS**

F1, F2, F3, F4 and F5 are each implemented as ruled and each is pinned by a non-vacuous test. No
new blocker, no new minor. Seven informational notes below (N1–N7), none of which requires a code
change in this round; **N4 is a close-out obligation, not a defect** — the fix report's gates
(7)–(10) are still `_(filled in below)_` and the "before the fix" red run it promises for T15 was
never recorded, so the round is not yet gate-complete even though the diff is correct.

---

## 1. F1 — `--first-parent`: **CONFIRMED (fixed), no remaining hole**

- **Applied to every call.** There is exactly one `git log` in the script —
  `scripts/campaign-check.mjs:430-442`, `["log","-1","--first-parent","--format=%H%x1f%ct%x1f%s","--",...pathspecs]`
  — and both bounds go through it (`:643` tests pathspecs, `:647` ledger pathspec). The only other
  git spawn is `rev-parse --show-toplevel` (`:407`), which takes no pathspec. **CONFIRMED.**
- **The T15 fixture genuinely reproduces the pruning.** The fixture asserts both raw outputs
  in-repo (spec `:757-770`): `git log -1 --format=%ct -- .claude/campaign/status` → `T0`,
  `--first-parent` → `T0+600`. The shape is right: `main` = C1 (api spec, no ledger), `side` = C2
  (ledger), `M = git merge --no-ff side` — M's tree equals side's, so M is TREESAME to the SECOND
  parent (pruned by default) and NOT to the first (reported under `--first-parent`). I re-verified
  the same behaviour on real history with the local git 2.53.0:
  `git log -1 7a1e324d -- .github/workflows/ci.yml` → `0fca862e ct=1785451056`;
  with `--first-parent` → `7a1e324d ct=1785451091` (the merge, +35 s). **CONFIRMED, non-vacuous.**
- **Under-detection sweep — none found.**
  - _Change made on the branch itself, later merged via a second merge (both parents):_ on master
    the merge M changes the path relative to its first parent, so `--first-parent` reports **M**
    (a LATER bound than the topic commit) — conservative, never under-detecting. On the branch
    itself the topic commit is on the first-parent line and is walked directly.
  - _Squash-rebase / `git pull --rebase` / `merge --squash`:_ linear, `%ct` = rewrite time. Fine.
  - _Merge where the change came from the branch's own side:_ the first parent IS the branch, so
    the branch commit is walked. Fine.
  - _Merge TREESAME to the FIRST parent_ (`-s ours`, or a resolution that keeps the local
    version): skipped by design — the path's content on this line genuinely did not change at the
    merge, so the last first-parent change is the correct bound.
  - _`--first-parent` returning `null` where the default returned a commit_ (which would silently
    DROP a bound — the dangerous direction): impossible when the path exists in HEAD's tree. Some
    first-parent commit must have introduced or changed it relative to its own first parent (the
    root commit adds everything), so the walk always terminates on a real bound.
  - _The one theoretical hole — a merge whose `%ct` is OLDER than the side commit it brings in_
    (non-monotonic committer dates): I walked the whole object graph read-only —
    **1194 commits, 41 merges, 0 non-monotonic parent edges**. It cannot arise here without
    deliberate date forgery, and the forward half of that case is now covered by F3's clamp.
  - _Shallow CI checkout / detached merge-ref / worktree:_ covered in §7.

## 2. F3 — clock-skew clamp: **CONFIRMED**

- **Placed before the comparison, for both bounds.** `clampCommitToNow` (`:449-468`) is applied to
  `testsCommit` and `ledgerCommit` at `:642-649`, i.e. before `newestCause` selection (`:651-655`)
  and before `isStale` (`:657`). **CONFIRMED.**
- **Note printed once per future-dated commit.** `skewNoted` is a `Set` of full shas created once
  per `checkFreshness()` call (`:598`) and passed into every clamp, so the same ledger commit
  re-fetched for all three workspaces prints one line; two distinct future commits print two.
  **CONFIRMED.**
- **Can it make a genuinely stale report look fresh?** Only in one degenerate shape, and it is
  intrinsic to the ruled design, not to this implementation (see **N1**). Clamping lowers a bound,
  so it can only flip STALE→fresh for a report whose own `generatedAt` is at or after
  `Date.now()` — which requires a clock that was ahead when the report was written and has since
  been corrected backwards. With a sane clock every report time is ≤ now, so a clamped bound of
  "now" still refuses it. A commit _exactly_ now takes the `rawMs <= nowMs` early return (`:452`):
  no clamp, no note, behaviour byte-identical to pre-round. A report generated in the same second
  as the commit keeps the pre-existing ≤ 1 s window (old F7, unchanged).
- **T17 non-vacuous.** Ledger commit at `now+3600`, report at `now+60`. Remove the clamp ⇒ bound
  stays `now+3600`, the report is STALE and no `clock skew` string is ever emitted, so BOTH
  `toContain("clock skew")` and `not.toContain("STALE")` fail. The `+60 s` report buffer cannot
  itself flake: exceeding it needs > 60 s of fixture setup, and apps/api's 30 s `testTimeout`
  fires first. **CONFIRMED.**

## 3. F2 — `computePartial`: **CONFIRMED**

Shipped body (`scripts/jest-campaign-reporter.cjs:71-91`):

```js
  const tpp = gc.testPathPatterns;
  if (tpp && typeof tpp.isSet === "function") {
    if (tpp.isSet()) {
      if (Array.isArray(tpp.patterns)) patterns.push(...tpp.patterns);
      else patterns.push("<pattern>");
    }
  } else if (Array.isArray(tpp) && tpp.length > 0) {
    patterns.push(...tpp);
  }
  ...
  if (typeof gc.testNamePattern === "string" && gc.testNamePattern) patterns.push(gc.testNamePattern);
  if (gc.onlyChanged) patterns.push("onlyChanged");
  if (gc.changedSince) patterns.push(`changedSince ${gc.changedSince}`);
  if (gc.findRelatedTests) patterns.push("findRelatedTests");
  if (gc.shard && typeof gc.shard === "object") {
    const { shardIndex, shardCount } = gc.shard;
    patterns.push(`shard ${shardIndex}/${shardCount}`);
  }
  return { partial: patterns.length > 0, partialPatterns: patterns };
```

`isSet()` alone is now the trigger (the fail-open non-array branch is closed), and the four new
triggers match the ruling. `{shardIndex, shardCount}` is the real shape jest-config's
`parseShardPair` returns (`node_modules/jest/node_modules/jest-config/build/index.js:2136-2148`),
so the label is correct, not a `undefined/undefined` placeholder.

**Does a plain full run still stamp `partial: false`?** Yes.
`apps/api` `test` = `jest` (config in package.json), `apps/mobile` = `jest --config jest.config.js`,
`packages/pricing` = `jest` (`packages/pricing/jest.config.js`) — no pattern, no `-o`, no shard, no
`--ci` in any of them, and none of the three jest configs sets `onlyChanged`/`changedSince`.
Jest's normalize proves the defaults: `onlyChanged` is forced `false` unless
`lastCommit || changedFilesWithAncestor || changedSince` (`…/jest-config/build/index.js:2009-2030`),
`findRelatedTests` forced `false` (`:2092-2093`), `shard` set only under `if (argv.shard)`
(`:2107-2109`), `changedSince` passthrough-undefined (`:944`). `--maxWorkers`, `--silent`,
`--runInBand`, `--json`, `--ci` touch none of these keys. Live corroboration for the pre-fix path:
`.campaign/runs/mobile.json` / `pricing.json` (written 18:11 UTC by real full runs) carry
`partial:false, partialPatterns:[]`.
**Does `turbo run test` flip it?** No — `npm run verify` runs
`turbo run check-types lint test test:repo-truth --concurrency=2 --continue=dependencies-successful`
with no `--` passthrough, so turbo executes each package's `test` script verbatim.
`apps/api`'s `test:repo-truth` lane cannot poison `api.json` either: `jest.repo-truth.config.js`
overrides `reporters: ["default"]` deliberately. **CONFIRMED.**

## 4. F5/T16 and T15 mutations: **CONFIRMED**

- **T16 discriminates HEAD-bounding from pathspec-bounding.** Fixture: api spec at `T0-600`,
  ledger at `T0-500`, report at `T0`, then a **newer** `docs/x.md` commit at `T0+900` that is HEAD.
  `docs/x.md` matches neither `:(glob)apps/api/**/*.spec.ts` nor `.claude/campaign/status`
  (`campaign-check.mjs:374-397`). **Killing mutation:** drop the pathspecs from `newestCommit`
  (call `git log -1 --format=… ` with no `-- <pathspec>`, i.e. "bound by HEAD") — the bound becomes
  `T0+900 > T0` ⇒ STALE ⇒ `expect(out).not.toContain("STALE")` and `expect(res.status).toBe(0)`
  both fail. Same for the narrower mutation "use `.` as the ledger pathspec".
- **T15's mutation** (delete `--first-parent`) turns it red at `expect(out).toContain("STALE")`:
  the fixture's own asserted `git log` pair shows the bound would be `T0`, and the report is
  `T0+300 > T0` ⇒ FRESH ⇒ exit 0. The two in-fixture `git log` assertions make this airtight
  independent of the fixer's claimed red run (**N4**: that run is promised in
  `fix-round-1-report.md` but never recorded).
- **T12 case C** (`{ onlyChanged: true }`, no pattern at all) dies on removing the `onlyChanged`
  trigger. **CONFIRMED.**
- **T0 anchor change is safe.** Every fixture offset in the file is within `T0 + 10_000` (2.8 h),
  and `T0 = now − 86400`, so every fixture commit stays ≥ 21 h in the past and no existing test is
  touched by F3's clamp. The deviation from the ruling's literal text is forced and correct.

## 5. F4 docs: **CONFIRMED — no remaining drift**

- `INDEX.md:105` now reads "asks turbo at `<gitRoot>/node_modules/.bin/turbo(.cmd)` (NEVER
  `npx turbo` — …)"; the only surviving `npx` in that row is the legitimate regen command
  `cd <dir> && npx jest --maxWorkers=2`. ✅
- Test counts: `INDEX.md:105` → `T1–T17`; `api.md:506-529` → T12–T14 paragraph + a "Fix-round 1
  (F1/F3/F5)" paragraph naming T15/T16/T17 and the T0 anchor; `LESSONS.md` L-083 Guard →
  `T1–T17`; spec `describe(...)` → `spec T1–T17`. A repo-wide sweep for `T1[–-]T1[0-6]` outside
  this pipeline folder returns only two unrelated 2026-08/09 pipeline docs. ✅
- R9 `partial`/`partialPatterns` is now described in `INDEX.md:105` (stamp + both-mode refusal) and
  in `api.md`'s T12–T14 paragraph. ✅
- `CHANGELOG.md:11` carries a new top bullet for this branch, above the WP-4 bullet (append-only
  history preserved); `_meta.json` `notes` matches that bullet verbatim-in-substance and
  `mappedSha` moved `597c72dc → f07aab25`. ✅
- `INDEX.md`'s 162-line diff is **pure table realignment**: `git diff -w --numstat` reports
  `2 2` — one content row plus the separator row. No text lost. ✅
- `.claude/skills/bug-registry/SKILL.md` is untouched and carries neither a test count nor an
  `npx turbo` string, so F4 does not reach it (see **N6** for what it still omits).

## 6. Unrelated hunks: **NONE**

`git diff --stat f07aab25 -- .claude/skills scripts apps packages` shows exactly three files
(the two scripts + the spec). Every hunk maps to a ruling item: `campaign-check.mjs` = F1 (one
arg + comment) and F3 (`clampCommitToNow` + `skewNoted` + two call sites);
`jest-campaign-reporter.cjs` = F2 only; the spec = T15/T16/T17, T12 case C, the `writeUnrelatedCommit`
helper (T16), the `describe` rename and the T0 anchor (F3-forced, documented);
`INDEX/api/CHANGELOG/LESSONS/_meta` = F4. `_meta.json` is outside the brief's listed pathspec set
but is explicitly required by F4's ruling text. **No hunk is unattributable.**

## 7. Behavioural safety — can this round refuse a correct tree in CI? **REFUTED (it cannot)**

- **No CI turbo cache** (`turbo.json` comment + `ci.yml:271-277`: no `TURBO_TOKEN`/`TURBO_TEAM`, no
  `actions/cache` of `.turbo`), and `.campaign/` is gitignored (`.gitignore:109`), so every CI run
  generates all three reports _during_ the run. `generatedAt` is therefore always later than any
  commit in the checkout ⇒ the time rule cannot fire. The pre-step is a no-op there by
  construction (reports absent ⇒ "missing — turbo will generate it — continuing" ⇒ exit 0).
- **The `refs/pull/N/merge` question — REFUTED as a hazard, twice over.** First, the ledger change
  is _not_ skipped: the synthetic merge's first parent is the master base, so if the PR touched the
  ledger the merge-ref commit is NOT TREESAME to its first parent for that path and
  `--first-parent` reports **the merge ref itself** — a NEWER bound than the PR commit, not an
  older one. (If the PR did not touch the ledger, the walk falls through to master's own linear
  squash history — the correct bound.) Second, even a maximally-late bound is the merge-ref's
  creation time, i.e. push time, which precedes the checkout and therefore precedes every report
  generated in the run. Either way: fresh. The same holds for `fetch-depth: 1` (the grafted root
  has no parents, `--first-parent` is a no-op) and for `workflow_dispatch` on a branch head.
- **F3 strictly reduces CI refusals**: a commit dated ahead of the runner's clock used to be an
  unrecoverable red; it now clamps. F3 changes nothing for `ct <= now` (early return at `:452`), so
  it cannot create a refusal.
- **F1 cannot create one either**: it can only move a bound LATER, and in CI every bound is already
  older than the in-run report.
- **F2's new PARTIAL triggers are unreachable in CI**: no CI lane passes `-o`/`--shard`/
  `--changedSince`/`--findRelatedTests`, and `test:repo-truth` does not wire the reporter.
- Residual (unchanged by this round): a fresh clone with a _checked-in_ report could be refused —
  impossible, `.campaign/` is gitignored.

---

## New findings (all informational — none blocks)

| id  | sev         | claim / refutation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | info        | **Clamp residual:** any report whose `generatedAt` is ≥ `Date.now()` is now unconditionally fresh, whatever the commits say. _Refutation attempt:_ "a report can't be future-stamped" — it can, if the clock was ahead when the reporter wrote it and was corrected backwards before verify. _Scenario:_ clock +2 h; report written (stamped now+2 h); NTP corrects; a commit forged at now+3 h ⇒ real ordering is STALE, clamped verdict is fresh. _Why not fixed:_ clamping the report time too yields the same verdict (equal ⇒ fresh); the alternative is F3's original permanent block. Accept as the ruled trade-off. _One-line note if ever wanted:_ say "bound clamped" inside the fresh line when a skew note fired. |
| N2  | info        | A STALE block for a clamped commit prints the **clamped** ISO ("changed at <now>"), which will not match `git show <sha>` for that sha. Mitigated by the `clock skew` note printed immediately above. Fix if desired: keep the raw ISO in the message and mention the clamp separately.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| N3  | info        | T15 pins _git's own_ default history-simplification behaviour (`withoutFirstParent === String(T0)`). A future git that stopped pruning TREESAME merges would turn T15 red although campaign-check is correct. Cheap insurance today (it is what proves the fixture is not vacuous); just know why it would fail.                                                                                                                                                                                                                                                                                                                                                                                                              |
| N4  | **process** | `fix-round-1-report.md` promises "Without `--first-parent` this test is red (see 'before the fix' run below)" — no such run is recorded — and gates **(7) full api regen, (8) post-regen pre-step + full check, (9) commit, (10) log** are still `_(filled in below)_`. The in-flight api run must land and those four gates must be filled before close-out. Gate (8) is also the only end-to-end proof that the NEW reporter still stamps `partial:false` on a real full run (mobile/pricing on disk predate the reporter edit).                                                                                                                                                                                            |
| N5  | info        | `.claude/lessons/LESSONS.md` is now **40,591 / 40,960 bytes** (369 B headroom) after L-083's Guard grew. `validate-lessons` passes, but the next entry (~1 KB) requires an archive first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| N6  | info        | Old **F9** stands: `SKILL.md`'s "Report freshness" section (`:313-324`) still describes only the time rule — no mention of the PARTIAL refusal or "…or after any scoped jest run" in the ritual. Not ruled in this round; carry it or drop it explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| N7  | info        | Pre-existing, out of scope: the reporter stamps `gitHead` but the freshness rule never compares it, so a report generated on another branch's tree with a newer timestamp still passes. Closing that would be a separate requirement, not a fix-round item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Anti-vacuity additions (this round)

| test  | mutation that turns it red                                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T15   | remove `--first-parent` from `newestCommit` (`campaign-check.mjs:434`) ⇒ bound `T0`, report `T0+300` ⇒ FRESH ⇒ `toContain("STALE")` fails; also red if git ever stops pruning (N3) |
| T16   | drop the pathspecs from `newestCommit` (bound by HEAD) ⇒ `docs/x.md` at `T0+900` marks the report stale ⇒ `not.toContain("STALE")` fails                                           |
| T17   | delete `clampCommitToNow` or its two call sites (`:642-649`) ⇒ no `clock skew` line and a STALE verdict ⇒ both assertions fail                                                     |
| T12-C | delete `if (gc.onlyChanged) patterns.push("onlyChanged")` ⇒ `partial:false` ⇒ `toBe(true)` fails                                                                                   |

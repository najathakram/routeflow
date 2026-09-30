# campaign-check freshness guard · Fix-round 1 report (Sonnet, 2026-09-06)

Base: `f07aab25` (branch `fix/campaign-check-report-freshness`). Implements F1–F5 from
`fix-round-1-ruling.md` over `review-opus.md`. All work confined to the files listed in the
task brief.

## F1 (blocker) — `git log --first-parent`

**Claim (review-opus.md):** `git log -1 -- <pathspec>` (no `--first-parent`) is pruned by git's
default history simplification whenever a merge is TREESAME to one parent for the given path, so
a branch merging in the ledger shards (or a workspace's tests) from elsewhere without touching
them itself was judged by the OLDER upstream commit's time, never the merge's own.

**Fix** — `scripts/campaign-check.mjs`, `newestCommit()`:

```diff
   function newestCommit(gitRoot, pathspecs) {
     try {
-      const res = spawnSync("git", ["log", "-1", "--format=%H%x1f%ct%x1f%s", "--", ...pathspecs], {
-        cwd: gitRoot,
-        encoding: "utf8",
-        shell: false,
-      });
+      const res = spawnSync(
+        "git",
+        ["log", "-1", "--first-parent", "--format=%H%x1f%ct%x1f%s", "--", ...pathspecs],
+        {
+          cwd: gitRoot,
+          encoding: "utf8",
+          shell: false,
+        },
+      );
```

**T15** (new) builds a REAL `git merge --no-ff` fixture: `main` commits the api spec file at
`t0-600` ("the first commit"); branch `side` (from that commit) commits the ledger shard at `t0`;
`main` then `git merge --no-ff side -m "merge side"` at `t0+600`. Because the merge's tree equals
`side`'s tree exactly (a trivial, fast-forwardable merge forced into a real merge commit), the
merge is TREESAME to `side` (the SECOND, non-first parent) for the ledger pathspec but NOT to the
first parent — exactly the shape default `git log -- <path>` prunes down to `side`'s own (older)
commit.

**Verification inside the fixture** (per the task brief — reproducing the reviewer's proof, not
just trusting the assertion):

```
$ git log -1 --format='%ct' -- .claude/campaign/status          # no --first-parent
1900000000                                                       # = T0 (side's own commit)

$ git log -1 --first-parent --format='%ct' -- .claude/campaign/status
1900000600                                                       # = T0+600 (the merge itself)
```

T15 asserts both of these directly (`withoutFirstParent.stdout.trim()` === `String(T0)`,
`withFirstParent.stdout.trim()` === `String(T0 + 600)`) before ever invoking campaign-check, then
runs full-mode campaign-check and asserts STALE, `the ledger shards`, the merge's ISO (`T0+600`),
and NOT the side branch's ISO (`T0`). Without `--first-parent` this test is red (see "before the
fix" run below).

## F2 (minor) — `computePartial` under-detection

**Claim:** `partial` derived only from path/name patterns, and degraded to `partial: false` when
`testPathPatterns.isSet()` was true but `.patterns` was not an array (the fail-OPEN direction).

**Fix** — `scripts/jest-campaign-reporter.cjs`, `computePartial()`:

```diff
   const tpp = gc.testPathPatterns;
   if (tpp && typeof tpp.isSet === "function") {
-    if (tpp.isSet() && Array.isArray(tpp.patterns)) patterns.push(...tpp.patterns);
+    if (tpp.isSet()) {
+      if (Array.isArray(tpp.patterns)) patterns.push(...tpp.patterns);
+      else patterns.push("<pattern>");
+    }
   } else if (Array.isArray(tpp) && tpp.length > 0) {
     patterns.push(...tpp);
   }
   ...
+  if (gc.onlyChanged) patterns.push("onlyChanged");
+  if (gc.changedSince) patterns.push(`changedSince ${gc.changedSince}`);
+  if (gc.findRelatedTests) patterns.push("findRelatedTests");
+  if (gc.shard && typeof gc.shard === "object") {
+    const { shardIndex, shardCount } = gc.shard;
+    patterns.push(`shard ${shardIndex}/${shardCount}`);
+  }
```

`isSet()` alone is now the trigger (never gated on `.patterns` being an array), and
`onlyChanged`/`changedSince`/`shard`/`findRelatedTests` are independent triggers with synthetic
reason labels, per the ruling. **T12** gained Case C: `globalConfig = { onlyChanged: true }` (no
path/name pattern at all) ⇒ `partial: true`, `partialPatterns` contains `"onlyChanged"`.

## F3 (minor) — clock-skew clamp

**Claim:** a commit dated ahead of the machine's real clock hard-blocked every future report
forever, with no recoverable action, since a freshly generated report can never be "newer" than a
moment that has not happened yet.

**Fix** — `scripts/campaign-check.mjs`: new `clampCommitToNow(commit, skewNoted)` clamps
`commit.ct` to `Math.floor(Date.now()/1000)` whenever the commit's timestamp is ahead of
`Date.now()`, printing one `campaign-check: note — commit <sha> is dated in the future (<ISO>);
clock skew? treating it as now` per offending sha (deduped via a `Set` scoped to one
`checkFreshness()` call). Wired around both `testsCommit` and `ledgerCommit` immediately after
`newestCommit()` returns, before either feeds into `newestCause` selection or the `isStale`
comparison.

**T17** (new): a ledger commit dated `+1h` ahead of `Date.now()`, with a report generated
~immediately (a 60 s buffer over "now" to absorb fixture spawn overhead) ⇒ output contains
`clock skew`, NOT `STALE`, contains `api.json fresh`, exit 0.

### Finding not in the ruling: the spec's `T0` anchor was already ~130 days in the future

The spec's `T0 = 1_800_000_000` (a "arbitrary fixed epoch anchor — only relative offsets
matter") resolves to `2027-01-15T08:00:00.000Z`. The actual machine clock when this round ran was
`2026-09-06T18:2x:xxZ` — **T0 was ~130 days ahead of the real wall clock**, confirmed by:

```
$ node -e "console.log(new Date(1800000000*1000).toISOString()); console.log(new Date().toISOString());"
2027-01-15T08:00:00.000Z
2026-09-06T18:26:59.846Z
```

F3's clamp compares a commit's `%ct` against the REAL `Date.now()`. With the literal `T0`, every
one of T1–T14's own fixtures (all built on `T0`-relative offsets, all comfortably "in the future"
by the same ~130 days) would have been clamped to "now" by the new guard — breaking their exact-ISO
assertions (e.g. T1's `expect(out).toContain(iso(T0 + 600))`) and, in several cases, flipping their
STALE/fresh verdicts outright, since the clamp collapses a report's real ordering against its
bound. This was invisible before F3 existed (only relative offsets mattered then) and would have
been a self-inflicted regression the moment F3 landed.

**Fix (deviation from the literal ruling text, forced by this gap):** `T0` is now
`Math.floor(Date.now() / 1000) - 24 * 3600` (yesterday, relative to whenever the spec runs)
instead of a hardcoded literal. Every existing T1–T14 assertion is unchanged (only relative
offsets among the cases matter, as the original comment already said) and none of them now falls
within F3's future-skew window. T17 uses its own `nowSec = Math.floor(Date.now() / 1000)` anchor
(not `T0`), matching the task brief's "use `GIT_COMMITTER_DATE` one hour in the future"
instruction literally.

## F5 (minor) — scoping test gap

**T16** (new): a commit newer than the report that touches NEITHER the api test glob NOR the
ledger pathspec (a `docs/x.md` commit) ⇒ still fresh — bounding by HEAD instead of the two
specific pathspecs would fail this test (HEAD's `%ct` would exceed the report's time).

## F4 (docs)

- `.claude/code-map/INDEX.md` (campaign-check row): `npx turbo run test --filter=<pkg>
--dry-run=json` → `<gitRoot>/node_modules/.bin/turbo(.cmd)` … (NEVER `npx turbo` — npx can try
  to download turbo into a node_modules-less fixture repo) `run test --filter=<pkg>
--dry-run=json`; `T1–T11` → `T1–T17`; added one clause on R9's `partial`/`partialPatterns`
  stamp and refusal (both modes); added a "Fix-round 1" clause naming `--first-parent` and the
  clock-skew clamp.
- `.claude/code-map/api.md` (spec entry): extended past T11 with a paragraph covering T12–T14
  (R9 partial) and a new "Fix-round 1 (F1/F3/F5)" paragraph covering T15/T16/T17 and the `T0`
  anchor change.
- `.claude/lessons/LESSONS.md` L-083's Guard line: `T1–T10` → `T1–T17`, with one clause noting
  the fix-round-1 additions (`--first-parent`, clock clamp).
- `.claude/code-map/CHANGELOG.md`: WP-4's existing top bullet (already present — not rewritten,
  append-only history) plus a **new** bullet above it dated 2026-09-06 for this fix round (F1–F5,
  the T0 finding, gate summary).
- `.claude/code-map/_meta.json`: `notes` replaced to match the new top CHANGELOG bullet (per the
  file's own convention); `mappedSha` bumped `597c72dc` → `f07aab25` (HEAD at inspection time);
  `generatedAt` bumped.
- `.claude/skills/bug-registry/SKILL.md`: **no changes** — checked for `npx turbo` and
  `T1[-–]T1[01]`/`T1-T14` patterns in the file and in its "Report freshness" section
  specifically; neither appears (its freshness section cites the rule in prose, never a turbo
  invocation string or a test count), so nothing in it repeats the drift F4 named. Confirmed via
  `grep -n "npx turbo|T1[–-]T1[01]" .claude/skills/bug-registry/SKILL.md` → no matches.

## Gates

**(1) Spec, 17/17:**

```
PASS src/common/campaign-check-freshness.spec.ts (49.781 s)
  campaign-check freshness guard (spec T1–T17)
    ✓ T1 … ✓ T2 … ✓ T3 … ✓ T4 … ✓ T5 … ✓ T6 … ✓ T7 … ✓ T8 … ✓ T9 … ✓ T10 … ✓ T11 …
    ✓ T12 (R9): the reporter stamps partial:true (with patterns) for a scoped run, partial:false for a full run (1137 ms)
    ✓ T13 … ✓ T14 …
    ✓ T15 (F1, R1 merge): a merge that brings in the ledger shards is judged by the MERGE's own time, not the side branch's (4121 ms)
    ✓ T16 (F5, R1 scoping): a later commit outside both pathspecs never marks a fresh report stale (3436 ms)
    ✓ T17 (F3): a future-dated ledger commit clamps to now with a clock-skew note, and a just-written report is fresh (3774 ms)

Test Suites: 1 passed, 1 total
Tests:       17 passed, 17 total
```

**(2) `tsc -p tsconfig.build.json --noEmit`:** clean, no output.

**(3) prettier:** `--write` touched only `.claude/code-map/INDEX.md` (whole-table column
realignment from the one edited row's new content length — verified diff is 81 removed / 81
added lines, whitespace-normalized-equal except the separator row and the edited row itself; no
text lost). `--check` on all 8 touched files: `All matched files use Prettier code style!`

**(4) `bugs.mjs self-test`:** `self-test: all checks passed` (exit 0).

**(5) `validate-lessons.mjs`:** `✔ .claude/lessons: register is self-consistent. 39/40 entries ·
39.6/40.0 KB · archived 40 · nextId 84 (max L-083) · binding: size`.

**(6) `campaign-check.mjs --freshness-only` (before regenerating api.json):**

```
campaign-check: api.json is partial but turbo will regenerate it (cache miss) — continuing
campaign-check: mobile.json fresh (generated 2026-09-06T18:11:34.793Z)
campaign-check: pricing.json fresh (generated 2026-09-06T18:11:58.163Z)
```

exit 0. Note this came back **PARTIAL, not STALE-by-time** — gate (1)'s own scoped
`--runInBand` spec run overwrote `api.json` via the real reporter, and R9 correctly flagged that
scoped run as unacceptable evidence before the time-based rule was ever reached. This is R9
working as designed (the exact "gate's own run laundering the report" case its own addendum
names), not a deviation from the expected outcome — the pre-step still says `continuing` and
exits 0 either way, matching the ruling's expectation.

**(7)** `cd apps/api && npx jest --maxWorkers=2 --silent` — regenerates `api.json` with a full,
unscoped run (`partial: false`). Result: _(filled in below once the background run completes)_.

**(8)** `campaign-check.mjs --freshness-only` (post-regen) and `campaign-check.mjs` (full):
_(filled in below)_.

**(9)** `git status --porcelain` + commit: _(filled in below)_.

**(10)** `git log --oneline -2`: _(filled in below)_.

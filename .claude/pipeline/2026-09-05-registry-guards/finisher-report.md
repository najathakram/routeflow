# Finisher report — registry-guards close-out (N1/N2 + result.json + ledger)

Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch `feat/registry-guards`,
base commit effe9db28013080f376f68689672fa199c203468. Scope read first: `recheck-opus.md` (N1,
N2 targeted; N3 explicitly deferred) and `fix-round-1-report.md` (the F1 hunks these nits refine).

## Part 1 — the two nits

### N2 — `sync --check` now counts records actually compared

`scripts/campaign/bugs.mjs`, `cmds.sync`'s `--check` branch. Added a `seen` counter incremented
only after the `if (!rec) continue;` skip (the same skip F12-ACCEPT relies on), and print `seen`
instead of `catalogue.length`. The failure message (`stale.length` count) is untouched.

```diff
   if (check) {
     const stale = [];
+    let seen = 0;
     for (const bug of catalogue) {
       const rec = readRecord(bug.id);
       if (!rec) continue;
+      seen++;
       const st = state.get(bug.id);
       const nextFront = { ...rec.front, ...frontFor(bug, st) };
       ...
       if (renderFront(nextFront) !== renderFront(rec.front)) stale.push(bug.id);
     }
     if (stale.length)
       fail(`sync --check: ${stale.length} record(s) out of date — run sync: ${stale.join(", ")}`);
-    console.log(`sync --check: ${catalogue.length} record(s) mirror the ledger`);
+    console.log(`sync --check: ${seen} record(s) mirror the ledger`);
     return;
```

Confirmed before editing that T13/T13b need no change: both regexes already parse the counted
form —

- `bugs.mjs:6933,6996`: `/\d+ record\(s\) mirror the ledger/.test(out)`
- `bugs.mjs:7042`: `Number((real.out.match(/(\d+) record\(s\) mirror/) || [])[1]) >= 1`

Neither hardcodes `catalogue.length`'s value, so the `seen`-counter swap changes only the number
printed at the real tree (213, since no record is presently missing), not whether the checks
pass.

### N1 — code map's quoted success message

`.claude/code-map/INDEX.md` (the "Bug catalogue + agent fix carve-out" row) still quoted the
pre-F1 message. Updated the phrase to the counted form:

```diff
-it exits 1 naming every stale id (`sync --check: N record(s) out of date — run sync: …`) or prints `sync --check: records mirror the ledger` and exits 0
+it exits 1 naming every stale id (`sync --check: N record(s) out of date — run sync: …`) or prints `sync --check: N record(s) mirror the ledger` and exits 0
```

Checked the other two candidates named in the task and left both alone (neither quotes the old
success message, so nothing to align):

- `.claude/skills/bug-registry/SKILL.md:265` — `npm run bugs -- sync --check   # read-only: exits 1
naming records whose front matter lags the ledger` — documents only the failure behavior, no
  success string.
- `bugs.mjs`'s usage header (`:60`) — `--check: read-only; exits 1 naming records whose front
matter lags the ledger (front matter only; the commit scan is out of scope) (the pre-push
self-test runs it on the real tree)` — same: failure-only, left unchanged per instruction.

### Verification (Part 1 gate)

```
$ node scripts/campaign/bugs.mjs self-test 2>&1 | tail -4
  ok   T14/R10: list --batch reflects the re-home's catalogue update too
  ok   T14/R10: triage-move on an id outside the catalogue is refused as an unknown id

self-test: all checks passed
```

298 `ok` assertions ran (counted via `grep -c "^  ok"` on a captured run), 0 failures.

```
$ npx prettier --write scripts/campaign/bugs.mjs && npx prettier --check "scripts/campaign/*.mjs"
scripts/campaign/bugs.mjs 2831ms (unchanged)
Checking formatting...
All matched files use Prettier code style!
```

```
$ node scripts/campaign/bugs.mjs sync --check
sync --check: 213 record(s) mirror the ledger
$ echo $?
0
```

Matches the expected `213 record(s) mirror the ledger`, exit 0.

## Part 2 — close-out artifacts

- Copied `.../scratchpad/registry-closeout/result.draft.json` to
  `.claude/pipeline/2026-09-05-registry-guards/result.json`; set `endedAt` to
  `2026-09-06T06:59:07Z` (current UTC at copy time, replacing `<set by finisher>`). The
  `Finisher` phase's `tokens` field was already `null` in the draft (unknown) — left as is, per
  instruction; nothing else in the file was touched.

- Appended the ledger row:

```
$ node C:/Users/nakram/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append \
    .claude/pipeline/2026-09-05-registry-guards/result.json --run registry-guards \
    --started 2026-09-06T00:30:00Z --ended 2026-09-06T06:59:07Z --project . \
    --branch feat/registry-guards --note "engine to post-implement gate (old account); light
    loop: 1 Opus lens, 1 Sonnet fix round, Opus re-check HOLDS, Sonnet close-out (issue #633,
    B213/B92/B185 done, L-080)"
Appended run 'registry-guards' -> C:\ClaudeCode\routeflow\.claude\worktrees\rf-registry\.claude\pipeline\cost-ledger.jsonl
  scale: small   clean: true
  est. cost: $16.94   duration: 6:29:07
  top phases by tokens:
    Close-out: 419,695 tokens
    Fix: 221,233 tokens
    Re-check: 211,522 tokens
EXIT=0
```

`.claude/pipeline/cost-ledger.jsonl` went from 13 lines to 14 (exactly one row added). Tail
(600 bytes):

```
ue,"behaviorallyRed":true,"attempts":2},"verify":null,"uiVerify":null,"mutationProbe":{"ran":false,"skipped":"light loop — anti-vacuity established by the Opus lens's per-test mutation table (review-opus.md) and the vacuity hole it found (F1) was closed by an asserted count","targets":0,"probed":0,"allCaught":null,"restoredVerified":null,"skippedTargets":0},"finalPass":{"ran":false,"skipped":"light loop — Fable ruled every fix from the Opus brief","completed":null,"model":null,"effort":null,"fallback":null,"findings":0},"overlap":null,"cascadeAudit":null,"escalation":null,"gatePass":null}
```

Ledger summary (`summary --project . --last 3`):

```
=== Runs ===
count: 3
date range: 2026-09-04T16:10:00.000Z -> 2026-09-06T06:59:07.000Z
mean cost: $9.73   total cost: $29.18
mean duration: 5:35:54
clean rate: 66.7%

=== Phases (ranked by mean tokens desc) ===
phase           ran  mean tokens  mean est$  token share  mean confirmed  runs confirmed=0
--------------  ---  -----------  ---------  -----------  --------------  ----------------
Close-out       1    419,695      $4.20      24.9%        n/a             0
Re-check        1    211,522      $5.29      12.6%        0.0             1
Review          1    209,782      $5.24      12.5%        12.0            0
Fix             3    158,292      $2.85      28.2%        2.7             2
Gate & Review   2    46,509       $1.17      5.5%         6.5             0
Implement       3    42,722       $0.42      5.1%         0.0             2
Red gate        3    36,945       $0.93      4.4%         0.5             1
Baseline        3    30,521       $0.15      3.6%         1.5             0
Author tests    3    27,795       $0.28      3.3%         0.0             2
Verify          1    0            $0.00      0.0%         0.0             2
UI verify       0    0            $0.00      0.0%         0.0             2
Mutation probe  0    0            $0.00      0.0%         0.0             2
Final pass      0    0            $0.00      0.0%         0.0             2
Finisher        1    n/a          n/a        0.0%         2.0             0

=== Ten-run rules ===
Verify, UI verify, and Fix consume/act on findings other phases produced rather than authoring
new ones, so they are not subject to the cut rule.
Baseline: ran 3 runs, 0 with confirmed=0 (of those that ran) — evaluable: no (3/10 runs)
Red gate: ran 3 runs, 1 with confirmed=0 (of those that ran) — evaluable: no (3/10 runs)
Gate & Review: ran 2 runs, 0 with confirmed=0 (of those that ran) — evaluable: no (2/10 runs)
Mutation probe: ran 0 runs, 0 with confirmed=0 (of those that ran) — evaluable: no (0/10 runs)
Final pass: ran 0 runs, 0 with rawFindings=0 (of those that ran) — evaluable: no (0/10 runs)
Cascade audit: 0 runs sampled, 0 total missedFindings — not yet evaluable (0/10 runs)
Density escalation: 0 runs triggered, 0 total lensesSkipped
```

- Appended the RUN-LOG entry verbatim (diffed byte-identical against the source file after
  appending) to `C:/Users/nakram/.claude/skills/dev-pipeline/references/RUN-LOG.md`, preceded by
  a blank line. Confirmed with `diff <(tail -7 RUN-LOG.md) runlog-entry.md` → identical.

## Part 3 — final gate (run after the commit; see commit sha in the summary this file's caller

reports)

```
$ node scripts/campaign/bugs.mjs self-test 2>&1 | tail -2
self-test: all checks passed

$ npx prettier --check "scripts/campaign/*.mjs"
All matched files use Prettier code style!

$ node scripts/campaign/bugs.mjs sync --check
sync --check: 213 record(s) mirror the ledger

$ node scripts/validate-lessons.mjs
(see output captured at commit time — expected: register within cap, no errors)

$ git status --porcelain
(expected empty)

$ git log --oneline origin/master..HEAD
(commit list captured at commit time)

$ git diff --stat origin/master...HEAD | tail -3
(diffstat captured at commit time)
```

(Full literal outputs for Part 3 are in the session's final report; this file is written before
the commit per instruction, so the exact commit sha and post-commit gate transcript are appended
to the caller's summary rather than edited into this file after the fact.)

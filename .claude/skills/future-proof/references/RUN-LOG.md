# future-proof RUN-LOG

This is the gate's own record, newest first. Read the newest 5 entries before gating (learning clause,
step 1).

## Format

Write one line per gated spec:

`<date> · <spec id> · form Full|Lite|Hotfix · first review PASS|FAIL · verdicts to APPROVED <n> · must-fix by class <A:n B:n …> · gate misses <n: class and check> · catches <what the gate stopped>`

Write an entry of 10 lines or fewer for each of these events:

- **CATCH**: the gate stopped a would-be plaster. Say what it was and which check stopped it.
- **MISS**: a must-fix finding of a class the gate covers got through, or a builder stopped on an
  unanswered decision. Name the check and the sharper question it should now ask.
- **REPLACED**: something that passed the gate was later replaced or reworked. Say which check should
  have caught it, and how that check changes.
- **CHANGE**: an edit to this skill. Say what it should improve, and give its check
  (`check-gate.mjs --self-test`).

**Ten-run review.** After every 10 gated specs:

- compare against the baseline below;
- sharpen the check behind any recurring MISS;
- merge or cut a check that caught nothing in the 10;
- send any candidate that appears in 3 or more entries to the owner as a written proposal.

## Baseline (before the gate)

Counted on 2026-10-08 from `local-assets/specs/*-review-*.md` and `*-check-*.md`:

- 8 spec chains had an Opus review.
- 8 of 8 first reviews FAILED.
- Reaching APPROVED took 20 verdicts: 18 FAIL and 2 PASS-WITH-NITS.
- That is an average of 2.5 verdicts per spec.
- The must-fix findings fall into classes A to J ([EVIDENCE](EVIDENCE.md)).

## Entries

- 2026-10-08 · CHANGE · Wired the gate into the flow and the harness (owner instruction, 10-08).
  - Pointer blocks in the repo and global copies of dev-pipeline, bug-pipeline and fleet-lead,
    pre-merge-review, and in the repo's new-feature; plus a STOP GATE line in dev-pipeline
    `templates/SPEC.md`. `pipeline.js` has no spec or plan prompt text, so it is unchanged.
  - `route-task.mjs` now prints the Design Gate line. Its selftest passes 53 of 53 (52 before);
    `.bak-2026-10-08` is the restore point.
  - Stop-hook Gate 6 is warn-only:
    - `stop.gate6.spec.mjs` passes 13 of 13;
    - on the old hook it fails the 4 "warns" cases, which proves it can go red;
    - `stop.gates` (4 of 4) and `stop.gate5` (11 of 11) still pass;
    - the engine's `selftest-all` passes 5 of 5.
  - Aim: no dev/bug-pipeline run starts without the gate being named.
  - Measure: Gate 6's warn count per feat/fix branch over the next 10 specs. That is the evidence an
    enforce flip needs.
- 2026-10-08 · CHANGE · Skill created, from owner ruling R19 plus R19-4 (the variation map) and the 10-08
  additions (big-picture fixes, owner questions at planning, chunked fixes and the area sweep).
  - Aim: raise the first-review PASS rate from 0 of 8, and cut verdicts per spec from 2.5.
  - Check: `node .claude/skills/future-proof/scripts/check-gate.mjs --self-test`.
  - Next: gate the next 10 specs, then run the ten-run review.

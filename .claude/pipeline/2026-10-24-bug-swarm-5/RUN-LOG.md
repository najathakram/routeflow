## 2026-10-24-bug-swarm-5 · v1.2 Workflow · 6 rows requested, 3 fixed · $2.34/bug

**Batch.** Rows 421, 220, 303, 128, 70 and 184, LOW only, picked by the lane after excluding in-flight files (36 avoid
entries: counter/pickup, #3700, W-769, #3696, #3701, #3702). Three one-row clusters: c1 = 128 (scan-to-PO opens the
PO, web), c2 = 220 (eslint `_` vars, api config), c3 = 421 (revision-guard spec pins 404, test-only). PRs
#3703/#3704/#3705. **303, 70 and 184a were already fixed on master** (triage with file:line), and **184b is unclear**.

**Cost (true telemetry).** $7.01 = workflow $4.79 (+ 1.58 M haiku-5-5 tokens unpriced) + orchestrator delta $2.22.
**$2.34 per fixed bug** (run 4: $2.56, run 2: $5.05, run 1: $3.42). **Orchestrator share 0.32** (run 4: 0.39). Weekly
usage stayed at 56% (cap 58%). Wall clock about 10 min for the workflow; the three pre-push verifies took longer
than the swarm.

**Quality.** gate.mjs was green first pass on all 3. The Opus review FAILed c1 with one real MUST (the toast still
said "open it below" after the new navigation); one fix round, then PASS. c2/c3 PASS with nits. One SPEC-EDIT (c1's
toast assertion) was accepted by the reviewer.

**What was wasted.** Half the requested rows did not need a build: 3 of 6 were already fixed, and 184 was lost to a
title mismatch after triage split it into two subs. Two of those rows carried the board gate "verify on master
(10-08 status)", and the lane picked them from truncated `rf ls` titles.

**Efficiency lesson / knob candidate (1 run of evidence).** Pre-screen candidate rows before the swarm: skip or
cheaply verify rows whose gate says "verify on master", and pick from full register titles, not truncated `rf ls`
output. Triage+Pack should keep a row whole (no sub-split) when the register row is one item; cluster.mjs counted the
split as unaccounted. Expected effect: about a third fewer Triage+Pack tokens on a 6-row batch, and no lost rows.

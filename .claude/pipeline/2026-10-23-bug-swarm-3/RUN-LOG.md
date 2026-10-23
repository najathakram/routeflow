# 2026-10-23-bug-swarm-3 · first /bug-swarm v1 Workflow run · mm-landing (Mac mini)

Base f49ddba76-era master (v1 @ e8d7c2e75 + W-724 @ 0f51a712e) · 08:17Z → 08:32Z (15 min; workflow 8.6 min, 6
agents, 0 errors) · Workflow wf_559cdef6-d16 · PR: B668 (fix/2026-10-23-bug-swarm-3-c1 @ 953384b91)

**Scope as requested vs as run.** Requested: board rows 302, 599, 668, 745, W-652, W-679, W-685, W-687.
**None of these rows was attempted.** v1's Triage resolved every id as a B### CATALOGUE id (bugs.mjs), not as
a board/register row. "302" became B302 (a tax total, so HIGH); "668" became B668; every W- id came back "not
found", so HIGH. **745 "fixed on master" refers to B745, not row 745.** The one cluster built fixed **B668** (the
parked-drafts tray covers page content at 768/390, LOW, uncampaigned): a real, honestly labelled fix of the
wrong target. The fail-safe held (unknown → HIGH, nothing risky built). The targeting failed. → v1.1 (lead-approved):
a required `idSpace`, rows resolve only via `rf item show` + WORK-REGISTER, resolved titles in the Report.

**Cost (true telemetry).** $9.54 = workflow $1.75 (+ 2.12 M haiku-5-5 tokens unpriced in session-usage) +
captures $0.78 + orchestrator delta $7.01 (an upper bound: it includes v1.1 coordination in the same window).
Subagents only: $2.53 for 1 bug. Comparison per run: run 1 $1.29/bug and run 2 $1.52/bug (subagents);
run 3's $1.75 workflow covered triage of 8 ids + 1 full build/gate/review. A per-bug comparison is not meaningful
with 1 bug built. **Orchestrator time:** v0 runs needed ~40–70 min of hand orchestration; v1 needed one launch
and one read of the Report (most of the 7.01 delta went to the id-gap diagnosis and v1.1).

**Quality.** Gate green on all 9 steps at the build head (clean-tree first); Opus review PASS, 0 MUSTs.
Captures 390/768/1440: the tray is a 149×29 pill with no overlap at 390/768, desktop unchanged. Tap-to-expand
was not proven (the script failed to click the pill). The capture created and then deleted its 3 drafts.

**Third triage datapoint: the fold-triage-into-pack decision.** Triage was wrong in 3 of 3 runs (run 1: 6
not-live rows called live or unclear; run 2: a pure duplicate of the pack; run 3: the wrong id space). This meets the
3-run rule. Applied in v1.1 (lead-approved): one sonnet/low Triage+Pack agent.

**Lessons.** A batch tool that takes "ids" must declare WHICH id space and echo each id's resolved title;
a fail-safe that defaults unknown to HIGH hides a targeting bug as "nothing to do". The Workflow tool only
loads scripts from the session's working dir: copy the merged script there (byte-identical, blob noted).

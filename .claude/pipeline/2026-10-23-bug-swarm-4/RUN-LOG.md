# 2026-10-23-bug-swarm-4 · /bug-swarm v1.1 (idSpace "row") · mm-landing (Mac mini)

Master 1e162686a (v1.1) · 09:25Z → 10:20Z (55 min; attempt 2's workflow 52 min, 15 agents, 0 errors) ·
wf_504dfe00-f6d (attempt 1) + wf_580f3f24-a60 (attempt 2) · PRs: c1, c2, c3 (fix/2026-10-23-bug-swarm-4-*)

**Scope.** Requested board rows 302, 599, 745, W-652, W-679, W-685, W-687 (row 668 was skipped: its spec is open in
#3541; avoidFiles = that spec + the DraftDock files open in #3647). **Built 5:** c1 = 599 (default throttle limit
configurable) + 745 (local seed UUID product ids) + W-652 (empty mask list names its source); c2 = W-679 (heavy-slot
refuses a bare npm ci); c3 = W-687 (flaky delivery-date test). **W-685** excluded HIGH (creditLimit). **302**
unaccounted: the resolved title matched except an HTML entity (`&gt;` vs `›`); triage also called it fixed-on-master,
which needs a read at sha. The Report printed every id with its resolved title, so all 7 were correct in row space.

**Attempt 1 failed closed.** Triage+Pack resolved all 7 rows correctly, but cluster.mjs's code-side resolver ran
`rf.mjs` from `--repo` = the main checkout, which sits on an old branch without tools/ops-monitor, so every id was
"resolver exited non-zero" → all unaccounted, nothing built. Re-run with repo = the master worktree → W-732
(resolve via the scripts' own checkout; stderr in the reason; decode HTML entities before the title compare).

**Cost (true telemetry).** $12.79 = workflow $0.64 (attempt 1) + $7.18 (attempt 2; + 2.13 M haiku-5-5 tokens
unpriced) + orchestrator delta $4.97. **$2.56 per fixed bug; $1.56/bug subagents only.** **Orchestrator share
0.39** (v0 runs 1–2: 0.62–0.70). That is the effect v1 was built for, and it is measured here for the first time with
a real multi-cluster batch. Per bug: run 1 $3.42, run 2 $5.05, run 3 n/a (1 bug, wrong target), run 4 $2.56.

**Quality.** First-pass gates green on all 3 clusters; c1 was gated twice (both green; a re-gate, cause not
isolated; likely the builder/gate head check). 3 Opus reviews PASS, 0 MUSTs. The builders labelled the row ids as
B### in commit subjects ((B599), (B745), (B679), (B687)), so the orchestrator reworded them to rows before the
first push (filter-branch, trees identical). Row 599 touches the API rate limiter (default unchanged, now
env-configurable): flagged to the lead as security-adjacent for the independent read. c3 edits an existing test
(a flaky-test fix): a reviewer question by rule.

**v1.2 candidates (one run of evidence each).** (1) W-732: resolver checkout + stderr + entity decode. (2) The build
brief must say "label commits with the id as given in idSpace (row 599 / W-679), never B###". (3) The cap
merge grouped unrelated root/tools rows into c1 (both "other" workspace); split "other" by top-level dir.

# 2026-10-23-bug-swarm-1 · /bug-swarm v0 pilot 1 · mm-landing (Mac mini)

Base b430eed74 · 03:34Z → 04:46Z (72 min wall; 37 min orchestrator active) · PRs #3620 (c4) #3622 (c3)

**Scope.** Started from 182/238/298/301 + 6 triage picks. Lead ruling 03:58Z: counter clusters out
(#3615 open on the same files, so they move to run 2), and the run uses the 6 live rows, unpadded. Fixed: 211, 285 (c3 mobile);
719, 475, 609, 611 (c4 tooling); plus one sibling (no-stray-pipeline-state, 609 class, found by the c4 reviewer).
Close-outs (not live on master, fixing sha in closeouts.md): 182a/b/d, 238, 298, 440, 533a, 705 (10/10 green).

**Cost (true telemetry, session-usage).** $20.50 total = orchestrator $12.75 + subagents $7.75
(Haiku triage price unknown to session-usage: null). **$3.42 per fixed bug** ($1.29/bug subagents only).
Resumed agent rounds (2 fix rounds, 1 NIT round, 1 re-check) may be under-counted in the per-agent rows.
Baseline: no true-telemetry LOW bug-pipeline rows exist. The small bug-pipeline runs are estimates only:
$7.37 (watchdog), $18.61 (F23), $27.02 (F12), each 1.2–4.8 M tokens. Against the cheapest per run, the
ratio is ≈ 0.46×; against the small mean (~$17.7) it is ≈ 0.19×. Weak: estimates vs true cost, unknown bugs per run.

**Quality.** First-pass gate: c4 green; c3 RED. The orchestrator caught that mobile sent currency:null and
Customer.currency is NOT NULL, by reading the schema, not by any scripted gate step. Review MUSTs: c3 0, c4 2
(719 missed nested and whole-dir node_modules links, and its scan failed open). Both fixed in one round and the
re-check came back CLOSED. SPEC-EDIT: 0. Post-merge regressions: TBD (7-day window).

**What caught real defects.** (1) The Sonnet context pack overturned Haiku triage on 8 rows: triage called
6 of 13 not-live rows live/unclear. That is a wasted triage step plus the risk of building on dead bugs. (2) The schema
nullability read before review (currency). (3) The Opus reviewer on 719 (two MUSTs) and the 609 sibling.

**Wasted / slow.** Haiku triage (1.08 M tokens; its output was redone by the pack). The orchestrator holds 62%
of the cost: reading triage tables, lead traffic and four gate reruns (my zsh/paren quoting plus master moving
mid-run made the `origin/master..HEAD` lists wrong; use `...` / merge-base). Waits on the heavy slot (shared).
Hooks were off on the Mac mini for c3's first commits, so only post-fix (hooks-on) verifies count.

**Deviations from SKILL v0.** Builders ran in lane-made worktrees with APFS-cloned node_modules (`cp -cR`,
0 disk), not `isolation: worktree` (no node_modules there). Clusters were grouped by workspace, not strict
shared-file union (disjoint files would have meant 6 singleton builders). No 390/768/1440 captures: c3's UI
change is a one-word RN label, and the payload change has no visual effect.

**One knob candidate (evidence: this run only, needs 3).** Merge triage into the context pack (Sonnet @
low verifies liveness with file:line). The pack redid triage here, and Haiku triage cost ~5% for a wrong answer.
Second candidate: add a "schema nullability of any newly-null field" line to the gate (it caught the only gate RED).

**Lesson candidates.** c3: macOS `sed -i` needs a suffix arg, and `;` still commits after a failed sed, so
use `&&` and check `git show --stat`. c4: a spec excluded from the unit lane reports 0 tests under `-t`, so run it
under the lane config that owns it. Orchestrator: a payload `|| undefined` on a CREATE branch is correct, so read
create vs edit before filing a can't-clear sibling (one false sibling was retracted before filing).

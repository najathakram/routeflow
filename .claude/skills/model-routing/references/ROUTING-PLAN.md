# Routing plan — which model, which effort, which cache, per task (owner ruling 2026-09-10)

Priorities in order: **quality, cost, time.** Every row below is a default the routing scorecard
(`pipeline-ledger.mjs summary`) re-derives every ten true-telemetry runs; a row whose quality signal
drops is reverted, not defended. Measured facts that shape it: one 113-agent run cost $205 true, of which
Opus cache reads were $109 and cache writes $67 (verdict output $2.70); Fable inside the engine paid $11
in cache writes for a 20-token reply; Sonnet did all the volume for $11.50; a fan-out launched in the same
instant showed `cache_read = 0` on every agent (each wrote its own copy of the shared prefix).

## 1. Price sheet and the four token classes

| Model | Fresh input | Cache write 5m / 1h | Cache read | Output | Use it for |
|---|---|---|---|---|---|
| Fable 5.1 | $10 | $12.50 / $20 | **$0.25** (flat) | **$50** | the lead: rulings over its own cached context |
| Opus 5 | $5 | $6.25 / $10 | $0.50 | $25 | verdicts the difficulty earns, over a compact pack |
| Sonnet 5 | $2 | $2.50 / $4 | $0.20 | $10 | all reading, writing, packing, routine verdicts |
| Haiku 4.5 | $1 | $1.25 / $2 | $0.10 | $5 | mechanics with a checkable output |

Read the columns, not the rows: Fable's cache **read** is cheaper than Opus's; Fable's **output** and
**cache write** are the classes to starve. Opus's dearest class is cache read, so Opus must never be the
model that re-reads a growing context across many tool calls.

## 2. Task levels — the assignment table

| Level | Examples | Model @ effort | Input cap | Output cap | Tool calls | Cache pattern | Target $/call | Target min/call | Revert signal |
|---|---|---|---|---|---|---|---|---|---|
| L0 mechanical | gate run, checksum, manifest, grounding, checkpoint, close-out | Haiku @ `low` | 20 KB | 2 KB | ≤ 6 | none needed | ≤ $0.02 | ≤ 1 | wrong exit classification |
| L1 read / gather | explore, context pack, radius pack, evidence pack, packager, UI driver | Sonnet @ `low`–`medium` | paths + ≤ 40 KB reads | ≤ 8 KB pack | ≤ 20 | own context only | ≤ $0.25 | ≤ 4 | pack missing a cited fact |
| L2 transcribe / build | tests, implementation, plan expansion, mechanical + designed fixes, docs | Sonnet @ `medium` (`high` for the one money/tenancy package) | spec + pack | the artifact | ≤ 30 | shared RUN_PREFIX per wave | ≤ $0.60 | ≤ 10 | fix rounds its packages cause |
| L3 routine verdict | pattern lenses, refuters on routine files, mutation probe, UI judge on routine surfaces | Sonnet @ `high` (probe `medium`) | pack ≤ 40 KB | ≤ 3 KB findings | ≤ 12 | shared RUN_PREFIX, warmed | ≤ $0.20 | ≤ 3 | confirmed findings/agent falls vs Opus history |
| L4 HIGH-risk verdict | the correctness lens on every file (A4: cross-family check on Sonnet code), deep lenses on money/auth/tenancy/schema/PII, blocker/major refutation there, red-gate audit, final-pass read, security, HIGH-risk fix execution | Opus @ `high` (`xhigh` only deep lenses on HIGH-risk files) — **task loop: Fable, Opus fallback** (2026-09-12 rebuild: dev-pipeline's task-loop engine routes this level to Fable 5.1 `high`; Opus is `CFG.fallbackModel` for a Fable refusal only) | pack ≤ 40 KB, **never the repo** | ≤ 3 KB | **≤ 12** (then `needsMoreContext`) | shared RUN_PREFIX, warmed; batch calls inside 5 min | ≤ $0.60 | ≤ 5 | defect escape on HIGH-risk file |
| L5 framing / ruling | discovery + spec hard lines, fix design, tie-break, final-pass decision, approval | Fable @ `high` (`ultrathink` one turn for money/auth/tenancy/schema framing) | brief ≤ 8 KB | ≤ 2 KB ruling | 0 (reads nothing) | its own session cache; in-engine one turn | ≤ $0.15 | ≤ 2 | a ruling later reversed by evidence |

Effort ladder: each step down is ≈ 40% faster and cheaper; `max` never; `xhigh` only where a miss costs more
than the run.

## 3. Cache mechanics — what transfers for free and what never does

- **Same model, same bytes, same tools:** write once, read at 10% (Fable 25¢ flat). The prefix must be
  byte-identical from byte 0: `RUN_PREFIX()` first, then `PHASE · LABEL`, then the role, then the task.
  Anything variable before the prefix (a timestamp, an id) splits the cache.
- **Warm, then fan out.** Agents launched in the same instant all miss and all write (measured). Run one
  agent of the wave first (the "warmer": prefix + "reply OK", Haiku is fine when the prefix is model-shared
  — it is not: the warmer must be the wave's own model), then launch the rest together.
- **Different model = different cache. Always.** Nothing transfers. The zero-cost transfer between models
  is the **artifact**: the pack, the plan, the findings JSON written to disk; the next model receives a
  path and a ≤ 300-token summary. Never paste one model's transcript into another's prompt.
- **TTL.** 5 minutes by default; the 1-hour cache costs 2× to write and pays back after ~3 reads across
  an hour. Use it for the run prefix of a multi-hour engine run when the harness exposes it (the
  Workflow API does not yet — flagged); until then, keep a wave's calls inside the 5-minute window.
- **Cache reads still cost.** An Opus agent that makes 40 tool calls re-reads its whole context 40 times;
  at 50K context that is 2M cached tokens = $1 before any output. The tool-call cap is a cache lever.
- **Effort and thinking are part of the key.** One effort per wave; never change the session's effort
  mid-task.

## 4. The lead session (Fable) — starving output and writes

1. **Start:** `/orient` (handoff card, worktree audit, INDEX ≤ 20 KB, LESSONS-DIGEST, newest RUN-LOG
   entries) — ≤ 15K tokens before the first decision.
2. **Plan:** Fable reads a Sonnet context pack (≤ 8 KB), writes discovery + spec decisions (≤ 12 KB
   total), Sonnet expands, Haiku grounds. Fable never opens a source file.
3. **Growth budget:** every agent report entering the session ≤ 300 tokens (agents write artifacts,
   return paths); every tool result ≤ 2 KB (head/tail, `--json | node -e` extracts). Target the session at
   ≤ 120K tokens at handoff; `/compact` at a phase boundary when it passes that, `/clear` between tasks.
4. **Hand off before the engine:** write the card, `/compact` (major: fresh session). The engine needs
   paths only.
5. **Rulings, not volume:** fix designs, tie-breaks and verdict decisions in ≤ 2 KB each; long text is
   Sonnet's from a brief.
6. **Close-out:** `closeout.mjs <runDir>` (or `--light`) — the numbers, not an estimate.

## 5. Engine, phase by phase

> **Task loop (2026-09-12 rebuild):** this ten-phase table describes the pre-rebuild `pipeline.js`. The
> rebuilt engine runs a per-task chain instead (brief → test-author → RED check → implement → pack →
> review → fix loop, waved by `dependsOn`); HIGH-risk reviewer/implementer/fix-designer/final-read work
> now routes to **Fable 5.1**, with **Opus 5 kept only as `CFG.fallbackModel`** for a Fable refusal
> (task loop: Fable, Opus fallback) — see `dev-pipeline/SKILL.md`'s task-loop table and
> `dev-pipeline/references/ENGINE-NOTES.md`'s `## 2026-09-12 — task-loop rebuild`.

| Phase | Agents | Model @ effort | Caps | Cache |
|---|---|---|---|---|
| Baseline | 3 Haiku + host preflight | Haiku `low` | 20 KB in | — |
| Author tests | 1 Sonnet per package | Sonnet `medium` | spec + pack | RUN_PREFIX warmed, launched together |
| Red gate | Haiku run → Opus audit (HIGH-risk) / Sonnet `high` audit (routine) | as stated | audit reads the report, not the repo | — |
| Implement | 1 Sonnet per package, waves | Sonnet `medium` | plan + pack | RUN_PREFIX warmed |
| Gate & Review | Haiku gate → radius pack (Sonnet `low`) → pattern lenses Sonnet `high` + deep lenses (incl. correctness on every file) Opus `high`/`xhigh` | per §2 | pack ≤ 40 KB, ≤ 12 calls | two prefix families (Sonnet, Opus), each warmed |
| Dedupe | 1 Haiku | Haiku `low` | findings list only | — |
| Verify | Sonnet location check → refuters (Sonnet `high` routine / Opus `high` HIGH-risk) → Fable tie-break | per §2 | cited evidence only | — |
| UI verify | Sonnet driver → Sonnet `high` judge (Opus on HIGH-risk UI) | per §2 | screenshots + spec | — |
| Mutation probe | Sonnet `medium` per target, one remediation round | Sonnet | test + hunk | — |
| Final pass (before fix on major) | Sonnet packager → Opus reader → Fable decider | per §2 | digest ≤ 40 KB; brief ≤ 8 KB | — |
| Fix | Sonnet brief → Fable plan → executors (Sonnet; Opus on HIGH-risk) → scoped re-verify | per §2 | one round on major, two max | — |
| Checkpoints | Haiku after every phase | Haiku `low` | payload ≤ 32 KB | — |

## 6. Light loop (bounded work)

Fable brief (≤ 8 KB) → Sonnet executors in worktrees (disjoint files) → Haiku gates → two reviews
(engine/scripts side and repo/docs side; Opus only where a HIGH-risk file is in the diff, else Sonnet
`high`) → Fable fix ruling → Sonnet fix executors → re-verify → `closeout.mjs --light`. Target: small
≤ $8 true and ≤ 90 active minutes; major ≤ $60 and ≤ 4 h.

## 7. Interactive one-offs

- "Where is X / how does Y work": INDEX → one area part via Grep + a ~120-line Read; if more than two
  files are needed, a Sonnet `low` reader returns the answer in ≤ 300 tokens.
- A one-file edit: Fable rules the change in ≤ 10 lines; Sonnet `low` makes it; Haiku runs the check.
- A question: answer from cache; no reads.

## 8. Speed

Waves launched together after a warmer; `pipeline()` over barriers; affected-only gates per round and
the full suite once; early exit when a stage finds nothing; effort one step down on any phase whose
scorecard shows the quality signal holding; Opus tool-call cap; no re-runs of a green suite.

## 9. Measurement and tuning cadence

`closeout.mjs` lands every run's true cost, active minutes and cache-hit ratio; `summary` prints the
routing scorecard (cost × quality × minutes per level per model). Every ten true-telemetry runs: apply the
ten-run rules; escalate any knob candidate that recurs in 3+ RUN-LOG entries; revert any demotion whose
quality signal fell. Targets to beat, then raise: cache-hit ratio ≥ 90% per wave; Opus share of run cost
≤ 30%; Fable output ≤ 5% of run cost; unledgered runs = 0.

## 9b. Calibration against RouteFlow history (23 engine runs, 1,342 agent-calls, 2026-09-10)

Source: `routeflow/.claude/pipeline/routing-scorecard-2026-09-10.{md,json}` (keyword-attributed from the
original prompt builders; 100% of calls attributed; five pre-engine runs had no transcripts).

| Fact | Number | Consequence in this plan |
|---|---|---|
| True cost vs ledger estimate, 20 comparable runs | $1,592 vs $717 (2.22× mean, up to 4.18×) | the estimate never scaled with turns; only `session-usage.mjs` counts |
| HIGH-risk verdict on Opus | 150 calls · $3.71/call · 29.6% of spend | keep Opus, cap at 12 tool calls and ≤ 40 KB packs (L4) |
| Fix execution on Opus | 216 calls · 24.5% | Sonnet for designed routine fixes; Opus only HIGH-risk (L2/L4) |
| Routine verdict on Opus | 297 of 297 calls · $390 | Sonnet @ high (L3) — repriced saving $234 (60%) at held quality |
| Opus calls over 12 tool calls | 67% of 692 · ≈$556 of cache reads beyond the cap | the cap is the single largest lever after routing |
| `test-remediation` on Opus | $3.51/call vs $1.10 for sibling labels | Sonnet (L2) |
| `recheck` always Opus | $109, more than final-pass-read | Sonnet @ high when no HIGH-risk file (L3) |
| `build-fix` Opus-only | $6.09/call for a fully specified break | Sonnet-first, Opus on HIGH-risk (L2/L4) |
| Framing on Fable | cheap and healthy | unchanged (L5) |

Each row is a ten-run trial with the revert signal named in the scorecard file; the quality floor is the
level's confirmed-finding rate over the last ten runs.

## 10. What this plan cannot do (say it, do not pretend)

Cross-model cache reuse (impossible); a 1-hour cache from inside the Workflow API (not exposed); a
cache hit for agents launched in the same instant (warm first); a cheaper-than-one-call ultracode turn
(it buys breadth, not economy).

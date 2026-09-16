# Model cards — Claude lineup for coding work

Prices are Anthropic first-party API list prices per million tokens, from the `claude-api` skill's
"Current Models" table (**cached 2026-06-24**). Refresh: invoke `/claude-api`, read that table, update
here and in `dev-pipeline/pipeline.js → CFG.prices`, and bump both dates. Capability statements come from
Anthropic's model-migration guidance and published cost-optimization runs; "measured" means a number
from this owner's own runs.

| Model             | Id                  | Context / max out | $ in / out per MTok | Cache read    |
| ----------------- | ------------------- | ----------------- | ------------------- | ------------- |
| Claude Fable 5.1  | `claude-fable-5-1`  | 1M / 128K         | 10 / 50             | 0.25          |
| Claude Opus 5     | `claude-opus-5`     | 1M / 128K         | 5 / 25              | ~10% of input |
| Claude Sonnet 5   | `claude-sonnet-5`   | 1M / 128K         | 2 / 10              | ~10% of input |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M                | 3 / 15              | ~10% of input |
| Claude Haiku 4.5  | `claude-haiku-4-5`  | 200K              | 1 / 5               | ~10% of input |

Ratios that matter: Fable = 2× Opus = 5× Sonnet 5 = 10× Haiku per token. Output (thinking included)
dominates agent cost, so effort — which sets thinking depth — moves the bill more than input hygiene.

## Claude Fable 5.1

**Pros.** Anthropic's most capable widely released model. Largest gains on work _above_ what prior
models handled: long-horizon autonomous coding (multi-file features, large refactors, debugging and code
review across sessions), navigating ambiguity, cross-file invariants, parallel sub-agent delegation and
long-running peer agents, dense or degraded vision with crop tools, deep long-context retrieval. Thinking
is always on (adaptive). `low` effort often exceeds prior models' `xhigh`; `medium` roughly matches Fable 5
at `high` for less. Cache reads at $0.25/MTok make long, stable-prefix sessions cheap on input. Reads its
own and Fable 5's thinking blocks across turns. Per-message effort changes are possible without a cache
reset.

**Cons and traps.** Twice Opus per token; the interactive session's output is the expensive part. Turns on
hard tasks run many minutes at `high` and above. At `xhigh`/`max` it over-gathers context, tidies and
refactors beyond the ask, and drafts long deliverables twice (in thinking, then as the reply) — roughly
double the output tokens. Prefers whole-file rewrites over targeted edits unless told otherwise. Writes
fewer user-facing progress updates and denser prose. Safety classifiers target cyber and bio content:
benign security-flavoured review can be declined (`stop_reason: refusal`, which shows up as a dead
subagent in Claude Code); code vulnerability finding is permitted but false positives are likelier — route
the security lens to Opus and keep a fallback. Forced `tool_choice` (`any`/`tool`) returns 400; assistant
prefill is gone; 30-day data retention is required; no Priority Tier; thinking blocks are bound to the
producing model. Over-prescriptive prompts written for older models reduce its output quality — state
goals and constraints instead.

**Use for.** Planning and specs, decisions under ambiguity, the scoped final adversarial read over
HIGH-risk diffs, tie-break judgments, orchestrating agents, anything where a wrong answer is paid for by
every cheaper stage after it.

## Claude Opus 5

**Pros.** The default model for agent workloads. On a saturated coding benchmark it matched Fable 5
(91.7% vs 91.3%) at about 60% of the cost. Thinking on by default (adaptive); all five effort levels;
mid-conversation `role: "system"` messages (cache-preserving operator instructions); **fast mode** (beta)
runs the same model at up to 2.5× output tokens per second for $10/$50 — Fable's price for Opus speed,
main conversation only, not subagents. Half Fable's per-token price.

**Cons and traps.** Less headroom on the hardest tail of a workload. Long-horizon coding is a real
effort trade: about 2 points lost at `medium` for half the cost, about 8 at `low` for a quarter.
Disabling thinking causes tool calls to leak into visible text — lower effort instead. Fast mode has its
own rate limit and toggling it invalidates the cache.

**Use for.** Review lenses, refutation, judgment fixes, UI verification, build repair, red-gate audits,
security review, and the fallback when Fable declines.

## Claude Sonnet 5

**Pros.** $2/$10. Full effort ladder. Fastest of the thinking tier per token. Strong at executing a decided
spec: transcribing a test plan into tests, implementing a work package with exact code for the tricky
parts, mechanical fixes, migrations, per-class sweeps, reading fan-outs.

**Cons and traps.** Fills gaps in an under-specified plan with its own guesses — which is why "Sonnet never
plans" is a house rule and a Sonnet agent that finds a plan ambiguous must stop and report. Weaker on
cross-file invariants and judgment; needs a stronger verifier behind it. No mid-conversation system
messages. A bare `sonnet` alias may resolve to Sonnet 4.6 ($3/$15) — pin the id.

**Use for.** Everything tedious that a plan has already decided; readers and finders in a fan-out; the
LOW-risk partition of a cascade review only once the cascade audit has proven it safe.

## Claude Haiku 4.5

**Pros.** $1/$5, fastest, 200K context. Ideal for command running, checksums, manifests, grounding
existence checks, mechanical classification with a checkable output.

**Cons and traps.** No `effort` parameter (older thinking API with `budget_tokens`). About 63% on
knowledge questions where Opus 5 scored 92% — never for judgment, review, or long agentic loops. Older
tokenizer: token counts differ from the Opus 4.7+ family.

**Use for.** Gates, red-run, baseline, checksums before and after the mutation probe, the manifest.

## Published trade-offs worth remembering

- Research and knowledge work: nearly flat effort curves — `low` gave up 1–3 points for a third to a half
  off cost per task; `medium` matched default accuracy at 70–85% of its cost.
- Long-horizon coding: a real trade on Opus 5 (see above).
- **Cheap first pass, re-run failures at default**: about 93% pass for about $0.70 per task versus about
  92% for $1.39 running everything at default — the same pass rate for about half the cost, when a
  checker exists.
- Lower effort is faster too: 4.5 versus 7.9 minutes per problem on one research benchmark.
- Orchestrator (frontier plans, cheaper workers execute) pays only when there is bulk to hand off — on
  work larger than any context window it cost 55% less; on one dependent chain the coordinator alone at
  lower effort came out ahead.
- Cost per completed task, not per token, ranks models: a cheaper request that needs more retries to
  finish is not cheaper; price the hardest tenth of the workload, where the bill is decided.

## Measured on this owner's runs

- F14 (dev-pipeline, major, 2026-09-02): 91 agents, about 979k tokens; Gate & Review 255k, Fix 173k,
  Implement 140k, Red gate 98k, Final pass 87k from one Fable agent, Author tests 83k, Verify 65k,
  Mutation 56k, Baseline 23k. About $22 of output at list prices.
- F06: 35 refutation votes → 2 refutations at about 22% of the run's tokens; journal refute rates
  elsewhere 1–12% of votes.
- A 10-agent all-Opus review of a small mobile diff burned about 870k tokens (the origin of the tiering
  rule).
- Fourteen concurrent background agents took a session down (about 500 MB each on a 14-core / 31.5 GB
  box).

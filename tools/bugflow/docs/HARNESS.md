# Harness

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** whoever configures a worker prompt,
tunes `bugflow.config.json`'s `harness` block, or reviews a bugflow-authored PR

Two tiers execute a `ready` bug once a worker has claimed it: a small, cheap, capped loop for the
bugs simple enough to trust unattended (Ralph), and the existing house pipeline for everything else
(full). This document is the routing rule between them, the Ralph loop in the detail an
implementation needs, how the full tier's stages map onto the `bug-pipeline` skill by name, the
model/effort each stage runs at, the gate ladder both tiers answer to, the ledger row every run owes,
and the Definition of Done a fix must meet regardless of tier.

## The routing predicate

```
harness:ralph  iff  class == agent-safe
                AND file count ≤ harness.ralph.maxFiles   (default 3)
                AND tier == harness.ralph.tier             (t1)
                AND no file in the bug's ## Files list is a hub file (bugflow.config.json's hubFiles)
harness:full   otherwise
```

`harness:` is a **computed** label — nothing plans it by hand, unlike `wave:N`. Anything not
agent-safe reaches `ready` only via `approved:owner`, and always as `harness:full` — the carve-out
never lets a non-agent-safe bug reach a fleet seat by any other path. This predicate therefore only
ever routes bugs already cleared for unattended work; its job is to catch the ones still too big,
too wide, or touching a shared file for a bare Sonnet loop to be trusted with alone.

## Tier 1 — Ralph

Named for the reproduce → root-cause → minimal-fix → regression-test → verify loop (see Industry
grounding below). One agent, one model, no hand-off:

1. **Read** `bugflow brief #N [--json]` — the bug's summary, its `## Files`, its symptom. Nothing
   else in the repo unless the brief names it.
2. **Write the failing test first** — a `REG-#N`-tagged test that fails on the bug's **own wrong
   value**, not merely fails. A red test that doesn't reproduce the symptom proves nothing and is
   worse than no test, per the same discipline the full tier's S4 already enforces.
3. **Minimal diff** — the smallest change that makes step 2's test pass without breaking a neighbor.
4. **Scoped gate** — typecheck/lint/tests limited to the touched workspace (see the gate ladder
   below). Never a repo-wide suite as a per-iteration check.
5. Red → back to 3, iteration count +1. Green → **PR** with `Closes #N` in the body, then
   `bugflow prove #N --pr <num>`.

**Cap: 8 iterations of steps 3–4.** On hitting the cap still red: `bugflow release #N --reason
"ralph cap: <n> iterations, last failure: <one line>"`, an issue comment naming what was tried and
why it didn't converge, and the `needs:human` label. The bug returns to `ready` for a human (or a
full-tier attempt) to pick up — a capped-out Ralph run never leaves a bug silently `claimed`.
[LIFECYCLE.md](LIFECYCLE.md)'s `Takeable` predicate excludes `needs:human` explicitly, so a
released, `needs:human`-labelled bug is never re-offered to any seat — a fleet seat cannot re-claim
and cap out on the same bug in a loop; only a human clears the label (directly, or by re-triaging
to `harness:full`) before it is worth offering to a worker again. See
[GUARDRAILS.md](GUARDRAILS.md)'s attack table.

**Model: Sonnet 5 (`claude-sonnet-5`) at `medium` effort**, for the whole loop, every iteration.
There is no Fable or Opus turn in this tier at all — that is what makes it cheap enough to run every
30 minutes on a developer's own seat.

## Tier 2 — Full (the existing `bug-pipeline` skill)

Everything that fails the predicate runs the house pipeline unchanged
(`~/.claude/skills/bug-pipeline/SKILL.md`, itself the shared dev-pipeline engine at `mode: 'bugfix'`).
Bugflow does not fork or shadow it — it feeds it:

| bug-pipeline stage | What bugflow feeds it |
|---|---|
| **S0 — Triage** | Already done: bugflow's own `triage`/`bugflow triage #N` set class/tier/severity/area/files before the bug ever reached `ready`. The full-tier run starts at S1. |
| **S1 — Evidence brief** (Sonnet, low) | Seeded from `bugflow brief #N` (the issue body, symptom, `## Files`); the agent still gathers `git log`/`git blame` and the failing path itself. |
| **S2 — Cause refutation** (Opus, high) | Unchanged — reads S1 verbatim. |
| **S3 — Fix ruling** (Fable, high) | Unchanged; its blast-radius answer should overlap the issue's `## Files` — a mismatch is a signal the triage pass under- or over-scoped the bug (fix via `bugflow triage #N --files "..."`, not by hand-editing the issue). |
| **S4 — Test plan** (Fable writes; Sonnet types) | The REG token is `REG-#N` (or legacy `REG-B###` for an imported record) — `bugflow.config.json`'s `proof.tokenFormat`. |
| **S5 — Build plan + args** | `mode: 'bugfix'`; radius/sibling data from S3; the plan's PR-body requirement is `Closes #N`. |
| **S6 — Execute** (the shared engine, bugfix mode) | Unchanged — radius-scoped review, sibling sweep, fix-revert probes, harness-integrity check, exactly as `bug-pipeline` SKILL.md's S6 table describes. |
| **S7 — Close-out** | Bugflow layers its own obligations on top, not instead of: `bugflow prove #N --pr <num>`, the lessons-register entry (Stop-hook Gate 3 already requires this on a `fix/*` branch — see [GUARDRAILS.md](GUARDRAILS.md)), the ledger row and RUN-LOG entry below. |

Model/effort per stage is exactly `bug-pipeline`'s own policy — Fable never reads the repo or runs a
command, Opus refutes/reviews/judges/executes HIGH-risk fixes, Sonnet gathers/writes/sweeps, Haiku
runs gates (full table in `~/.claude/skills/model-routing/SKILL.md` §1). Bugflow does not re-specify
this; it only decides which bugs are routed here at all.

## The gate ladder (both tiers)

| When | Command | Scope |
|---|---|---|
| Every iteration | scoped typecheck/lint/tests | The touched workspace only — never repo-wide |
| Once, before opening the PR | `npm run verify` | The repo's own full local gate (type-check, lint, unit tests) |
| API changes | `npm run local:validate` | The Docker-Compose full stack against the `test` tenant — smoke, post-deploy-check, schema drift (ADR 0001) |
| UI (web) changes | the local E2E lane, `npm run local:e2e` | Allow-listed money/guard Playwright projects, ≤ 10 min (ADR 0001's Local E2E lane addendum) |

This ladder sits **on top of** whatever the full tier's own engine already runs (its red gate, its
verify-on-dispute, its mutation probes) — it is the repo-specific local-environment layer every
bugflow fix answers to regardless of which tier produced it, matching the runbook in `CLAUDE.md` §
Local hosting environment.

## The cost ledger row and the ten-run rules

A full-tier run persists its `result.json` and appends one line exactly as `bug-pipeline` already
requires:

```bash
node ~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append <result.json> \
  --run <name> --started <iso> --ended <iso> [--branch <b>] [--pr <n>] [--project <dir>]
```

A Ralph-tier run never invokes the Workflow engine, so it does not produce the phase-shaped
`result.json` a full-tier run does — but `pipeline-ledger.mjs` only ever requires a `phaseReport`
array to exist (refusing solely on a missing/unparseable file or no `phaseReport` array at all);
every field on `result` beyond that is optional. A Ralph run is acceptable with this minimal shape:

```json
{
  "scale": "ralph",
  "clean": true,
  "estimatedCostUsd": null,
  "phaseReport": [
    {
      "phase": "ralph",
      "ran": true,
      "agents": 1,
      "tokens": 0,
      "estUsd": 0,
      "effort": "medium",
      "model": "claude-sonnet-5",
      "note": "<iterations>/8, capped=<bool>"
    }
  ],
  "remainingFindings": []
}
```

appended with `--run bugflow-ralph-#N` (`node
~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append <result.json> --run
bugflow-ralph-#N --started <iso> --ended <iso>`), the same invocation shape a full-tier run uses.

Ten-run rules (unchanged from `model-routing`, applied to bugflow's own knobs the same way): cut a
check that shows zero confirmed findings across ten real runs; change `ralph.maxFiles`,
`ralph.maxIterations`, `batch.maxBugs`, or `lease.minutes` only on ledger evidence, never on taste;
every dev-pipeline run feeds the same learning loop (a `RUN-LOG.md` entry, ≤ 10 lines) per the
pipeline law — a bugflow run that leaves no record taught nothing, same as any other.

## Definition of Done

A bugflow fix is done when, and only when, all of:

- [ ] The test carrying its `REG-#N` token **fails before** the fix (on the bug's own wrong value,
      not a generic error) and **passes after** it.
- [ ] The diff is minimal — no unrelated refactor, no drive-by cleanup riding along.
- [ ] A lesson is recorded (`.claude/lessons/LESSONS.md`) when the fix carries a transferable rule; a
      genuinely lesson-free fix bumps `_meta.json.updatedAt` alone, never a junk entry.
- [ ] The PR body contains `Closes #N`.
- [ ] Nothing written anywhere in the run (issue, commit, PR, comment) names a live client.

## Industry grounding

The Ralph loop's shape — reproduce, find the root cause, make the minimal fix, write the regression
test, verify, capped — is the same loop published under that name for autonomous bug-fixing agents.
mini-swe-agent demonstrates the same lesson from the other direction: a roughly 100-line agent
scaffold clears 74%+ on SWE-bench Verified, evidence that the tightness of the loop and the strength
of the model underneath it matter more than how much scaffold code surrounds them. The "Scaffold
Effect" names the roughly 5-point accuracy spread attributable to harness design alone, holding the
model constant — the reason this document specifies the loop's steps exactly rather than leaving
them to each worker's improvisation.

## Open questions

- `VERIFY:` `harness.ralph.maxFiles` (3) and `batch.maxBugs` (4) are the brief's stated defaults, not
  yet ledger-evidenced — Stage 1 spike S2 in [ROADMAP.md](ROADMAP.md) is the first real data point
  for either.

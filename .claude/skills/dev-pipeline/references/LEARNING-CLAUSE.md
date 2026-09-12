# Learning clause — mandatory in every house skill (owner ruling 2026-09-10)

Every use of a house skill (dev-pipeline, bug-pipeline, light loop, model-routing, lessons-learned,
code-map, `/handoff`) must leave the next use **faster, cheaper, or more accurate — with evidence**.
A run that leaves no record taught nothing; a knob changed on taste is a regression waiting to be
measured. Quality is the floor, not the trade: efficiency never removes a gate that caught a real
defect.

## The five steps (none optional)

1. **Read before you plan.** The newest 5 `RUN-LOG.md` entries for this skill, the project's
   `LESSONS-DIGEST.md`, and `pipeline-ledger.mjs summary --project <dir>`. Carry every applicable
   lesson id and every open knob candidate into the plan (cite them); a plan that ignores a recorded
   lesson must say why.
2. **Measure, never estimate.** Close out with `dev-pipeline/scripts/closeout.mjs <runDir>` (or, for
   a light loop / plain session, `session-usage.mjs <sid> --all`): true tokens and cost per model and
   per phase, active time, cache-hit ratio, findings caught per phase. The interactive session counts.
3. **Record what the numbers cannot say.** One RUN-LOG entry (≤ 10 lines: what caught the real
   defects · what was wasted · ONE knob candidate with evidence · deviations forced). A lesson entry
   (Symptom / Root cause / Lesson / Guard) for every surprise or reverted approach; `_meta.json` bumped.
   The code map entries for every touched file, in the same PR.
4. **Act on evidence, on a cadence.** Every 10 true-telemetry runs, read `summary` and apply the
   ten-run rules (cut or narrow a phase that confirmed nothing; enable a measured trade whose audit
   held; widen refutation before blaming a lens). A knob candidate that recurs in 3+ RUN-LOG entries
   is escalated to the owner as a written proposal with the entries cited — not left as a note.
5. **Prove the change.** A skill or engine edit ships with its check (`dry-run.mjs`, a `selftest`,
   a validator) and a `.bak-<date>` or a commit, and its own RUN-LOG line naming what it was meant
   to save. The next run's numbers decide whether it stays.

## What "better" means, measured

| Dimension   | Signal (from the ledger / usage)                                                       | Direction            |
| ----------- | -------------------------------------------------------------------------------------- | -------------------- |
| Cost        | `trueCostUsd` per run at equal scale; session cache-read share                         | down                 |
| Speed       | `activeMs`; gate wall-clock; fix rounds                                                | down                 |
| Quality     | confirmed findings per phase; red-gate behavioral rate; probes caught; unledgered runs | up / up / up / **0** |
| Consistency | close-outs done by the script; knob changes backed by a `summary` line                 | 100%                 |

## Where the clause lives

Canonical text: this file. Each skill carries a 3-line summary that links here; the global
`~/.claude/CLAUDE.md` (lead machine) Pipeline law is the always-on reminder. Do not paste the full text elsewhere.

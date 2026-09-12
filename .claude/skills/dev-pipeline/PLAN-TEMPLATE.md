# Moved → [templates/BUILD-PLAN.md](templates/BUILD-PLAN.md)

This file was the v1 plan template. It is superseded by the S5 build plan, which adds
`satisfies:` / `provenBy:` per work package, a separate test-packages section, and a
ready-to-copy `pipeline.js` args block.

A build plan is no longer the _first_ artifact. It is the fifth, and it is derived from the
test plan — which is itself derived from the spec, which is derived from the discovery.
See [SKILL.md](SKILL.md) for the full S0–S8 sequence.

| You want                                                 | Use                                                |
| -------------------------------------------------------- | -------------------------------------------------- |
| Why are we building this at all                          | [templates/DISCOVERY.md](templates/DISCOVERY.md)   |
| What "complete" means, as numbered requirements          | [templates/SPEC.md](templates/SPEC.md)             |
| Screen structure, states, copy, design-system compliance | [templates/UX-SPEC.md](templates/UX-SPEC.md)       |
| The tests that will prove it, written before the code    | [templates/TEST-PLAN.md](templates/TEST-PLAN.md)   |
| The work packages themselves                             | [templates/BUILD-PLAN.md](templates/BUILD-PLAN.md) |

Legacy plan files at `.claude/pipeline/plans/<date>-<slug>.md` still work — `pipeline.js`
reads whatever path is passed as `planPath`.

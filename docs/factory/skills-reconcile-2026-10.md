# Skills reconcile, October 2026 (R7-c)

## The rule

A skill directory under `.claude/skills/` in this repo is owned by the repo. The copy under
`~/.claude/claude-skills` (reached through the `~/.claude/skills` junctions) is a deploy target. It
is refreshed from the repo with `node scripts/skills-drift.mjs --sync`, and `--check` reports where
the two have drifted. Before that direction could be made true, the newer prose that had only been
written into the global copies had to come back into the repo. This record covers that step for
markdown only. The comparison was made on 2026-10-28 on the PC, using the R7-b reconcile pack and
normalized (line endings stripped, prettier-formatted) pairs of every file.

## Totals and rulings

The pack covered 157 files: 87 exist only in the global copy, 4 only in the repo, and 66 exist on
both sides with different content. The pack's rulings were:

- KEEP-REPO 37 (no content difference, or the repo side is newer)
- MERGE-INTO-REPO 32
- ADD-TO-REPO 8
- DROP 80 (every `.bak-*` backup, one of which is also tracked in the repo)

As finally applied in this change:

- Merged by content, markdown only: every MERGE row on a `.md` file in bug-pipeline, code-map,
  dev-pipeline, fleet-lead, model-routing and pre-merge-review, plus the one-line RouteFlow note in
  the two graphify files.
- Added: three of the eight ADD rows (the two `stop-hook.mjs` templates and `CATCHES.md`).
- Not touched on purpose: engine code, both `RUN-LOG.md` files, the `docs/superpowers` plans, the
  generic `validate-*` templates, and every `.bak` file (see the sections below).

Commit f8c8a0a37 (R7-a) had already rewritten every retired-Fable instruction to name Opus, so
several MERGE rows were already done. `node scripts/no-fable-routing.mjs` stays at 0 hits. Where
the global text mentions Fable as history, a history marker was added so the check stays clean.

## What was acted on

| Skill            | File                                                         | What came over                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bug-pipeline     | SKILL.md                                                     | 2026-10-15 and 2026-09-29 ruling banners, Sonnet 5.5 wording, SS1 "Lane" bullet and lane routing, graph hints in S1/S2/S3 (blast radius), Opus S2/S4/S5 headings, sibling-sweep judge on Opus, SS3b pre-merge-review close-out bullet. Kept the repo's /bug-swarm routing note and R19 Design Gate wording |
| bug-pipeline     | templates/BUG-TEST-PLAN.md, CAUSE-RULING.md                  | already done by R7-a (byline "Opus @ high")                                                                                                                                                                                                                                                                |
| bug-pipeline     | description line                                             | already done by R7-a ("one Opus fix ruling")                                                                                                                                                                                                                                                               |
| code-map         | SKILL.md                                                     | "Step 0 (RouteFlow): graph for where and who calls, map for why" paragraph                                                                                                                                                                                                                                 |
| code-map         | reference/stop-hook.mjs                                      | added (the SKILL.md link was dangling)                                                                                                                                                                                                                                                                     |
| dev-pipeline     | SKILL.md                                                     | 2026-10-15 no-Fable ruling banner, Opus alias wording through the model policy, light-loop and planning bullets, `graph@<sha>` pack-inputs paragraph, "graph first" reuse line, ledger item 6 (`graph:` field). Kept the repo's R19 Design Gate paragraph                                                  |
| dev-pipeline     | references/ENGINE-NOTES.md                                   | 2026-10-15 ruling banner                                                                                                                                                                                                                                                                                   |
| dev-pipeline     | references/LIGHT-LOOP.md                                     | ruling banner, "Opus" for "Opus 5.5", fixPlanOverride, review and fix-plan table rows, two Opus lenses                                                                                                                                                                                                     |
| dev-pipeline     | templates/BUILD-PLAN, DISCOVERY, SPEC, TEST-PLAN, UX-SPEC    | bylines already done by R7-a. Kept the repo's BUILD-PLAN task-model line and SPEC Design Gate line                                                                                                                                                                                                         |
| fleet-lead       | SKILL.md                                                     | "The lead (Opus) never implements", "Recommend first", `graph@<sha>` packs line, per-machine Graph bullet, GRAPH FIRST template bullet. Kept the promoted rules, "never brief from a title", board #3686 text and gate message; left out the user-level-copy note                                          |
| graphify         | SKILL.md, references/query.md                                | only the one-line RouteFlow note (graph.mjs or MCP tools, no worktree builds, no `graphify claude install`, no natural-language query). The PowerShell build body was not copied                                                                                                                           |
| lessons-learned  | reference/stop-hook.mjs                                      | added (the SKILL.md link was dangling)                                                                                                                                                                                                                                                                     |
| model-routing    | SKILL.md                                                     | 2026-10-15 and 2026-09-29 rulings, price table with Sonnet 5.5 and Opus rows, decider-session rules, graph-first reuse step, blast-radius row. One global leftover ($10/$50 for the retired tier) was corrected to the Opus rate                                                                           |
| model-routing    | references/COST-AND-TIME-LEVERS, EVAL-PROTOCOL, ROUTING-PLAN | Opus wording for the decider, lead-session and verdict rows, "decider-tier output"                                                                                                                                                                                                                         |
| model-routing    | references/FABLE-PROMPTING.md, MODEL-CARDS.md                | ruling banners; Sonnet 5.5 price row in MODEL-CARDS                                                                                                                                                                                                                                                        |
| pre-merge-review | SKILL.md                                                     | model-routing header and Opus-for-every-verdict line, step "3b Radius", section "5b After the merge"                                                                                                                                                                                                       |
| pre-merge-review | references/CATCHES.md                                        | added (the SKILL.md tells reviewers to append to it). Checked for client names: none; entries use PR numbers and bug ids only                                                                                                                                                                              |

All changed markdown was run through the repo's prettier.

## KEEP-REPO and DROP, by skill (counts)

| Skill            | KEEP-REPO | DROP |
| ---------------- | --------- | ---- |
| bug-pipeline     | 2         | 3    |
| code-map         | 2         | 7    |
| dev-pipeline     | 11        | 44   |
| fleet-lead       | 4         | 0    |
| future-proof     | 7         | 0    |
| graphify         | 7         | 0    |
| lessons-learned  | 1         | 4    |
| model-routing    | 2         | 22   |
| pre-merge-review | 1         | 0    |
| Total            | 37        | 80   |

KEEP-REPO rows are line-ending-only or formatting-only differences, the repo-only fleet-lead
learning loop files and scripts, the scrubbed future-proof texts (EVIDENCE, SEAMS, SKILL), and the
scripts that wrap git calls in `scrubbedGitEnv()`. DROP rows are all `.bak-*` backups. The
tracked repo backup `dev-pipeline/scripts/light-loop.js.bak-2026-09-11e` was not deleted here
(backup files were out of scope); it should be removed with `git rm` in a later change.

## Deferred to R7-d (engine code)

- `dev-pipeline/pipeline.js`: global names Opus by the `opus` alias, has no Fable model entry and
  `fableRounds: 0`; the repo still pins `claude-opus-5-5` and keeps a Fable row. Vendored, no
  prettier.
- `dev-pipeline/scripts/light-loop.js`: same alias change in the model table. Vendored.
- `dev-pipeline/scripts/dry-run.mjs`: asserts the `opus` alias instead of `claude-opus-5-5`; must
  move with pipeline.js.
- `dev-pipeline/scripts/light-loop-dry-run.mjs`: expects model `opus`; must move with light-loop.js.
- `dev-pipeline/scripts/closeout.mjs`: global adds graph telemetry (`graphTelemetry`,
  `fmtGraphLine`, two result fields and a selftest block); the repo's `scrubbedGitEnv()` calls must
  be kept.
- `model-routing/scripts/pipeline-ledger.mjs`: global adds graph telemetry cohorts, cost per probe
  and the run-log recurrence summary; safe to copy whole.
- `model-routing/scripts/route-task.mjs`: global adds lane routing, RBAC keywords and the Design
  Gate line; safe to copy whole.
- `model-routing/scripts/session-usage.mjs`: global adds tool stats and a Sonnet 5.5 price row; the
  repo's three `scrubbedGitEnv()` edits must be re-applied.
- `model-routing/scripts/fixtures/tool-stats-session.jsonl`: fixture the merged session-usage
  selftest reads.
- Related items for that change: bring the other engine specs that assert `claude-opus-5-5` along
  with the engine files, and add `.prettierignore` entries for any new vendored script.
- Not done in this change by instruction: `dev-pipeline/references/RUN-LOG.md` still has two
  headings with a real client name that global already scrubbed to `<client>`; that scrub should
  land first in whichever change next touches the file. `future-proof/references/RUN-LOG.md` is
  missing the 27 newer rows (global lines 60 to 86).

## Left in the global copy as extras (not drift)

- `code-map/reference/validate-code-map.mjs` and `lessons-learned/reference/validate-lessons.mjs`:
  generic starter templates for other projects. The repo has its own evolved versions under
  `scripts/` (428 and 491 lines against 264 and 449), so copying the templates back would only add
  stale duplicates. They show up in `--check` as "global only, not drift".
- `dev-pipeline/docs/superpowers/plans` and `specs` (task-loop rebuild plan and design, about 130
  KB together): design history for the engine, kept out of the repo to stay lean. The engine
  comments that cite them stay as pointers to the global copy.
- Every `.bak-*` file in the global copy.

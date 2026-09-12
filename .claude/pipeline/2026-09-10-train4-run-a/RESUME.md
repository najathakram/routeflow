# RESUME card - 2026-09-10-train4-run-a

Written BEFORE launch, per dev-pipeline S7 / bug-pipeline S6. A killed session cannot be asked for these later.

- **Run**: train 4 Run A - B134 + B135 + B214 (order money path). bug-pipeline, `mode: bugfix`, scale major, DB lane.
- **runId**: recorded below immediately after the Workflow tool returns.
- **Engine scriptPath**: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js` in the MAIN checkout
  (byte-identical to canonical `~/.claude/skills/dev-pipeline/pipeline.js`, sha256 `6d31a370...`; syntax check and
  `scripts/dry-run.mjs` ALL SCENARIOS PASSED on 2026-09-10, and the same file ran the Next 15 engine to completion).
- **args**: exactly `pipeline-args.json` in this directory (3,331 bytes minified, under the ~4.5 KB resume-truncation
  line), plus `startedAt: "2026-09-10T13:37:05Z"` and `workdir: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09"`.
  Re-pass them from disk on resume; never recover them from the run record.
- **Branch / worktree**: `fix/train4-order-money-path` in `.claude/worktrees/rf-F09`, off master `edd379bf` (pre Next 15;
  merge master in at landing - no file overlap with #688). node_modules present, husky wired, `@routeflow/pricing`
  resolves from its built dist, prisma client generated.
- **DB lane**: the red gate and final gate run `*.db.spec.ts` through `scripts/local-env.mjs --db --db-specs` against
  the compose Postgres (`routeflow_postgres`), which must be up and healthy.

## Known risks carried into this run

- **Fable 5.1 is out of usage credits** (probe: HTTP 429). S4/S5 were authored by Opus 5, the documented fallback.
  Inside the engine the tie-break, fix planner and final-pass decider will fall back to Opus @ xhigh - proven on the
  Next 15 run (`fallback: true, completed: true`). Check those fields in the result: a Fable stage that shows as
  `skipped`, or that drops findings, is a real gap to re-run on Opus before calling the run clean.
- **Verify the proof actually exercised the REG tests.** On the Next 15 run a fix round moved specs into another Jest
  lane and the recorded red gate, final gate and probes then executed zero of them while reporting green. After this
  run, confirm every REG-B134/B135/B214 test ran in the final gate and that each revert-fix probe named a test that
  genuinely went red.
- **Data repair is NOT in this run** (owner ruling DECIDE-23): read-only reports come from a separate item.

## Run ID

**wf_363f0377-624** - launched 2026-09-10T13:37Z (startedAt 13:37:05Z). Transcript dir: ~/.claude/projects/C--ClaudeCode-routeflow/437c7c36-25d1-4f92-af0d-384aa6616845/subagents/workflows/wf_363f0377-624 - its journal.jsonl holds one result line per completed agent; read it before diagnosing an empty result.

## RESUME 2 — 2026-09-10T14:51:14Z

- **Abort facts**: the owner killed `wf_363f0377-624` at 2026-09-10T13:54:51Z during the "Author tests" phase.
  Two test-author agents (TP1, TP2) left PARTIAL, uncommitted output, discarded before this resume:
  `apps/api/src/orders/orders.service.spec.ts` reset to HEAD (`git checkout --`), and
  `apps/api/src/invoices/invoice-delete-credit.db.spec.ts` (untracked, never committed) deleted. Post-discard tree =
  HEAD `edd379bf` plus only this run dir (`.claude/pipeline/2026-09-10-train4-run-a/`) untracked; `git diff --stat`
  empty. The resumed test-author agents start clean.
- **Args amendment**: `pipeline-args.json`'s `verifyCommands.final` had `"npm run local:test:db"` (the whole DB
  lane) replaced with `"node scripts/local-env.mjs --db --db-specs -- \"npm run test:db -w apps/api -- invoice-delete-credit\""`,
  scoping the final DB gate to the touched spec only. Same change mirrored in this file's own "## Pipeline args"
  JSON block below (in `build-plan.md`, not this file — see its line ~558) plus a dated amendment note. Reason (lead
  ruling): Baseline found the unscoped `npm run local:test:db` fails on master today on the unrelated
  `src/common/cron-lock.db.spec.ts`, which would exclude that command — and the REG-B214 DB pins riding on the same
  lane — from the verdict. File re-validated after the edit: parses, shows the new command, 3,778 bytes (< 4 KB).
- **cron-lock diagnostic**: re-ran `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- cron-lock"`
  standalone against the compose DB — it now **PASSES** (exit 0; `cron-lock.db.spec.ts` 3/3 green, ~4.3s). The
  Baseline-phase failure did not reproduce here; no fix was attempted (out of scope for this discard-and-amend pass)
  and the `verifyCommands.final` scoping from the previous point stands regardless, per the lead's ruling.
- **Resume invocation** (Workflow tool): `scriptPath: "local-assets/tooling/pipeline-2026-09-06-6d31a370.js"`,
  `resumeFromRunId: "wf_363f0377-624"`, `args` = the `pipeline-args.json` object in this directory (as amended
  above) plus `startedAt: "2026-09-10T13:37:05Z"` and `workdir: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09"`
  — both copied verbatim from this file's original invocation block above (`## Run ID` / the `**args**` bullet); the
  `workdir` value is unchanged by this resume.

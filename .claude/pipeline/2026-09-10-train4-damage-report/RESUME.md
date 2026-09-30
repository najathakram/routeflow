# RESUME — train4 damage report (2026-09-10)

## Identity

- **Run slug**: `2026-09-10-train4-damage-report`
- **Skill**: `dev-pipeline` (mode `feature`, scale `small`)
- **Branch**: `feat/train4-damage-report`, created off `origin/master` @ `70d15a87` in worktree
  `C:/ClaudeCode/routeflow/.claude/worktrees/rf-watchdog` (was on `docs/next15-bookkeeping`,
  tree identical to master — that branch is untouched, not deleted).
- **Engine**: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js` (sha256 prefix `6d31a370`).
- **Args path**: `.claude/pipeline/2026-09-10-train4-damage-report/pipeline-args.json`
  (relative to the worktree root above).

## Exact launch block (Workflow tool)

```
scriptPath: local-assets/tooling/pipeline-2026-09-06-6d31a370.js
args: {
  ...<contents of pipeline-args.json>,
  startedAt: "<ISO at launch>",
  workdir: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-watchdog"
}
```

> **LAUNCH ONLY AFTER `wf_363f0377-624` (Run A, rf-F09) FINISHES** — one engine at a time
> (house rule). Do not start this run while Run A is still in flight.

## Re-grounding findings (this session, against the current worktree tree)

1. **Path check (step 3a)** — every path named in `pipeline-args.json`:
   - `lessonsPath` (`.claude/lessons/LESSONS.md`) — EXISTS.
   - `planPath` / `testPlanPath` — see edit below; now point at the real run dir and both files
     EXIST there (copied from the kit).
   - `testPackages[].files`:
     - `apps/api/src/common/train4-damage-report-script.spec.ts` — ABSENT (correct, plan creates it).
     - `apps/api/src/common/train4-damage-report.db.spec.ts` — ABSENT (correct, plan creates it).
   - `packages[].files`:
     - `apps/api/scripts/report-train4-damage.mjs` — ABSENT (correct, plan creates it).
   - No `mutationProbe` key present in this kit's args.

2. **Args edit (step 3b)** — the kit's `pipeline-args.json` shipped with a literal, unresolved
   placeholder in the run-dir segment (`2026-09-1X` instead of `2026-09-10`). Fixed to point at
   this run dir:
   - `planPath`: `.claude/pipeline/2026-09-1X-train4-damage-report/build-plan.md` →
     `.claude/pipeline/2026-09-10-train4-damage-report/build-plan.md`
   - `testPlanPath`: `.claude/pipeline/2026-09-1X-train4-damage-report/test-plan.md` →
     `.claude/pipeline/2026-09-10-train4-damage-report/test-plan.md`

3. **Jest lane verdict (step 3c)** — **YES**, the plan's commands run each spec in a lane that
   collects it:
   - MAIN api lane (`apps/api/package.json` → `jest` block): `rootDir: "src"`,
     `testRegex: ".*\\.spec\\.ts$"`, `testPathIgnorePatterns` = `/node_modules/`,
     `\.db\.spec\.ts$`, `docs-truth\.spec\.ts$`, `no-dead-deps\.spec\.ts$`,
     `no-single-schema-path\.spec\.ts$`, `client-page-params\.spec\.ts$`,
     `no-react-skew-hacks\.spec\.ts$`, `next-version\.spec\.ts$`,
     `audit-allowlist-retired\.spec\.ts$`. Nothing in that ignore list matches
     `train4-damage-report-script.spec.ts`, so the MAIN lane collects it. It is NOT a `.db.spec.ts`
     file so it is not excluded by that pattern either.
   - `apps/api/jest.repo-truth.config.js`: `testRegex` is a closed alternation of the seven named
     docs-truth-style specs only — neither `train4-damage-report-script.spec.ts` nor
     `train4-damage-report.db.spec.ts` match it. Repo-truth lane collects neither.
   - `apps/api/jest.db.config.js` (run via `npm run test:db -w apps/api` →
     `jest --config jest.db.config.js`): `testRegex: ".*\\.db\\.spec\\.ts$"`,
     `testPathIgnorePatterns: ["/node_modules/"]` only. This collects
     `train4-damage-report.db.spec.ts` (TP2) — and only the DB lane does, since it's excluded from
     both the MAIN lane and repo-truth.
   - Plan's redGate/final commands:
     - `cd apps/api && npx jest src/common/train4-damage-report-script --reporters=default` →
       runs the MAIN lane (default `package.json` jest config, no `--config` override) filtered to
       the TP1 path → correct lane for TP1.
     - `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- train4-damage-report"`
       → runs `jest.db.config.js` (DB lane) filtered to "train4-damage-report" → correct lane for
       TP2 (`train4-damage-report.db.spec.ts`).
   - Both commands appear identically in `redGate.commands` (expect fail) and
     `verifyCommands.final` (expect pass after the build). No lane mismatch found.

4. **Blast-radius drift since grounding (step 3d)** — plan was grounded at master `edd379bf`
   (per `build-plan.md` line 7: "Grounded at master `edd379bf`. Every line number was re-read at
   that sha"). `test-plan.md` and `pipeline-args.json` carry no sha references.
   `git diff --stat edd379bf 70d15a87 -- apps/api/scripts apps/api/src/common apps/api/package.json scripts/lib`
   shows 8 files changed since grounding:
   - `apps/api/package.json` (7 lines — jest config; re-verified live above, no conflict)
   - `apps/api/scripts/pdf-render-smoke.mjs` (new, unrelated script)
   - `apps/api/src/common/audit-allowlist-retired.spec.ts` (new)
   - `apps/api/src/common/ci-audit-script.spec.ts` (modified)
   - `apps/api/src/common/client-page-params.spec.ts` (new)
   - `apps/api/src/common/next-version.spec.ts` (new)
   - `apps/api/src/common/no-react-skew-hacks.spec.ts` (new)
   - `apps/api/src/common/turbo-inputs.spec.ts` (modified)
     None of these collide with the plan's target files
     (`train4-damage-report-script.spec.ts`, `train4-damage-report.db.spec.ts`,
     `report-train4-damage.mjs`); the new specs are exactly the repo-truth-style files already
     accounted for in the current `testPathIgnorePatterns`/`testRegex` read in finding 3. No
     re-plan needed from this drift.

5. **Args file sanity (step 3e)** — `pipeline-args.json` parses as valid JSON, 2316 bytes
   (< 4096 byte budget), top-level keys: `mode`, `scale`, `planPath`, `testPlanPath`,
   `lessonsPath`, `context`, `testPackages`, `redGate`, `packages`, `verifyCommands`.

## Owner constraints (DECIDE-23 — carry into the build)

- The script (`apps/api/scripts/report-train4-damage.mjs`) is **READ-ONLY against prod** —
  SELECT-only, no write flag, ever.
- It runs in prod via `railway run --service postgres node apps/api/scripts/report-train4-damage.mjs`.
- Output carries **no identifiers** — tenants referenced as ordinals, not slugs/names/UUIDs.
- **No repair is bundled** with this script — damage counting only (B134 B135 B214 B215 B216
  B131 B141), per Plane DECIDE-23.

## Lead review 2026-09-10

> Amended 2026-09-10 (lead): --reporters=default moved LAST — Jest reads positionals after it as reporter modules (proven in wf_363f0377-624 Baseline).

## Lead amendment 2026-09-10T17:12:09Z (launch)

- final Jest commands carry `--passWithNoTests` so Baseline (pre-implementation tree, specs absent) does not mark them broken and exclude them from the verdict (Run A trap: "No tests found" at Baseline = command excluded = final gate proved nothing). Close-out MUST confirm T1-T14 actually executed in the final gate (a green with 0 tests is the Next-15 trap).
- perRound `node --check` guarded by existence (script is a deliverable).

## LAUNCHED 2026-09-10T17:12:47Z

- runId `wf_7fcf73f2-1ee` (task wjbst7lmf), startedAt 2026-09-10T17:12:09Z, workdir C:/ClaudeCode/routeflow/.claude/worktrees/rf-watchdog, engine local-assets/tooling/pipeline-2026-09-06-6d31a370.js, args = this dir pipeline-args.json (2522 B) + startedAt + workdir. Resume: Workflow scriptPath + resumeFromRunId wf_7fcf73f2-1ee + the same args.

# RESUME — PR-1 · imp-03a DDL retirement + drift gate

- **runId:** `wf_3da581bd-b9a`
- **scriptPath (staged engine):** `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-v3.js`
  (byte-identical to `~/.claude/skills/dev-pipeline/pipeline.js` at launch, SHA256 `ED470748…C3275BC`)
- **Transcript dir:** `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\8d7999bc-726a-4431-9ad0-445d127f0188\subagents\workflows\wf_3da581bd-b9a`
- **Launched:** 2026-09-03 (`startedAt` 2026-09-03T09:04:38Z) from session `routeflow-19 [94ecf2]`
- **Branch:** `fix/imp-03a-ddl-to-migrations-drift-gate` @ `91c5333b` (main checkout `C:\ClaudeCode\routeflow`)
- **Scale:** major · ui: false · loop: dev-pipeline

Resume: `Workflow({ scriptPath: "<scriptPath above>", resumeFromRunId: "wf_3da581bd-b9a", args: <the exact object below> })`.
On resume trust the run's own `phaseReport`, never WIP diffs in the tree.

## Exact args

```json
{
  "planPath": "C:/ClaudeCode/routeflow/.claude/pipeline/2026-09-03-imp-03a-ddl-drift-gate/build-plan.md",
  "discoveryPath": "C:/ClaudeCode/routeflow/.claude/pipeline/2026-09-03-imp-03a-ddl-drift-gate/discovery.md",
  "specPath": "C:/ClaudeCode/routeflow/.claude/pipeline/2026-09-03-imp-03a-ddl-drift-gate/spec.md",
  "testPlanPath": "C:/ClaudeCode/routeflow/.claude/pipeline/2026-09-03-imp-03a-ddl-drift-gate/test-plan.md",
  "lessonsPath": "C:/ClaudeCode/routeflow/.claude/lessons/LESSONS.md",
  "startedAt": "2026-09-03T09:04:38Z",
  "scale": "major",
  "context": "PR-1 of the improvements program on branch fix/imp-03a-ddl-to-migrations-drift-gate: delete the two boot-time DDL paths (prod verified drift-free 2026-09-03), add a read-only Prisma drift gate (schema-drift.mjs + shared Railway URL helper + prod-migrate post-deploy check + db-migrations.yml step), and introduce the *.db.spec.ts lane. Never touch apps/api/prisma/** or any other worktree; test tenants only.",
  "formatCommand": "npx prettier --write",
  "testPackages": ["tp-tripwire", "tp-platform-config", "tp-drift-script", "tp-db-guard"],
  "redGate": {
    "commands": [
      "cd apps/api && npx jest src/common/no-runtime-ddl.spec.ts src/platform-admin/platform-config.no-ddl.spec.ts src/common/schema-drift-script.spec.ts src/common/testing/db-spec.spec.ts"
    ],
    "expect": "fail"
  },
  "packages": [
    "p1-delete-runtime-ddl (opus/high)",
    "p2-drift-script",
    "p3-prod-migrate (opus/high, dependsOn p2)",
    "p4-db-lane (dependsOn p2)",
    "p5-root-scripts-compose (dependsOn p4)",
    "p6-ci-workflow (dependsOn p4)",
    "p7-docs-map-lesson (low, dependsOn p1-p6)"
  ],
  "verifyCommands": {
    "perRound": ["npx tsc -p apps/api/tsconfig.build.json --noEmit", "npm run lint -w apps/api"],
    "final": ["npm run verify"]
  },
  "mutationProbe": "4 targets — main.ts→T1, platform-config.service.ts→T2, schema-drift.mjs→T3, db-spec.ts→T4"
}
```

The full package/testPackage briefs are in `build-plan.md` (the args carried them verbatim); the
Workflow launch record in the session transcript holds the byte-exact object.

## Close-out checklist (S8)

1. Coverage matrix R1–R9 → T1–T4 / A1–A5 with actual results; quote red-gate, gate and mutation-probe results.
2. `result.json` → `node ~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append .claude/pipeline/2026-09-03-imp-03a-ddl-drift-gate/result.json --run imp-03a-ddl-drift-gate --started 2026-09-03T09:04:38Z --ended <now>`.
3. Acceptance A1–A5 by a Sonnet agent (A1–A3 need Docker; A5 needs the public window).
4. Ship via the `rebuild` routine; attach the prod evidence (R9) to the PR body; post-deploy `schema-drift.mjs` against prod → exit 0.
5. Flip `docs/IMPROVEMENTS.md` row 3 to `shipped #<PR>`; update the program memory note.

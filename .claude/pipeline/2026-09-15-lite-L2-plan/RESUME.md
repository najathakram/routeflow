# Pipeline Resume

**runId:** wf_2026-09-15-lite-L2-plan

**scriptPath:** unavailable (no scriptPath in args or exposed by any Workflow global in this engine)

**args:**

```json
{
  "buildPlanPath": ".claude/pipeline/2026-09-15-lite-L2-plan/build-plan.md",
  "testPlanPath": ".claude/pipeline/2026-09-15-lite-L2-plan/test-plan.md",
  "lessonsPath": ".claude/lessons/LESSONS.md",
  "startedAt": "2026-09-15T00:00:00Z",
  "runDir": "C:/ClaudeCode/routeflow/.claude/worktrees/rf-lite-L2/.claude/pipeline/2026-09-15-lite-L2-plan",
  "scale": "major",
  "mode": "feature",
  "profile": "standard",
  "workdir": "C:/ClaudeCode/routeflow/.claude/worktrees/rf-lite-L2",
  "context": "L2 — Lite $99/mo invite-only plan: one new plan-keyed enforcement tier (ALWAYS_ENFORCED_PLAN_KEYS) alongside the existing DARK_PLAN_FLAGS courtesy, five newly-enforced flags, a v12 catalog publish, and web+mobile nav hiding / locked-panel handling.",
  "baselineSha": "bc24582d",
  "scriptsDir": "C:/Users/nakram/.claude/skills/dev-pipeline/scripts",
  "tasks": [
    {
      "id": "WP1",
      "title": "enum + migration + PLAN_KEYS + plan vocabulary + shared billing types",
      "type": "feature",
      "files": [
        "apps/api/prisma/schema/tenancy.prisma",
        "apps/api/prisma/migrations/20260915000000_tenant_plan_lite/migration.sql",
        "apps/api/src/billing/plan-catalog.constants.ts",
        "packages/types/api/enums.ts",
        "packages/types/api/billing.ts",
        "packages/types/index.ts"
      ],
      "tests": [
        "apps/api/src/billing/plan-catalog.constants.spec.ts",
        "apps/api/src/common/enum-parity.spec.ts"
      ]
    }
  ]
}
```

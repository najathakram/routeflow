# ocr-gate-observe-first — pipeline resume card (written BEFORE launch)

Bug-pipeline run (engine `dev-pipeline/pipeline.js`, `mode: 'bugfix'`) for OCR-1/OCR-2 — registry-driven
observe-first `AddonGuard` (`ocr` dark), coded 403 body, web single-scan toast fidelity, read-only
blast-radius report, docs rule. Owner ask 2026-09-03/04: fix immediately without harming PR #475, adopt the
research's best guardrail, run through the bug pipeline, validate on the local Docker stack, ship.

## Resume command

```
Workflow({
  scriptPath: "C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-v4.js",
  resumeFromRunId: "wf_eece6302-2d5",
  args: { ...the exact args object in build-plan.md "## Pipeline args", with startedAt = 2026-09-04T05:27:39Z... }
})
```

- **Engine copy:** `local-assets/tooling/pipeline-v4.js` (sha256 prefix `6d31a37052e94b30`, 285,680 bytes —
  byte-identical to `~/.claude/skills/dev-pipeline/pipeline.js` at launch; never overwrite this file).
- **runId:** `wf_eece6302-2d5` — transcript dir `C:/Users/nakram/.claude/projects/C--ClaudeCode-routeflow/59d005e2-54e1-4d13-afe3-6d14b8d9100e/subagents/workflows/wf_eece6302-2d5`
- **startedAt:** `2026-09-04T05:27:39Z`
- **workdir:** `C:/ClaudeCode/routeflow/.claude/worktrees/rf-ocr` (branch `fix/ocr-gate-observe-first`, from
  `origin/master` `e39bf9db`; `npm ci` + `npx prisma generate` done; scoped jest/tsc green at baseline)
- **args:** exactly the `## Pipeline args` block in `build-plan.md` (absolute artifact paths; `mode: 'bugfix'`;
  `scale: 'major'`; TP1–TP4; WP1–WP4; redGate scoped to `-t "REG-OCR-1"`; two mutation targets, one
  `revertFix: true`).
- **Session:** routeflow-cb (`C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\59d005e2-…`); the
  transcript dir is printed by the Workflow tool result (`…/subagents/workflows/<runId>/journal.jsonl`).

## Hand-run lane (not in the engine)

- T5 `REG-OCR-2` Playwright: `cd apps/web && PLAYWRIGHT_BASE_URL=http://localhost:3001 npx playwright test
e2e/02-operator.spec.ts --project=operator -g "REG-OCR-2"` — red before the web image carries WP2, green after.
- Gate probe on the local stack: `POST /api/v1/vendor-bills/scan-invoice` (test tenant operator, one real image
  under `images`) — 403 ADDON_GATE before, 400 ANTHROPIC_API_KEY message after.
- Local Docker stack is in use by session routeflow-19 until ≈ 06:20Z 2026-09-04 (Playwright + db-spec lanes);
  message routeflow-19 before rebuilding; build `api` then `web` serially, no wrapper timeout.

## Close-out owed (bug-pipeline S7)

result.json beside this file → ledger row (`pipeline-ledger.mjs append … --run ocr-gate-observe-first`) →
RUN-LOG entry (≤ 10 lines) → lessons entry (Symptom / Root cause / Lesson / Guard; `_meta.json` bump) →
code-map entries for touched files → registry proof lines (`REG-OCR-1`, `REG-OCR-2`) → owner questions
(grandfather grants, SKU/key mismatch, plan-flag auto-grant).

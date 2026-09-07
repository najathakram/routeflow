# RESUME — F08 returns end-to-end (10 bugs) — bug-pipeline, mode bugfix, scale major

Written at launch, 2026-09-06 (Routeflow Lead session; the lead runs this engine itself).

- Worktree: `C:\ClaudeCode\routeflow\.claude\worktrees\rf-F25` · branch `fix/F08-returns-end-to-end` · base master `597c72dc`
- Run dir: `.claude/pipeline/2026-09-06-F08-returns-end-to-end/`
- Engine: `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-2026-09-06-6d31a370.js` (staged copy, sha8 6d31a370; never overwrite)
- Args: `pipeline-args.json` in this dir (passed verbatim as an object; `startedAt` stamped at launch)
- Workflow run id: **see the "Launch" line appended below** (resume with `Workflow({ scriptPath: <engine>, resumeFromRunId: <id>, args: <pipeline-args.json> })`, same session only)

## Artifacts present at launch

`cause-brief.md` (S1), `refutation.md` (S2), `cause-ruling.md` (S3 incl. Amendment 2 — the B53×B128 `deliveredQty` rule, the CREDIT_SOURCE_EXCLUDED filter, the fallback/refuse rule, the order-level headroom), `bug-test-plan.md` (S4 incl. T1d/T1e), `build-plan.md` (S5), `pipeline-args.json`.

## Stage reached

Launching S6 (the engine). Nothing implemented yet; tree clean at launch. **Absolute prohibition: never edit `apps/api/src/routes/routes.service.ts`.**

## Standing rules for whoever resumes

- Never relaunch the engine fresh on a partially implemented tree; resume by run id (same session) or continue by the light loop.
- Host: scoped runs only until the lead's "go"; pre-push hook = final full gate; DRAFT PR; commits carry `Bookkeeping-Follow-Up: pending`.
- Close-out (S7): `result.json`, ledger row, RUN-LOG entry; registry `prove` (T1) / `--pending-deploy` (T2: B166, B75, B21) / `discharge`, the lesson (archive TWO; id from `nextId`), and the owner-run data-repair report script (B53 over-refunds, B68 stranded rows) are separate deliverables.

## Launch

- 2026-09-06T19:28Z · Workflow run id **wf_85fd24ba-6e2** (task wlx4gy3sw) · scriptPath `C:/ClaudeCode/routeflow/local-assets/tooling/pipeline-2026-09-06-6d31a370.js` · args = this dir's `pipeline-args.json` verbatim · journal `C:/Users/nakram/.claude/projects/C--ClaudeCode-routeflow/14338d9c-5c59-4c2e-a365-d1c3f9a77712/subagents/workflows/wf_85fd24ba-6e2/journal.jsonl`

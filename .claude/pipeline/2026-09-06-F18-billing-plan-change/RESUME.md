# RESUME — F18 billing plan-change (B58 · B73 · B107) — bug-pipeline, mode bugfix, scale major

Written at launch, 2026-09-06 (Routeflow Lead session; the lead runs this engine itself).

- Worktree: `C:\ClaudeCode\routeflow\.claude\worktrees\rf-watchdog` · branch `fix/F18-billing-plan-change` · base master `597c72dc`
- Run dir: `.claude/pipeline/2026-09-06-F18-billing-plan-change/`
- Engine: `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-2026-09-06-6d31a370.js` (staged copy of `~/.claude/skills/dev-pipeline/pipeline.js`, sha8 6d31a370 — same engine as pipeline-v4.js; never overwrite)
- Args: `pipeline-args.json` in this dir (passed verbatim as an object; `startedAt` stamped at launch)
- Workflow run id: **see the "Launch" line appended below** (resume with `Workflow({ scriptPath: <engine>, resumeFromRunId: <id>, args: <pipeline-args.json> })`, same session only)

## Artifacts present at launch

`cause-brief.md` (S1, Sonnet), `refutation.md` (S2, Opus), `cause-ruling.md` (S3 incl. Amendments 1–2), `bug-test-plan.md` (S4 incl. Amendment 2), `build-plan.md` (S5), `pipeline-args.json`.

## Stage reached

Launching S6 (the engine). Nothing implemented yet; tree clean at launch.

## Standing rules for whoever resumes

- Never relaunch the engine fresh on a partially implemented tree (Baseline would absorb the partial fix). Resume by run id in the same session, or continue by the light loop from the last recorded stage.
- Host: scoped runs only until the lead's "go"; the pre-push hook is the final full gate; DRAFT PR; commits carry `Bookkeeping-Follow-Up: pending`.
- Close-out (S7): `result.json`, ledger row, RUN-LOG entry; registry `prove`/`discharge` + the lesson (archive TWO; id from `_meta.json.nextId`, 83 at launch) go in the lead's docs-only follow-up.

## Launch

- 2026-09-06T19:28Z · Workflow run id **wf_20aee88d-d55** (task w69hdm2ui) · scriptPath `C:/ClaudeCode/routeflow/local-assets/tooling/pipeline-2026-09-06-6d31a370.js` · args = this dir's `pipeline-args.json` verbatim · journal `C:/Users/nakram/.claude/projects/C--ClaudeCode-routeflow/14338d9c-5c59-4c2e-a365-d1c3f9a77712/subagents/workflows/wf_20aee88d-d55/journal.jsonl`

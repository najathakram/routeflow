# RESUME — auth-redesign (dev-pipeline, mode feature, scale major, ui)

- worktree: C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09 · branch feat/auth-redesign (off feat/marketing-port 42a4893e; stacks on PR #657)
- engine: C:/ClaudeCode/routeflow/local-assets/tooling/pipeline-2026-09-06-6d31a370.js (staged copy; args passed as an OBJECT from pipeline-args.json)
- startedAt: 2026-09-07T17:19:22Z · runId: wf_ca7094ab-7e5 (task ws50expi3; transcript C:/Users/nakram/.claude/projects/C--ClaudeCode-routeflow--claude-worktrees-rf-registry/14338d9c-5c59-4c2e-a365-d1c3f9a77712/subagents/workflows/wf_ca7094ab-7e5) · spec number 46 · dev port 3009
- rules: never next build on this host (react hoist skew); never Playwright in gates; never resumeFromRunId (args > 4 KB truncate run records); stalled engine → light loop from result.json, never a second engine on the implemented tree.
- close-out: result.json here → ledger row (pipeline-ledger.mjs append, from the repo root, no --project) → RUN-LOG entry → commit run dir with the code → merge origin/master → regen reports → campaign-check → push (full verify) → draft PR (base master; stacked on #657 — mark ready only after #657 merges) → owner sequencing.

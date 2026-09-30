# RESUME — B246 Option C scan FAB (bug-pipeline, mode bugfix, scale minor)

Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25`, branch `fix/B246-scan-fab` off master 8a1f1eab (merge `origin/master` before landing; master is ≥ a75ec8bf).
Artifacts in this dir: cause-brief.md (S1 Sonnet) · cause-refutation.md (S2 Opus) · cause-ruling.md (S3 Fable, design of record) · bug-test-plan.md (S4) · build-plan.md (S5) · pipeline-args.json.
Engine: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js` (staged copy). Launch = Workflow({ scriptPath: <engine>, args: <pipeline-args.json as an OBJECT, startedAt set at launch> }). Launch only when no push verify runs on the host and free memory > 2 GB (2026-09-08 host commit charge sat at 86/91 GB).
runId: wf_4fb3a80b-8b4 (task w6gi3mgux; transcript C:/Users/nakram/.claude/projects/C--ClaudeCode-routeflow/cbfee473-03c5-474d-b0fb-371fb23a62fd/subagents/workflows/wf_4fb3a80b-8b4) · startedAt: 2026-09-08T06:17:03Z · args ≈ 3.5 KB (under the record cap; still never resumeFromRunId — a stalled engine → light loop from the tree, L-085).
No UI verify (no mobile renderer on the host); owner exercises the FAB on a device after deploy.
Landing recipe: commit (trailer `Bookkeeping-Follow-Up: pending`) → merge origin/master → regen api+mobile+pricing reports → hook push → draft PR → window (watchdog → public → ready → CI green → squash → both Railway rows terminal (mobile-only diff: SKIPPED) → private) → docs follow-up (B246 row corrected to 3 taps, Option B twin kept open, B245 discharged by pin, code map, lesson if any).

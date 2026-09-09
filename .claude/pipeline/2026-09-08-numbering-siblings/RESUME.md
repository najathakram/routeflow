# RESUME — numbering siblings Group A: B267 · B268 · B269 · B277-pin (bug-pipeline, mode bugfix, scale major)

Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch `fix/numbering-siblings` off master eb2b815e (merge `origin/master` before landing).
Artifacts in this dir: cause-brief.md (S1 Sonnet, 73 KB) · cause-refutation.md (S2 Opus: forTenant() is not a tenant guarantee; B268 overwrites live invoices; B269 = global unique + Stripe settlement stall → HIGH; B277 pin only; split A/B) · cause-ruling.md (S3 Fable) · bug-test-plan.md (S4) · build-plan.md (S5) · pipeline-args.json.
Group B (B270 bills, B271 PO, B272 statements) = a SEPARATE run: enum migration (3 members) + owner prod-migrate ack BEFORE its window — see cause-ruling.md §9.
Engine: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js` (staged copy). Launch = Workflow({ scriptPath: <engine>, args: <pipeline-args.json as an OBJECT, startedAt set at launch> }) — AFTER the B263 engine (one engine on the host); compose Postgres must be up (DB lane).
runId: (set at launch) · startedAt: (set at launch) · args ≈ 6 KB — never resumeFromRunId; a stalled engine → light loop from the tree (L-085).
Landing recipe: commit (trailer `Bookkeeping-Follow-Up: pending`) → merge origin/master → regen api+mobile+pricing reports → hook push → draft PR → window (api SUCCESS) → private → PDC → deployment E2E → docs follow-up (B267/B268/B269 done, B277 pin, B270–B272 "Group B pending ack"; lesson: pass tenantId explicitly on every mint; api map).

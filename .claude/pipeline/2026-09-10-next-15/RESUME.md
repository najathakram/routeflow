# RESUME card — 2026-09-10-next-15

Written at launch, per dev-pipeline S7. A killed session cannot be asked for these later.

- **runId**: filled in from the Workflow tool result immediately after launch — see "Run ID" below.
- **Persisted engine scriptPath**: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js`
  (byte-identical to canonical `~/.claude/skills/dev-pipeline/pipeline.js`, sha256
  `6d31a37052e94b300c4d8637c0b64c06436fb7a345a7898137f45ca5893a0c40`; syntax check + `scripts/dry-run.mjs`
  ALL SCENARIOS PASSED before launch).
- **args**: exactly the contents of `pipeline-args.json` in this directory, plus
  `startedAt: "2026-09-10T05:28:30Z"`. The engine takes `workdir` from that file
  (`C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25`).
  ⚠️ The args are **6,526 bytes minified**, above the ~4,560-char point at which this repo has seen the
  run record's stored `args` string truncated (symptom on resume: `workflow.js:260 Expected }`). **Do not
  try to recover the args from `workflows/<runId>.json` — this file plus `pipeline-args.json` is the
  authoritative copy.** Re-pass them from disk on resume and the truncation is irrelevant.
- **Branch / worktree**: `chore/next-15` in `.claude/worktrees/rf-F25`, off master `edd379bf`.
  `npm install` completed there (exit 0), husky hooks wired (`core.hooksPath = .husky/_`).
- **Baseline the worktree started from** (independently confirms the discovery brief's hoist analysis):
  root `react` 19.2.5 · root `react-dom` 18.3.1 · `apps/web` nested `react` 18.3.1 · `next` 14.2.35.

## Resume command

```
Workflow({ scriptPath: "local-assets/tooling/pipeline-2026-09-06-6d31a370.js",
           resumeFromRunId: "<runId>", args: <pipeline-args.json + startedAt> })
```

On resume, trust the resumed run's own `phaseReport`, never WIP diffs in the tree.

## Known risk carried into this run

**Fable 5.1 is out of usage credits.** Both S4/S5 planning agents died with "You're out of usage credits.
Switch to another model", so `test-plan.md` and `build-plan.md` were authored by **Opus 5**, the fallback
dev-pipeline's MODEL POLICY permits when Fable is genuinely unavailable. Inside the engine, Fable owns three
decision points — the split-vote tie-break, the fix planner, and the final-pass decision. The engine has a
documented Opus-at-xhigh fallback for each (exercised by the dry-run), and `agent()` returns null on a
terminal API error, which is the same signal as a decline. **Expect `fixPlanning.rounds[].fallback` and
`finalPass.fallback` to be true, and check them in the result** — if a Fable stage instead shows as
`skipped` or drops findings, that is a real gap, not a graceful fallback, and the affected phase must be
re-run on Opus before the run is called clean.

## Run ID

**`wf_815eecf6-fc9`** — launched 2026-09-10T05:28:30Z. Transcript dir:
`~/.claude/projects/C--ClaudeCode-routeflow/437c7c36-25d1-4f92-af0d-384aa6616845/subagents/workflows/wf_815eecf6-fc9`
(its `journal.jsonl` holds one result line per completed agent — read it before diagnosing an empty result).

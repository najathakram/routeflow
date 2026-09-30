# F14 — dev-pipeline RESUME card

Written at launch. The resume key is `{scriptPath, resumeFromRunId, args}` and **args are NOT stored
by the tool** — that is why `pipeline-args.json` sits beside this file.

## Resume key

|              |                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `runId`      | `wf_9c4e4351-d4b`                                                                                                                   |
| `scriptPath` | `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline.js`                                                                          |
| `args`       | `pipeline-args.json` in this directory — pass its parsed contents verbatim                                                          |
| transcript   | `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\826dd237-3a27-4b2c-b122-e48a248c0c0b\subagents\workflows\wf_9c4e4351-d4b` |

```
Workflow({ scriptPath: "C:\ClaudeCode\routeflow\local-assets\tooling\pipeline.js",
           resumeFromRunId: "wf_9c4e4351-d4b", args: <contents of pipeline-args.json> })
```

`local-assets/` is gitignored, so `pipeline.js` there is a copy of the user-level
`~/.claude/skills/dev-pipeline/pipeline.js` (it had to live inside the working directory for the
Workflow tool to accept the path). Re-copy it if it is missing.

## ⚠️ Aborted first attempt — do not repeat the mistake

Run `wf_8aaf92a3-d66` was STOPPED and its work reverted. Cause: `formatCommand` was
`npm run format`, which is `prettier --write "**/*.{ts,tsx,js,jsx,json,md}"` — the WHOLE repo. An
agent ran it and reformatted **85 unrelated files** (`.claude/agents/*`, old F06/F07/F10 pipeline
artifacts, `design-system.md`, unrelated `apps/**` sources), which would have made the PR
unreviewable and collided with every other batch. The formatCommand is now scoped to this run's
own diff:

```
git ls-files -mo --exclude-standard | grep -E '\.(ts|tsx|js|jsx|json|md)$'   | grep -v '^\.claude/pipeline/' | xargs -r npx prettier --write
```

Verified to exit 0 and touch nothing on a clean tree. **Never put a repo-wide formatter in
`formatCommand`.**

## Setup already done in this worktree — do NOT redo blindly, but DO verify

- branch `fix/F14-authz-matrix-v2` off master `39632d27`
- **its own `npm ci`** (a worktree cannot see the main checkout's nested deps — without this,
  suites fail with "cannot find module" and a cache can replay a green nobody ran)
- `npx prisma generate` (stale client ⇒ typecheck fails at Baseline ⇒ excluded as a broken
  command ⇒ the run proceeds with no real gate)
- husky `.husky/_` present, so commit-msg and pre-push hooks actually run here
- pre-verified: `apps/api` typecheck exits 0 in this worktree

## On resume

Trust the resumed run's own `phaseReport`. Do NOT reconstruct progress from WIP diffs in the tree —
Baseline treats whatever is present as the baseline, and a half-finished phase looks exactly like a
finished one.

## Oracles to check individually (a skipped phase is neutral; an UNVERIFIED one is not)

- `redGate.properlyRed` — every new jest test must fail on its own assertion, not on a stub's
  `undefined`
- `mutationProbe.allCaught` / `.restoredVerified` / `.skippedTargets` — 12 targets declared
- `finalPass.ran` / `.completed` — Fable's last read over the HIGH-risk diff
- `baseline.badCommands` — anything here was excluded from pass/fail
- `uiVerify` — **deliberately NOT configured.** The plan forbids running Playwright locally (it
  clobbers the shared `.campaign/runs/web-e2e.json`), so the web halves (WP8 header dropdown,
  WP9 SessionsCard) are owed a manual browser-pane check against `next dev`. An unexecuted UI
  verification is work owed, never work that would have passed.

## Known-owed regardless of the run's verdict

- e2e specs 31/32 are **post-deploy** proofs. They land as deliverables in WP10; they do not and
  cannot discharge here.
- Spec 31 skips until the owner reseeds a TENANT_ADMIN into `e2e-routeflow` (`e2e-seed.js`).
  **A skip is never a discharge (L-041).**
- Lesson id **L-044** is pre-allocated to F14. Do not take `nextId`; L-042/L-043 are reserved.

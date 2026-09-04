# F11 — dev-pipeline RESUME card

Written at launch. The resume key is `{scriptPath, resumeFromRunId, args}` and **args are NOT stored
by the tool** — that is why `pipeline-args.json` sits beside this file.

## Resume key

|              |                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `runId`      | `wf_bcd6bd49-f9e`                                                                                                                   |
| `scriptPath` | `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline.js`                                                                          |
| `args`       | `pipeline-args.json` in this directory — pass its parsed contents verbatim                                                          |
| transcript   | `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\826dd237-3a27-4b2c-b122-e48a248c0c0b\subagents\workflows\wf_bcd6bd49-f9e` |

```
Workflow({ scriptPath: "C:\ClaudeCode\routeflow\local-assets\tooling\pipeline.js",
           resumeFromRunId: "wf_bcd6bd49-f9e", args: <contents of pipeline-args.json> })
```

`local-assets/` is gitignored; `pipeline.js` there is a copy of `~/.claude/skills/dev-pipeline/pipeline.js`
(the Workflow tool only accepts paths inside the working directory). Re-copy it if missing.

## Lead rulings applied at launch — a builder must not undo these

- **WP1 item (g) is DROPPED.** `sweepOrdersOntoStops` is NOT extracted; createRun's sweep at
  routes.service.ts:936-967 stays byte-for-byte untouched. With R3 (un-cancel is status-only) the
  helper has no second caller. Pin P2 still pins the sweep's `where`.
- **WP5 ships BOTH halves** (mobile + web cache invalidation). The commit title names `web` (L-008).
- The design itself is the lead's R1 (writer-side) — see
  `.claude/pipeline/2026-09-02-wave-a-completion/SEQUENCE.md` "Lead rulings — 2026-09-02".

## Setup already done in this worktree — verify, do not redo blindly

- branch `fix/F11-run-cancel-skip-v2` fast-forwarded to master `d4f85fd2` (#602 rulings merged)
- **its own `npm ci`** (a worktree cannot see the main checkout's nested deps)
- `npx prisma generate` (v7.10.0)
- husky `.husky/_` present — commit-msg and pre-push hooks actually run here
- pre-verified: `apps/api` typecheck exits 0 in this worktree

## On resume

Trust the resumed run's own `phaseReport`. Do NOT reconstruct progress from WIP diffs — Baseline
treats whatever is present as the baseline, and a half-finished phase looks exactly like a
finished one.

## Oracles to check individually (a skipped phase is neutral; an UNVERIFIED one is not)

- `redGate.properlyRed` — pins are in `*.pins.spec.ts` / `*.pins.test.ts` and EXCLUDED from the red
  gate command by design, so this should be genuinely red this time (on F14 the pins were swept and
  dragged it to false). If it is false, read WHICH tests: a pin in a swept file is the likely cause.
- `mutationProbe.allCaught` / `.restoredVerified` / `.skippedTargets` — 27 targets declared. Note
  `allCaught` is a snapshot at probe time; the Fix phase may have closed a survivor — re-probe by hand
  (file-copy backup, never git) before believing either way.
- `finalPass.ran` / `.completed` — Fable's last read over the HIGH-risk diff.
- `baseline.badCommands` — anything here was excluded from pass/fail.
- `uiVerify` — **not configured** (all rows are T1 jest; the mobile screens are covered by
  source-text and pure-logic tests, and there is no web surface change beyond a query invalidation).

## Owed after the run, regardless of verdict

- **Before `git push`:** regenerate BOTH campaign artifacts in THIS worktree —
  `npm --prefix apps/api test` and `npm --prefix apps/mobile test` (full, uncached). The pipeline's
  scoped runs overwrite `.campaign/runs/*.json` with partial artifacts and the pre-push
  campaign-check fails on mobile-proof rows otherwise (learned on F14).
- **D4 repair**: WP6 produces `scripts/repair-f11-stranded-orders.mjs` and a runbook section; the
  builder runs the DRY RUN only against the local docker `test` tenant. **The prod run is the owner's**,
  post-deploy.
- Ledger: F11.jsonl → B34/B129/B146/B211 `proven`; B32 REMOVED here and ADDED to F20.jsonl (queued,
  T3). PR #597 (bug-registry) carries the same intent — F11 landing first should shrink its rebase.
- Lesson **L-045** (pre-allocated). `nextId` stays 51 unless a second unallocated lesson is written.
- No e2e spec, no post-deploy T2 discharge — all four rows discharge on jest + a green post-deploy run.

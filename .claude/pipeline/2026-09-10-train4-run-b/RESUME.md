# RESUME — Train 4, Run B (B215 OrderIdempotencyKey table + migration)

- **slug**: `2026-09-10-train4-run-b`
- **skill**: `bug-pipeline` — `mode: "bugfix"`, `scale: "major"` (from `pipeline-args.json`)
- **branch**: `fix/train4-order-idempotency-key`, off `master` `70d15a87`, checked out in worktree
  `C:/ClaudeCode/routeflow/.claude/worktrees/rf-runB`
- **engine**: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js`
- **args path**: `.claude/pipeline/2026-09-10-train4-run-b/pipeline-args.json`
  (`planPath`/`testPlanPath` already resolved to this slug; `startedAt`/`workdir` still to be
  added by the launcher at launch time)

## Exact launch block

Use the `Workflow` tool:

```
scriptPath: local-assets/tooling/pipeline-2026-09-06-6d31a370.js
args: <the parsed contents of .claude/pipeline/2026-09-10-train4-run-b/pipeline-args.json>
      + "startedAt": "<ISO timestamp at launch>"
      + "workdir": "C:/ClaudeCode/routeflow/.claude/worktrees/rf-runB"
```

i.e. read `pipeline-args.json` as an object, add the two keys above, and pass the merged object
as `args`.

## Standing notes

- **LAUNCH LAST.** Its final verify (`verifyCommands.final`) runs a real `prisma migrate deploy`
  against the shared compose DB, so every other run's `npm run local:drift` will read DRIFT
  afterwards. After Run B's final gate: run `npm run local:reset` + `npm run local:seed` **only
  when no other run still needs the compose DB**.
- **One engine at a time.** Do not launch this alongside any other engine.
- **`.campaign/runs/*.json` do not exist in a fresh worktree.** Before the landing push, run
  `cd apps/api && npx jest --maxWorkers=2` (and the web/mobile equivalents only if their tests
  changed) so `campaign-check` accepts the push.
- **Fable review 2026-09-10: APPROVED** — migration SQL specified; `MODEL_DOMAIN` entry present;
  Squawk-clean; replay returns the original order; same-key/different-cart → 409; no TTL accepted;
  follow-up row owed: `create()` should consult `OrderIdempotencyKey`.
- **Landing**: fresh prod backup → `railway run --service postgres node
apps/api/scripts/prod-migrate.mjs` → drift exit 0 → deploy (canonical flow). Owner ruling
  DECIDE-2x: "B215 migration APPROVED".

## Lead review 2026-09-10

> Amended 2026-09-10 (lead): --reporters=default moved LAST — Jest reads positionals after it as reporter modules (proven in wf_363f0377-624 Baseline).

> Amended 2026-09-10 (lead): --passWithNoTests on final Jest commands whose only targets are new spec files, so Baseline does not exclude them (wf_363f0377-624 trap); close-out must confirm the T#/REG tests actually executed in the final gate.

## Launched 2026-09-11 07:4xZ — runId wf_00c036d1-a66 (first attempt wf_f128c1fb-19f died on >4KB stored-args truncation; args trimmed to 3.5KB, same content)

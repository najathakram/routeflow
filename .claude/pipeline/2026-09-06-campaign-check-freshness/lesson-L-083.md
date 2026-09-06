### L-083 · 2026-09-06 · tooling · campaign-check freshness

- **Symptom:** four pushes in one day were refused twelve minutes into `npm run verify` with "no test titled
  with REG-B###", although the tests existed and passed — the machine-local Jest report campaign-check reads
  was simply older than the ledger rows it was asked to prove.
- **Root cause:** turbo replays a `test` task whose input tree it has seen before (a worktree whose workspace
  matches master's after a merge), so the reporter never runs and `.campaign/runs/<ws>.json` keeps the tokens
  of its last real run; the gate compared claims against that stale artifact as if it were current.
- **Lesson:** **an artifact a gate consumes must carry its own provenance (its start time) and the gate must
  compare it with the inputs it certifies — the newest commit touching the workspace's tests or the ledger —
  and refuse a stale artifact by name, with the regeneration command, before it scans a single token.**
- **Guard:** `scripts/campaign-check.mjs` freshness rule (full mode, before indexing) + `--freshness-only`
  pre-step at the head of `npm run verify` that asks `turbo --dry-run=json` whether a replay is coming;
  `apps/api/src/common/campaign-check-freshness.spec.ts` T1–T10.

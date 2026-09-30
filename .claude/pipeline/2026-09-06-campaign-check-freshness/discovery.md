# campaign-check freshness guard · Discovery (Fable, 2026-09-06)

**Status: IN PROGRESS** · Scale: small (scripts + docs + one spec; no runtime code, no deploy). Branch
`fix/campaign-check-report-freshness` off master 597c72dc, worktree `rf-registry`. Owner-approved via the
lead (17:0xZ). Run dir: this directory.

## The problem

`npm run verify` (the pre-push hook and CI's single job) ends with `node scripts/campaign-check.mjs`, which
proves every affirmative ledger claim (`proven`/`done` rows) against the machine-local Jest reports the
campaign reporter writes to `.campaign/runs/<ws>.json`. Those reports are written only when Jest actually
RUNS. Turbo caches the `test` task by input hash; when a branch's workspace tree is byte-identical to a tree
that already ran (typically master's, after a local merge), turbo REPLAYS the task and the report keeps
whatever tokens it had when it was last really generated — while the ledger has moved on (new `proven`
rows from a merge, a `prove`, a `discharge`). campaign-check then fails ~12 minutes into the verify with
`B66: no test titled with REG-B66 found in the jest report`, the developer regenerates the report by hand and
re-pushes: another 12 minutes. This refused four pushes on 2026-09-06 alone (registry-guards mobile ×1,
lock-liveness api ×1, two more in the lead's queue) and is lesson L-034's standing trap.

**Whose problem:** every session that pushes from a worktree (the whole fleet, several times a day), and the
lead who pays the host time. **If we ship nothing:** every push from a branch that did not touch a workspace
whose ledger claims changed keeps failing late, and the "regenerate and re-push" ritual stays tribal.

## What "fixed" looks like (success signal)

1. A stale report is refused with ONE clear message that names the workspace, the report's own start time,
   the newer commit that invalidated it (sha, subject, time), and the exact regeneration command
   (`cd apps/<ws> && npx jest --maxWorkers=2`) — never the misleading "no test titled with REG-B###".
2. When turbo would replay the task (cache HIT) the refusal happens in the first seconds of `npm run verify`,
   not after the turbo stage. When turbo would re-run the task (cache MISS) the pre-step lets the verify
   proceed, because the report is about to be regenerated — the guard never blocks a push whose verify would
   have produced a fresh report.
3. The end-of-verify campaign-check enforces the same rule unconditionally (belt and braces), before any
   token scan.
4. A spec proves both modes with fixtures (stale by ledger, stale by spec change, fresh, missing, not
   consulted, HIT vs MISS) and a repo-truth assertion pins the verify chain's pre-step.

## Decisions taken up front

- **Staleness rule (stated in the refusal message):** a report is stale when its own `startTime` is earlier
  than the commit time of the newest commit touching EITHER that workspace's test files OR the ledger shards
  `.claude/campaign/status/*.jsonl`. Commit times, not file mtimes (a checkout rewrites mtimes; commit times
  are what the push carries). Uncommitted spec edits are not the trap (the push does not carry them and turbo
  misses the cache anyway).
- **Only consulted reports are checked** (a workspace with no affirmative T1/T2 claim is not asked for a
  fresh report), mirroring campaign-check's existing `consultsArtifacts` scoping.
- **The pre-step asks turbo, not the filesystem, whether a replay is coming:** `turbo run test
--filter=<ws> --dry-run=json` executes nothing and reports the task's `cache.status`.
- **Refuse, do not self-heal.** Regenerating inside verify would double the host cost when the cache misses
  anyway; the lead asked for an early, clear refusal. A self-healing `--force` re-run is a follow-up knob.

## Non-goals

Turbo output declaration for `.campaign/runs` (would make replays restore stale reports — worse); changing
the ledger semantics or `bugs.mjs`; CI behaviour (a fresh clone has no cache, so every report is generated);
the T2 Playwright report (post-deploy, not part of the hook); the pricing report unless campaign-check reads
it (reader to confirm).

## Deploy-day

Scripts + `.claude/` only: Railway skips it (outside `watchPatterns`); CI runs (scripts/ is not in
`paths-ignore`). Rollback = revert. No flags, no data.

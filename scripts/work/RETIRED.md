# Retired: the GitHub-Project #3 work scripts

`reconcile.mjs`, `claim.mjs`, `trigger.mjs`, `run.mjs` and `claude-hook.mjs` drove the old
GitHub Project #3 work board. Decision D-2026-10-19 retired them: the ops monitor
(`tools/ops-monitor`, events in the private specs repo) replaces them.

Deleted 2026-10-28 (spec R2 item 5, PR r2-b): the five scripts, their self-tests, their
`verify` entries and the `work:reconcile`, `work:reconcile:apply` and `work:claim` npm scripts.
Nothing is kept: a tree-wide grep found no live import or wiring. The `claude-hook`
PostToolUse entry was removed from `.claude/settings.json` in PR #3529, and
`tools/ops-monitor` has its own `lib/reconcile.mjs` (it does not import these).

Still here, not part of this set: `plane-release-sync*`, `plane-release-map.json` and
`install-scheduler.ps1`.

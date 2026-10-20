# Retired: the GitHub-Project #3 work scripts

`reconcile.mjs`, `claim.mjs`, `trigger.mjs` (and `run.mjs`, `claude-hook.mjs`) drove the old
GitHub Project #3 work board. Decision D-2026-10-19 retires them: the ops monitor
(`tools/ops-monitor`, events in the private specs repo) replaces them.

Their self-tests still run in `npm run verify` until a cleanup PR deletes the scripts together
with those tests. The `claude-hook` PostToolUse entry was already removed from
`.claude/settings.json` in PR #3529. Do not add new callers.

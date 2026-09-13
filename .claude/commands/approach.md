---
description: Pin, check, close, or attribute the Part C evaluation-harness approach (dev-pipeline / superpowers / raw) for this project. Say "/approach next <task>", "/approach status", "/approach close ...", "/approach attribute ...".
---

Dispatches to `model-routing/scripts/approach.mjs` — the lifecycle for the three-arm evaluation harness
documented in `~/.claude/skills/model-routing/references/EVAL-PROTOCOL.md`. `$ARGUMENTS` is the
subcommand and its flags, passed through verbatim:

```
node ~/.claude/skills/model-routing/scripts/approach.mjs $ARGUMENTS --project "$(pwd)"
```

Subcommands:

- **`next --task "<head>" [--files a,b] [--force]`** — classifies the task (via
  `route-task.mjs`'s `decideApproach`) and pins an approach — `dev-pipeline` (`lean`/`standard`),
  `superpowers`, `raw`, or `bug-pipeline` — for the **next** session. Writes
  `.claude/approach.json` and flips `enabledPlugins["superpowers@claude-plugins-official"]` in
  `.claude/settings.local.json` (`true` only when the pin is `superpowers`). Refuses if an
  unclaimed pin already exists (pass `--force` to overwrite it) or if the task text reads as
  conversational/a question. **Start a brand-new session after this** — isolation is a
  per-session plugin-enable switch that cannot flip mid-session, so a `superpowers` pin only
  takes effect for a session that launches after `next` runs.
- **`status`** — reports the current pin (approach/profile/task/pinnedAt/sessionId), or "no
  approach pinned."
- **`close --run <slug> [--task-ref <id>] [--first-pass-green true|false] [--findings <c,i,m>]
  [--human-minutes <n>] [--files-touched <n>] [--lines-changed <n>]`** — for a `dev-pipeline` or
  `bug-pipeline` pin, prints the reminder to close out via `dev-pipeline/scripts/closeout.mjs`
  instead (it stamps approach/profile and appends to the ledger itself). For a `superpowers`/`raw`
  pin, appends one ledger row via `pipeline-ledger.mjs append-manual` — true cost and active time
  come from `session-usage.mjs` reading the whole session's transcript, so give it real numbers
  for `--first-pass-green`/`--findings`/`--human-minutes` from what actually happened. Either way,
  clears the pin and disables the superpowers plugin afterward.
- **`attribute --run <slug> --bug <id>`** — records that a bug found later (registry id) escaped
  from a past run, bumping that row's `escapedDefects` — the audit signal
  `pipeline-ledger.mjs compare` needs before it will rank an arm's escaped-defect rate.

One task per pinned session — never mix approaches inside one session, and never run a house build
skill (`dev-pipeline`, `bug-pipeline`, `new-feature`, …) inside a session meant to be a `raw` or
`superpowers` data point. Full contamination rules and the quality rubric: `EVAL-PROTOCOL.md` above.

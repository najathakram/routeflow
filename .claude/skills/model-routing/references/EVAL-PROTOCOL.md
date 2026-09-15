# Evaluation protocol — dev-pipeline vs superpowers vs raw (Part C, 2026-09-12)

Owner's goal (task-loop-rebuild.md "Part C"): "audit the spending, time consumption and evaluate it
against superpowers, and the model as is... High quality at the lowest cost and highest efficiency."
This is the harness that turns that into a measured, ledger-backed answer instead of a taste call.

## The arms

Four methodologies can execute a task; three of them are the first-class **evaluation arms** this
protocol compares (the fourth, bug-pipeline, is dev-pipeline's own bugfix mode — not a rotation arm,
never compared against the other three):

- **`dev-pipeline`** — the house task-loop engine (`dev-pipeline/pipeline.js`), profile `lean` or
  `standard`. Frame → tests → implement → review → fix loop, run by Fable/Sonnet/Opus/Haiku agents at
  explicit model+effort per the routing table. This is "the pipeline."
- **`superpowers`** — the `superpowers` plugin's own skills (brainstorming, TDD, subagent-driven
  development, systematic debugging, etc.) driving the session instead of the house engine.
- **`raw`** — the session **as-is**: CLAUDE.md + the house hooks (`orient.mjs`, `stop-global.mjs`,
  `route-task.mjs`'s advisory line) + Claude's built-in tools. No pipeline engine invoked, no
  superpowers plugin enabled, no house build skill (`dev-pipeline`, `bug-pipeline`, `new-feature`,
  etc.) invoked. This is the methodology-free baseline every comparison is measured against.
- **`bug-pipeline`** (not a rotation arm) — dev-pipeline's bugfix mode, selected automatically for any
  task carrying a known-defect signal (a registry id, or bug wording like "crash"/"regression"/
  "broken"). It closes out through `closeout.mjs` exactly like a plain dev-pipeline run and is stamped
  `approach: 'dev-pipeline'` there — it never appears in `compare`'s arm table under its own name.

## One task per session (the isolation protocol)

Isolation is a **per-session plugin-enable switch that cannot flip mid-session** — the superpowers
plugin's bootstrap activates on every task once `enabledPlugins["superpowers@claude-plugins-official"]`
is `true` in `.claude/settings.local.json`, and there is no session-scoped disable. That means:

1. Decide the approach **before** the session launches, via `approach.mjs next` (below) — never mid-session.
2. Run **exactly one task** under that pin, then close it out and clear the pin before starting the next.
3. Never enable superpowers in a session that is meant to be a `dev-pipeline` or `raw` data point, and
   never invoke a house build skill (dev-pipeline/bug-pipeline/new-feature) in a session meant to be
   `raw` or `superpowers` — mixing methodologies inside one session contaminates every arm it touches.
4. A fresh session picking up a `superpowers` pin only gets the plugin's skills if the pin was set (and
   the settings file flipped) **before** that session's first launch — `approach.mjs next` prints
   "Start a NEW session for this pin to take effect." for exactly this reason.

## Quality rubric (every ledger row, any arm)

`pipeline-ledger.mjs`'s `buildRow`/`computeQuality` (`model-routing/scripts/pipeline-ledger.mjs`,
`computeQuality`, ~line 497) fills the same `quality` object on every row regardless of arm — all
fields are null-safe (missing source data reads as `null`, never a guessed `0`/`false`):

| Field | Meaning | Source |
|---|---|---|
| `firstPassGreen` | `true` only when the gate passed AND zero fix rounds were needed | engine: `result.gate.pass === true && result.fixRounds === 0`; manual: the `--first-pass-green` flag you assert yourself |
| `reviewFindings` | `{ critical, important, minor }` counts | engine: tallied from `result.confirmedFindings[].severity` (`blocker`→critical, `major`→important, `minor`→minor); manual: the `--findings <c,i,m>` flag |
| `humanMinutes` | minutes of owner attention the run actually consumed | `result.quality.humanMinutes` (engine) or `--human-minutes` (manual) — not auto-derived; nothing measures this for you |
| `escapedDefects` | count of bugs later found in this run's output | starts `null` (never audited); incremented only by `pipeline-ledger.mjs attribute` / `approach.mjs attribute` |
| `filesTouched` | count of modified/planned files | `result.manifest.files` (engine only — manual rows have no manifest, so this stays `null`) |
| `linesChanged` | sum of `changedLines` across those files | same source as `filesTouched`; `null` for manual rows |

An unaudited row's `escapedDefects` is `null`, not `0` — `compare`'s ranking treats "never audited" and
"confirmed zero defects" as different claims (see Reading `compare`'s output below).

## How a row gets into the ledger

- **`dev-pipeline` / `bug-pipeline` runs**: closed out via `dev-pipeline/scripts/closeout.mjs <runDir>`,
  which stamps `result.approach`/`result.profile` and calls `pipeline-ledger.mjs append --usage
  <session-usage.json>` for you. `approach.mjs close` on one of these pins prints this reminder rather
  than appending anything itself.
- **`superpowers` / `raw` runs**: no `result.json`, no phase report — there is nothing to estimate
  from. `pipeline-ledger.mjs append-manual --run <slug> --approach superpowers|raw --session <sid>
  [--task-ref <id>] [--first-pass-green true|false] [--findings <c,i,m>] [--human-minutes <n>]
  [--files-touched <n>] [--lines-changed <n>]` shells out to `session-usage.mjs <sid> --all --project
  <dir> --json` to read the **whole session's** true cost and active time (there is no per-run
  breakdown below the session level, which is exactly why the protocol is one task per session), and
  writes a row with `telemetry: 'true'`. `approach.mjs close` is the normal way to trigger this — it
  reads the pin's `sessionId` (stamped by `orient.mjs` at `SessionStart`) for you.
- Every row also carries `approach`, `profile` (dev-pipeline only), and `taskRef` (a Plane/registry id
  or a one-line task head) — a row with none of these reads as `'legacy'` in `compare`/`summary`.

## The approach lifecycle CLI (`model-routing/scripts/approach.mjs`)

Read directly from the current script (`approach.mjs`, header comment + `cmdNext`/`cmdStatus`/
`cmdClose`/`cmdAttribute`), not from an earlier draft:

- **`next --task "<head>" [--files a,b] [--project <dir>] [--force]`** — classifies the task via
  `route-task.mjs`'s `decideApproach` (using a synthetic pending session id, `--allow-superpowers` so a
  rotation-superpowers turn is actually claimed instead of deferred), writes the pin
  `.claude/approach.json { approach, profile, taskHead, pinnedAt, sessionId: null }`, and flips
  `enabledPlugins["superpowers@claude-plugins-official"]` in `.claude/settings.local.json` to `true`
  iff the decision was `superpowers` (every other key in that file is read back and rewritten
  verbatim). Refuses (without `--force`) if an unclaimed pin (`sessionId: null`) is already on disk —
  that is a previous `next` nobody started a session for yet — and refuses outright if the task text
  classifies as conversational/a question (nothing to pin). Prints "Start a NEW session for this pin to
  take effect."
- **`status [--project <dir>]`** — reports the current pin's approach/profile/task/pinnedAt/sessionId
  (or "no approach pinned").
- **`close --run <slug> [--task-ref <id>] [--first-pass-green true|false] [--findings <c,i,m>]
  [--human-minutes <n>] [--files-touched <n>] [--lines-changed <n>] [--project <dir>]`** — for a
  `dev-pipeline` or `bug-pipeline` pin, prints the `closeout.mjs` reminder (no ledger write here); for a
  `superpowers`/`raw` pin, requires the pin to already carry a real `sessionId` (refuses if still
  `null` — run at least one prompt in the pinned session first, so `orient.mjs` can stamp it) and calls
  `pipeline-ledger.mjs append-manual` with those flags. Either way, disables the superpowers plugin and
  clears the pin afterward — `close` is the only thing that turns the plugin back off.
- **Stale-pin claim window** — `orient.mjs`'s `SessionStart` stamp only claims an unclaimed pin
  (`sessionId: null`) within `STALE_PIN_TTL_MS` (6 hours) of `pinnedAt`; past that it is treated as
  abandoned, prints an "appears abandoned -- not claimed" notice, and is deliberately never
  auto-claimed (`sessionId` stays `null` for good), so `close` above keeps refusing it. Recover with
  `approach.mjs next --force` (clears the stale pin and re-classifies fresh) or `approach.mjs status`
  / a manual delete of `.claude/approach.json`.
- **`attribute --run <slug> --bug <id> [--project <dir>]`** — forwards to `pipeline-ledger.mjs
  attribute`, which bumps that row's `quality.escapedDefects` and appends the bug id to
  `quality.escapedBugs`. This is how a defect found later gets charged back to the arm/run that shipped
  it — the audit signal `compare`'s ranking depends on.
- **`--selftest`** — exercises the full pin lifecycle plus the `settings.local.json` merge-not-overwrite
  guarantee against scratch project dirs; run it after touching this script.

## The rotation rule (`route-task.mjs`'s `decideApproach`)

Precedence, evaluated in this order (matches `decideRoute`'s own precedence so a one-line bug fix still
reaches `bug-pipeline` rather than misrouting to "trivial → raw"):

1. **An explicit pin always wins** — a pin whose `sessionId` matches this session (or is still
   unclaimed, `null`) is used as-is, no re-scoring.
2. **A bug with a repro/known-defect signal → `bug-pipeline`** (never rotates).
3. **HIGH-risk, or major (HIGH breadth / explicit orchestration), or UI work → `dev-pipeline` `standard`**
   (never rotates) — the plan's "HIGH-risk/major/UI always dev-pipeline standard" rule.
4. **Trivial (bounded, LOW breadth, LOW risk, no orchestration) → `raw`** — the plan's "trivial always raw."
5. **Everything else ("small LOW-risk")** rotates through `['dev-pipeline', 'superpowers', 'raw']`
   (`.claude/pipeline/approach-rotation.json`, `{ next, log[] }`), **advanced exactly once per
   session** — a second task in the same session that lands back on this branch gets the same arm the
   session was already assigned, not a fresh spin.

One wrinkle unique to the rotation's `superpowers` slot: an ordinary live session (the `UserPromptSubmit`
hook calling `route-task.mjs` without `--allow-superpowers`) can never flip the plugin mid-session, so
when the rotation's turn lands on `superpowers` there, the router **defers it forward** to the next arm
for this session and prints `Note: superpowers arm: run 'approach.mjs next' and start a new session` —
the log entry still records the deferred `slot` alongside the `approach` actually delivered, so the
rotation history stays honest. `approach.mjs next --allow-superpowers`-style claiming (built into `next`
itself) is the only way to actually land on `superpowers` — pin it before the session starts.

## Contamination rules (do not violate these)

- **Never enable the superpowers plugin in a session meant to produce a `dev-pipeline` or `raw` data
  point.** `approach.mjs next`/`close` are the only things that should ever touch
  `enabledPlugins["superpowers@claude-plugins-official"]`.
- **Never mix arms in one session.** One task, one pinned approach, one close-out, per session.
- **Isolation is decided before launch, never mid-session** — there is no way to disable superpowers
  once its bootstrap has activated for the session; the fix is to not have enabled it in the first
  place for a non-superpowers run.
- **A `raw` session invokes no house build skill.** `dev-pipeline`, `bug-pipeline`, `new-feature`, and
  friends are the thing being compared against — invoking one inside a `raw` run stops it being a raw
  data point.

## Minimum sample size

`compare` (below) treats an arm with `n < 10` telemetry rows as **`insufficient`** and excludes it from
ranking, regardless of how good its numbers look — ten is the floor before a mean/median/rate means
anything for a $ and defect-rate comparison this noisy. Rows must be `telemetry: 'true'` with a non-null
`trueCostUsd` to count at all (`isTrueTelemetryRow`) — legacy/estimate-only rows never enter the
denominator.

## Reading `pipeline-ledger.mjs compare`'s output

`node model-routing/scripts/pipeline-ledger.mjs compare [--min-n 10] [--json] [--project <dir>]` groups
`telemetry:'true'` rows with a non-null `trueCostUsd` by `approach` (dev-pipeline rows sub-grouped by
`profile`), and for each arm with `n >= --min-n` (default 10) prints:

```
arm  n  mean $  median $  median active min  first-pass-green  findings c/i/m  escaped defects
```

- **`mean $` / `median $`** — `trueCostUsd` per run (from `session-usage.mjs`, never the engine's own
  estimate).
- **`median active min`** — `activeMs / 60000`, median across the arm's rows.
- **`first-pass-green`** — the fraction of rows with `quality.firstPassGreen === true`.
- **`findings c/i/m`** — mean `quality.reviewFindings.{critical,important,minor}` per run.
- **`escaped defects`** — mean `quality.escapedDefects` per run; an arm nobody has ever `attribute`d
  prints as unavailable (`n/a` in text mode, `null` in `--json`) rather than `0` — see the ranking rule
  below.
- An arm below `--min-n` prints `<arm>: insufficient (n=<k>)` and never appears in the ranking line.

**The final "cheapest arm" line**: only arms that are (a) sufficient (`n >= min-n`) AND (b) **audited**
(`meanEscapedDefects` is not `null` — i.e. `attribute` has run at least once against a row in that arm)
are eligible. Among those, the arm(s) tied for the best (lowest) `meanEscapedDefects` are the only ones
eligible to be named cheapest; among THOSE, the one with the lowest `meanTrueCostUsd` wins. This is
deliberate: an arm nobody has ever audited for escaped defects cannot out-rank a confirmed-clean arm
just because it looks cheaper — under-monitoring must never read as quality. If no arm is both
sufficient and audited, `compare` says so explicitly instead of naming a winner (`"no arm has n >=
<min-n>"` or `"no arm has escaped-defect data yet (run 'attribute' at least once per arm to establish a
baseline)"`).

`summary`'s own scorecard (`pipeline-ledger.mjs summary`) groups the routing table by `level`/`phase`/
`model`/`profile`/`approach` too, for the finer-grained "which model on which phase" question —
`compare` is the coarser "which whole methodology" question.

## The `raw` arm, precisely defined

`raw` = the session **as it already is**, nothing added and nothing suppressed: `CLAUDE.md` (project and
user), the house hooks that are already registered at user scope (`orient.mjs` on `SessionStart`,
`stop-global.mjs` on `Stop`, `route-task.mjs`'s advisory line on `UserPromptSubmit`), and Claude's
built-in tools (Read/Edit/Write/Bash/Grep/Glob/Agent/etc.). No pipeline engine is invoked
(`dev-pipeline`/`bug-pipeline`), no superpowers plugin is enabled, and no house build skill
(`new-feature`, `db-migration`, etc.) is deliberately invoked as the task's methodology. It is the
control condition every other arm is measured against.

# CLI reference

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** anyone implementing, calling, or
scripting against the `bugflow` command line — this is the implementation contract, not a tutorial

Every command below is a promise about what it reads, what it writes, and what its exit code
means. An implementation that reads or writes something not listed here, or returns a different
code for the same condition, has drifted from this contract — fix the contract or the code, in
the same commit. See [GLOSSARY](./GLOSSARY.md) for any term used but not redefined here, and
[LIFECYCLE](./LIFECYCLE.md) for the status state machine each command participates in.

## Conventions

- A bug or batch reference is a bare issue number (`#N` or `N`); a batch may also be written
  `batch:#M` where the distinction matters.
- `[--json]`, where listed, prints the same information structured for a script, and changes
  nothing else.
- Every command authenticates as the **calling seat's own `gh` login** — no shared bot identity. A
  cloud Routine acts as the account that owns it; a desktop task acts as whoever ran
  `gh auth login` on that machine. See [WORKERS](./WORKERS.md).
- "Writes" means GitHub-visible state (labels, assignee, comments, issue/PR bodies, sub-issue
  links, Project v2 fields) unless marked **local** (`snapshot`, `render`, `self-test` write to
  the repo checkout, not GitHub).
- All label writes are **replace-in-place** within their namespace — never two values live in one
  namespace at once (e.g. two `status:*` labels on one issue).

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Success. |
| `2`  | A gate failed — an unmet obligation (`check`) or an assertion the command could not back with evidence (`verify`). |
| `3`  | Claim lost — another live claim beat this one in the compare-and-swap. |
| `4`  | Not takeable — the target does not currently satisfy [takeable](./GLOSSARY.md#takeable) (wrong status, class not allowed for this seat, over the daily cap, or an open blocker). |
| `5`  | Auth — `gh` is not authenticated, or the authenticated identity lacks a permission the command needs. |

Any other non-zero exit is a usage or unexpected error, carrying no protocol meaning beyond "this
command did not complete."

---

## `bugflow setup`

**Purpose.** One-time, idempotent bootstrap: labels, issue types, the Project + fields, and the
snapshot branch. [MIGRATION](./MIGRATION.md) Step 1 is this command.

- **Reads:** `bugflow.config.json` (`labels`, `project`, `snapshot.branch`).
- **Writes:** every namespaced label plus the markers (`gh label create … --force`, modelled on `team.mjs`'s `cmds.setup`); custom issue types `Bug`/`Batch` (`VERIFY:` exact org-level API/UI call, unconfirmed at adoption time); the Projects v2 project + one field per namespace; the orphan `claude/bugflow-snapshot` branch if absent.
- **Exit:** `0` ok (prints created vs. already-existing); `5` auth.
- **Idempotency:** yes — only creates what's missing; nothing here is destructive.

## `bugflow file`

```bash
bugflow file "<title>" --severity <s> --area <a> [--files "a b"] [--symptom "..."] [--source <s>] [--force]
```

**Purpose.** File a new bug — the one entry point for "something is wrong"; a human, monitor, or
agent all go through this, never a hand-created issue.

- **Reads:** `bugflow.config.json` (`labels` prefixes; `areas`, to validate `--area`); open bugs' titles, to check for an exact match.
- **Writes:** a new GitHub Issue, type `Bug`, body carrying `## Files` (from `--files`) and `## Symptom` (from `--symptom`, when given); labels `status:triage`, `severity:<s>`, `area:<a>`, `source:<source or "owner" by default>`.
- **Exit:** `0` filed; `4` an open bug already has this exact title and `--force` was not given; `5` auth.
- **Idempotency:** filing the same title twice warns and exits `4` unless `--force` overrides it.

## `bugflow triage`

```bash
bugflow triage #N --class <c> --tier <t> --severity <s> --area <a> --files "..."
```

**Purpose.** Completes classification of a `status:triage` bug, moving it to `ready`, `parked`
(carve-out), or `blocked` (open blocked-by) — see [LIFECYCLE](./LIFECYCLE.md).

- **Reads:** the issue's body/labels; `carveOut` patterns (re-runs the classifier against title/files rather than trusting `--class` verbatim — a mismatch is surfaced, not silently accepted); the issue's `blocked-by` graph.
- **Writes:** labels `class:<c>`, `tier:<t>`, `severity:<s>`, `area:<a>`, `harness:ralph|full` (computed from class/tier/file count/hub-file membership — see [HARNESS](./HARNESS.md)); the `## Files` section; `status:ready|parked|blocked`.
- **Exit:** `0` ok; `5` auth.
- **Idempotency:** yes — re-running with the same facts re-derives the same labels.

## `bugflow brief #N [--json]`

**Purpose.** The one thing a worker reads before starting — the bug's own text, its batch's plan
and ordering, sibling bugs, any contested/superseded flags, and the exact commands to run next.

- **Reads:** the issue and its parent batch (if any), sibling sub-issues of that batch, `blocked-by`.
- **Writes:** nothing.
- **Exit:** `0` ok; `1` if `#N` does not exist.
- **Idempotency:** yes (pure read).

## `bugflow next [--json] [--seat <login>]`

**Purpose.** The dispatcher's selector: the head of wave 1 among batches that are currently
takeable and unclaimed for `--seat` (defaulting to the calling identity's own login).

- **Reads:** `wave:N` labels from the last `plan` run (`plan` computes the graph; `next` only reads it); current `status`/claim state per candidate; `bugflow.config.json`'s `automation.enabled`, `seats[login].allowedClasses`, and today's claim count vs `dailyClaimCap`.
- **Writes:** nothing.
- **Exit:** `0` (an empty wave 1 is still a successful answer); `4`, with an explicit reason line, when `automation.enabled` is `false` or the seat is over its `dailyClaimCap` (RUNBOOK.md's pause-all-automation procedure); `5` auth.
- **Idempotency:** yes.

## `bugflow claim #N | batch:#M`

**Purpose.** Take ownership: GitHub assignee + a lease comment, resolved by compare-and-swap.

- **Reads:** existing comments on the target (to compute live claims per [CLAIMS-AND-LEASES](./CLAIMS-AND-LEASES.md)); the authenticated `gh` login.
- **Writes:** assignee = the calling login; a comment `<!--bugflow:claim id=<login>/<host>/<worktree> exp=<ISO>-->`; `status:claimed` — on a batch target, assignee and `status:claimed` are set on every **open** sub-issue in one pass, not just the parent (see [CLAIMS-AND-LEASES](./CLAIMS-AND-LEASES.md)).
- **Exit:** `0` claimed; `3` lost the race (another live claim now has the lowest comment id); `4` not takeable; `5` auth.
- **Idempotency:** re-claiming while already holding it is a no-op success; re-claiming after losing the race returns `3`, never a silent success.

## `bugflow heartbeat #N`

**Purpose.** Extend a held claim's lease without losing the original claim's identity.

- **Reads:** the current claim comment for the calling identity, re-verifying it is still the live claim holder; exit `3` if not.
- **Writes:** edits that same comment's `exp=` field forward by `lease.minutes`.
- **Exit:** `0` ok; `3` if the calling identity no longer holds the claim (reaped, or lost to another claim since); `5` auth.
- **Idempotency:** yes — safe to call repeatedly; each call simply re-extends.

## `bugflow release #N [--reason "<text>"]`

**Purpose.** Give a claim back — voluntarily, or on a Ralph-tier cap-out — restoring `ready` (or
`regressed`) and clearing the assignee.

- **Reads:** the current claim, re-verifying it belongs to the calling identity (exit `1` if not — see below).
- **Writes:** a release marker; assignee cleared; `status:ready` (or the prior workable status); when `--reason` names a cap-out, an attempts comment plus label `needs:human`.
- **Exit:** `0` ok; `1` if the calling identity holds no claim on this target.
- **Idempotency:** yes — releasing an already-released target is a harmless no-op.

## `bugflow start #N`

**Purpose.** Records that work has begun (which branch/worktree) — flips `claimed` →
`in_progress`.

- **Reads:** the current git branch and worktree (local); the existing claim, re-verifying it is still held by the calling identity.
- **Writes:** `status:in_progress`; a comment recording branch/worktree.
- **Exit:** `0` ok; `4` if the calling identity does not hold the claim.
- **Idempotency:** re-running updates the recorded branch (e.g. after switching) — safe to re-run.

## `bugflow prove #N --pr <num>`

**Purpose.** Records that this bug's proof is in, once `<num>` has **merged** and already passed
`bugflow check` pre-merge. `check` is the independent gate that already ran; `prove` turns that
into a durable record — it never writes a status label itself; `bugflow sync` derives
`status:verifying` from the record it leaves.

- **Reads:** PR `<num>`'s merge state (must be merged) and its `Closes #N` reference; the existing claim, re-verifying it is still held by the calling identity.
- **Writes:** a comment `<!--bugflow:proof pr=<num> tier=<t> token=REG-#N present=<bool> ci=<green|red|n/a>-->` — `t1`: a `REG-#N` Jest test passing in this PR's own CI run; `t2`: a `REG-#N`-tagged Playwright spec present in the diff (can't be passing pre-deploy); `t3`: a build-plan row carrying the token.
- **Exit:** `0` ok; `1` PR missing or doesn't reference `#N`; `3` claim no longer held; `4` `<num>` not merged yet; `5` auth.
- **Idempotency:** yes — re-pointing at the same PR is a no-op; a different PR overwrites and is logged.

## `bugflow verify --deploy <sha> --result green|red` (or `#N --manual [--evidence "<text>"]`)

**Purpose.** Records a deploy's outcome for every `verifying` bug whose merged PR is part of
`<sha>` — the deploy-pipeline counterpart to the legacy `discharge`/`reopen` pair. The `--manual`
form is the `tier:t3` counterpart: a human records that a manual build-plan verification happened,
since a `tier:t3` bug has no CI/E2E run to read a result from automatically — human-only, never called by
a worker. Neither form writes a status label itself; `bugflow sync` derives
`status:done`/`status:regressed` (with the severity bump on a regression) from what either leaves.

- **Reads:** (`--deploy`) which bugs are `status:verifying` with a merged PR ancestor of `<sha>`, and for `--result red`, which specific REG token the post-deploy check/E2E run failed (never a blanket regress of every `verifying` bug against one red deploy); (`--manual`) the issue's `tier:` label, which must be `t3`.
- **Writes:** a comment `<!--bugflow:deploy sha=<sha-or-"manual"> result=green|red-->` per bug, citing the deploy/run or, for `--manual`, the `--evidence` text — the same record shape either way, so `sync` derives status from it identically.
- **Exit:** `0` ok; `2` `--result red` with no REG-token evidence attributable to any specific bug, or `--manual` on a non-`tier:t3` issue, or with no `--evidence`; `5` auth.
- **Idempotency:** yes — re-running the same invocation is safe; writes replace in place rather than appending a second verdict.

## `bugflow plan [--dry-run]`

**Purpose.** Attach-or-wave: attaches a newly-ready bug to an overlapping in-flight batch (same
area, shared file); otherwise groups `ready` bugs into new batches by file-overlap connected
components, then colours every batch (new and in-flight) into waves.

- **Reads:** every `status:ready` bug's `## Files`/`area:`; every claimed/in-progress batch (pre-coloured wave-1 occupants); `bugflow.config.json`'s `hubFiles` and `batch.maxBugs`.
- **Writes:** `--set-parent` to attach a bug to an existing batch; a new parent `Batch` issue with sub-issues for a freshly formed group; `wave:N` on every batch. `--dry-run` writes nothing and only reports what it would do.
- **Exit:** `0` ok; `5` auth.
- **Idempotency:** yes — deterministic ranking (severity, batch size, id) always reproduces the same grouping and wave numbers.

## `bugflow sync [--quiet]`

**Purpose.** Idempotent state derivation: reads PR/CI/deploy/blocker/lease facts and writes only
the `status` transitions those facts imply — never a hand-set status as input. Nothing else keeps
status current on its own.

- **Reads:** every open `Bug`/`Batch` issue; open PRs' `Closes #N` refs + CI status rollup; the configured deploy environment/check-run names; `blocked-by`; live claims (lease expiry, distinct from `reap`).
- **Writes:** `status:in_review` (PR opened, `Closes #N`), `status:ready` (PR closed unmerged), `status:verifying` (PR merged + `prove`'s proof present — passing for `tier:t1`), `status:done` (`verify` recorded green), `status:regressed` (`verify` recorded red — severity bumped one rank, critical stays critical, reopened), `status:blocked`/`status:ready` (blocker opened/closed); a `status:triage` bug gets the same `class`/`tier`/`area`/`harness` backstop `triage` computes (see [LIFECYCLE § what sync checks](./LIFECYCLE.md), step 5); `needs:human` on a second qualifying open PR or an unresolved assignee/lease anomaly; Project v2 mirrors of every label.
- **Exit:** `0` always — `sync` reports drift, it never blocks a caller (the same contract `bugs.mjs sync` honours, and the contract Gate 4 already honours on `master` today, since PR #597 landed it — `bugflow sync --quiet` takes over that same contract at cut-over).
- **Idempotency:** yes, by construction — running it twice on unchanged facts writes nothing the second time.

## `bugflow reap`

**Purpose.** Release every expired lease, from any machine, on any bug or batch.

- **Reads:** every open issue's claim comments.
- **Writes:** a release marker per expired claim; assignee cleared. `bugflow sync` is what returns
  `status` to its prior workable value from the release marker — `reap` itself never writes a
  status label.
- **Exit:** `0` ok (reports the count reaped); `5` auth.
- **Idempotency:** yes.

## `bugflow snapshot` (local)

**Purpose.** Export current issue state to a git-diffable file, since GitHub's API is otherwise the
only place this data lives.

- **Reads:** every open (and recently closed) `Bug`/`Batch` issue's fields and labels; timeline
  events (`status:*` labeled/unlabeled) since `snapshot/meta.json`'s high-water mark.
- **Mechanism:** fetches `snapshot.branch` (config) into a detached worktree
  (`git worktree add --detach`), never the caller's own checkout; commits and pushes; creates the
  branch as an orphan if absent.
- **Writes (on branch `claude/bugflow-snapshot`):** `snapshot/issues.jsonl` (full replace), an
  append to `snapshot/events.jsonl` per new event since the high-water mark, and
  `snapshot/meta.json` (the last processed timeline event id/timestamp).
- **Exit:** `0` ok; `5` auth.
- **Idempotency:** yes — `issues.jsonl` is always a safe full re-export; `events.jsonl` appends
  only newer events, so a no-op re-run appends nothing.

## `bugflow check` (CI gate)

**Purpose.** The proof gate: every `Closes #N` on the PR under test (`#N` type `Bug`) needs a
`REG-#N`/`REG-B###` proof **present**, by tier — and, `tier:t1` only, **passing** (`t2`/`t3` can't
pass pre-deploy; see [LIFECYCLE.md](./LIFECYCLE.md)). A required check / merge-queue gate, not
interactive.

- **Reads:** the PR's `Closes #N` references; the issue's `tier:` label; the Jest/Playwright JSON
  reporter output (`t1`) or the PR diff (`t2`/`t3`, token presence only); `proof.tokenFormat`.
- **Writes:** nothing — a pass/fail signal only.
- **Exit:** `0` every claim discharged — present per tier, passing required only for `tier:t1`;
  `2` any gap (missing report for `t1`, no token present for any tier, a skipped/`.todo` test
  standing in for the `t1` proof).
- **Idempotency:** yes (pure read + judgement).

## `bugflow board [--json]`

**Purpose.** Human-facing summary of everything open, by derived lane — the read-only twin of
`sync`, for a person rather than a machine.

- **Reads:** everything `sync` reads.
- **Writes:** nothing.
- **Exit:** `0`; `5` auth.
- **Idempotency:** yes.

## `bugflow import --from <dir>`

**Purpose.** One-time, re-runnable migration of the legacy registry (`.claude/campaign/bugs/B###.md`
+ `status/F##.jsonl`) into GitHub Issues — see [MIGRATION](./MIGRATION.md) for the full procedure
this is one step of.

- **Reads:** the legacy catalogue, records, and ledger shards under `<dir>`.
- **Writes:** one new Issue (type `Bug`) per legacy id not already imported, title carrying
  `[B###]`, body carrying the record's history; `status`/`class`/`tier`/`severity`/`area` labels
  ported from the legacy row.
- **Exit:** `0` ok (reports counts imported/skipped); `5` auth.
- **Idempotency:** dedupes on the `[B###]` title prefix — an id already present as an open or
  closed issue's title is skipped rather than re-filed.

## `bugflow render [--out <path>]` (local)

**Purpose.** A static, human-browsable view for offline reading — GitHub Projects v2 is the
primary dashboard (see [DASHBOARD](./DASHBOARD.md)); this is a fallback, not a replacement.

- **Reads:** the last `snapshot` export (or the live API, if newer).
- **Writes (local):** a static HTML file at `--out`, default `local-assets/bugflow/index.html`
  (gitignored — nothing rendered here goes under `docs/`, per the repo's heavy-files policy).
- **Exit:** `0`.
- **Idempotency:** yes (regenerates in place).

## `bugflow self-test` (local)

**Purpose.** bugflow's own correctness gate, run in its own CI job — the direct descendant of the
legacy `bugs.mjs self-test` suite.

- **Reads:** nothing external; drives the real CLI against fixtures.
- **Writes:** nothing durable (temp fixtures, cleaned up).
- **Exit:** `0` pass; `2` a check failed.
- **Idempotency:** yes.

---

## Labels it may write

✓ = this command may write to this namespace. `✓†` = only as the automatic backstop for a bug
still sitting in `status:triage` that nothing has explicitly triaged yet — the same computation
`triage` performs on demand. Markers (`approved:owner`, `needs:human`, `resolution:*`) are listed
separately below the table — most are not written by any command here.

| Command      | status | class | tier | severity | area | wave | harness | source |
| ------------ | :----: | :---: | :--: | :------: | :--: | :--: | :-----: | :----: |
| `file`       |   ✓    |       |      |    ✓     |  ✓   |      |         |   ✓    |
| `triage`     |   ✓    |   ✓   |  ✓   |    ✓     |  ✓   |      |    ✓    |        |
| `brief`      |        |       |      |          |      |      |         |        |
| `next`       |        |       |      |          |      |      |         |        |
| `claim`      |   ✓    |       |      |          |      |      |         |        |
| `heartbeat`  |        |       |      |          |      |      |         |        |
| `release`    |   ✓    |       |      |          |      |      |         |        |
| `start`      |   ✓    |       |      |          |      |      |         |        |
| `prove`      |        |       |      |          |      |      |         |        |
| `verify`     |        |       |      |          |      |      |         |        |
| `plan`       |        |       |      |          |      |  ✓   |         |        |
| `sync`       |   ✓    |   ✓†  |  ✓†  |    ✓     |  ✓†  |      |    ✓†   |        |
| `reap`       |        |       |      |          |      |      |         |        |
| `snapshot`   |        |       |      |          |      |      |         |        |
| `check`      |        |       |      |          |      |      |         |        |
| `board`      |        |       |      |          |      |      |         |        |
| `import`     |   ✓    |   ✓   |  ✓   |    ✓     |  ✓   |      |         |        |
| `render`     |        |       |      |          |      |      |         |        |
| `self-test`  |        |       |      |          |      |      |         |        |

**Markers.** `approved:owner` is applied by a human directly on GitHub — no command here writes
it; a fleet seat must never approve its own carve-out bug. `needs:human` is applied by `release`
on a harness cap-out, and by `sync` on a claim/PR anomaly it cannot resolve on its own (a second
qualifying open PR, or an assignee/lease mismatch). `resolution:*` is always applied by a human —
either directly (`gh issue close --reason not_planned`), or by `triage` on an evidence-backed
already-fixed/refuted finding; no command here writes it unattended.

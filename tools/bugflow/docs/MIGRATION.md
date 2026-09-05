# Migration from the campaign stores

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** whoever executes the cutover from
`.claude/campaign/` + `scripts/campaign/bugs.mjs` + `scripts/team/team.mjs` to bugflow

Five ordered steps, each with a rollback note, moving 212 existing bug records and their state from
three hand-built stores (see [`.claude/skills/bug-registry/SKILL.md`](../../../.claude/skills/bug-registry/SKILL.md)'s
"three stores" model) onto GitHub Issues as the single record. Nothing here is reversible-by-default
except Step 5 — every earlier step is additive to GitHub and leaves the legacy stores untouched, so
stopping partway costs nothing beyond the time spent. See [DATA-MODEL.md](DATA-MODEL.md) for the
target shape being migrated *to*, [PLANNING.md](PLANNING.md) for the waves algorithm being ported, and
[CLI.md](CLI.md) for every command named below.

## Step 0 — land PR #597 — DONE

**DONE — #597 merged as `10ddc3fa` on 2026-09-05.** `feat/bug-registry` held all 212 catalogue
records, `classify()`, and the waves/planning algorithm; nothing below could start without reading
them from somewhere, and that PR was where they lived. It landed cleanly enough on `master` that the
salvage-without-merging fallback (exporting the records directly from the `rf-registry`
branch/worktree instead of merging) was never needed. Project lesson L-027 still applies going
forward from here: a hook or a migration step resolves paths against the tree it runs in, so Step 1
onward must run from whichever worktree is current for `master`, not from `rf-registry`'s own.

**Rollback:** not applicable — this step is complete; `master` now holds the merged registry (records,
`classify()`, the waves algorithm, and `.claude/hooks/stop.mjs`'s Gate 4), and there is no unmerged
branch left to choose a path for.

## Step 1 — `bugflow setup`

```bash
bugflow setup
```

One command bootstraps everything this step used to be a manual checklist for (see
[CLI § bugflow setup](CLI.md)):

- **Labels** (see the brief's Labels section for the full set — `status:*`, `class:*`, `tier:*`,
  `severity:*`, `area:*`, `wave:N`, `harness:*`, `source:*`, plus markers `approved:owner`,
  `needs:human`, `resolution:wontfix|duplicate|cannot-reproduce`) — `gh label create <name> --color
  <hex> --description "<desc>" --force` in a loop, the same primitive `scripts/team/team.mjs`'s
  `cmds.setup` already uses for its own smaller label set.
- **Issue types** `Bug` and `Batch` (GitHub issue types, GA per the brief's GitHub-facts section).
  `VERIFY:` exact `gh api`/settings-UI call for org-level issue-type creation — not covered by any
  file read for this migration.
- **Project** — `gh project create --owner <org> --title "bugflow"`, its number recorded in
  `bugflow.config.json`'s `project` key, one custom field per label namespace (`sync` writes into
  these — see [DASHBOARD.md](DASHBOARD.md)).
- **Snapshot branch** — created as an orphan if absent, via a detached worktree
  (`git worktree add --detach`), never the operator's own checkout — the same mechanism
  `bugflow snapshot` itself uses on every later run (see [CLI § bugflow snapshot](CLI.md)).

**Rollback:** every object created here is additive and independently deletable (`gh label delete`,
Project settings, `git push origin --delete claude/bugflow-snapshot`) with zero effect on the legacy
stores, which nothing in this step reads from or writes to.

## Step 2 — `bugflow import --from .claude/campaign`

```bash
bugflow import --from .claude/campaign
```

### State mapping (the one non-obvious table)

Read directly from a live shard row's actual fields (`.claude/campaign/status/F##.jsonl`: `id`,
`batch`, `tier`, `state`, `pr`, `proof`, `evidence`, `roundSha`, `buildPlan`, `dischargeEvidence`) and
the catalogue's `bugs.jsonl` (`sensitive`, `sensitiveFor` — already exactly `classify()`'s own
output per row, which makes the `class:` mapping below the highest-confidence part of this import).

| Legacy ledger `state`             | bugflow `status:`             | Why |
| ---------------------------------- | ------------------------------ | --- |
| *(catalogue row, no ledger row)*   | `status:triage`                 | `bugs.mjs triage` already finds these as "invisible to everything" today; bugflow's `triage` state is the same idea, GitHub-native |
| `queued`, not sensitive             | `status:ready`                  | direct |
| `queued`, sensitive                 | `status:parked`                 | the carve-out; `class:money\|tenancy\|migration` comes straight from `sensitiveFor` |
| `in-flight`                         | `status:claimed`                | legacy doesn't split "claimed" from "actively being worked" as sharply as bugflow does; the next `bugflow sync` promotes to `in_progress` once it observes a branch/PR |
| `proven`                            | `status:verifying`              | **the mapping worth double-checking** — legacy `proven` = merged with a passing test, not yet post-deploy-confirmed; that is bugflow's `verifying`, not `done` |
| `proven-pending-deploy`             | `status:verifying`              | same target — the `tier:t2`-only pre-merge carve-out collapses into the same state; `bugflow verify` resolves it later |
| `done`                              | `status:done`                   | direct — stays `done` |
| `already-fixed`                     | `status:done` + `resolution:cannot-reproduce` | discovery classification: the defect no longer reproduces |
| `refuted`                           | `status:done` + `resolution:cannot-reproduce` | discovery classification: the suspected defect was never real. `VERIFY:` the legacy `state` field doesn't distinguish "never reproduced" from "behavior is correct as designed" — the latter arguably belongs under `resolution:wontfix` instead; that distinction lives only in each row's prose `evidence`, so a human pass over the diff (Step 3) should decide it per-row, not by a blanket rule |
| `regressed`                         | `status:regressed`              | direct — legacy already carries the identical evidence-citation contract `bugflow verify --result red` enforces |

### Field and body mapping

- **Title:** `[B###] <title>` — legacy ids stay visible (brief: "imported records keep `[B###]` in
  the title"); `proof.tokenFormat`'s legacy pattern (`REG-B{n}`) keeps matching these without a
  rename.
- **`## Files`:** from the record's `files:` front matter verbatim (already space-separated repo
  paths, e.g. `apps/api/src/orders/orders.service.ts apps/web/app/(dashboard)/orders/[id]/page.tsx`
  in the one sampled record) — no transformation needed.
- **`area:`** — derived from `files:` through `bugflow.config.json`'s `areas` glob map when `files:`
  is non-empty (the same derivation `triage` does for a new bug); when it's empty (many legacy rows
  never got an analysis pass and carry no `files:` at all — only the catalogue's prose `location`,
  e.g. `"Settings · mobile"`), the row imports as `area:unknown` rather than a low-confidence
  keyword guess — the nightly triage routine sweeps `area:unknown` bugs to a real area once files
  are known (see [templates/routine-triage.md](../templates/routine-triage.md)).
- **`source:`** — every sampled catalogue row carries `"source":"register-import"`, which doesn't fit
  any of bugflow's four values (`owner|monitor|customer|agent`) exactly. `VERIFY:` map to
  `source:owner` (the historical register was the owner's own record) as the least-wrong default,
  pending an owner ruling.
- **Body sections** — the record's own headings (`## What this feature is for`, `## Root cause`,
  `## User impact`, `## Fix approach and UX`, `## Test plan`, `## Reported evidence`) map to matching
  headings in the issue body; `## Summary` folds into `## Symptom`/`## Expected` (per
  [DATA-MODEL.md](DATA-MODEL.md)), not dropped. A section still reading "_Not yet analysed._"
  imports as empty rather than importing that placeholder text.
- **`pr` / `proof` / `evidence` / `dischargeEvidence`:** become one comment on the new issue at
  import time, verbatim, prefixed to mark it as an imported record (brief: `dischargeEvidence` → a
  comment) — `bugflow prove #<new-N> --pr <legacy pr>` re-establishes the `Closes #N` pointer against
  the new issue number using the same PR.
- **`roundSha` / `buildPlan`:** included in that same comment as supporting context; bugflow has no
  dedicated structured field for either. `VERIFY:` whether they need one, or prose-in-a-comment is
  sufficient.
- **F## batches** → parent issues of type `Batch`, each imported bug added as its sub-issue
  (`--set-parent`, the same primitive `bugflow plan` uses for a live attach). `VERIFY:` exact parent
  title convention — keeping the `F##` token visible (e.g. `"Batch F11 — run cancel/skip lifecycle"`)
  preserves continuity with every existing cross-reference to it.
- **History events** → each row of a record's own History section becomes one line appended to
  `snapshot/events.jsonl`, backdated to the event's own recorded timestamp rather than the import
  run's.

**Rollback:** `import` only adds GitHub objects; nothing in `.claude/campaign/` is touched. Undoing a
bad import means deleting the issues it created (`gh issue delete`, manual and deliberate — there is
no `bugflow unimport`) and re-running once fixed. `import` dedupes on the `[B###]` title prefix, so
re-running against a partially-imported state is safe — it skips ids already present rather than
double-filing.

## Step 3 — dual-run window

```bash
bugflow import --from .claude/campaign --dry-run --diff
```

Both systems stay live and read-only-compared for an owner-decided window (`VERIFY:` no duration is
specified here). Compare per-bug: mapped status, severity, tier, class/`sensitiveFor`, batch
membership — any disagreement is either a `bugflow import` bug (fix the mapping) or a legacy-data
anomaly (fix the source record) to resolve **before** Step 4, never after.

**The sharpest concrete risk in this whole migration:** the two systems' claim grammars do not
recognize each other. Legacy claims are an `<!--rf:agent-->`-marked comment matching
`^claim:\s*id=(\S+)\s+lease-until=(\S+)` (`team.mjs`'s `parseClaim`, read directly from its source);
bugflow's claim comment is `<!--bugflow:claim id=<login>/<host>/<worktree> exp=<ISO>-->` — a
different marker and a different body grammar entirely. Neither reader parses the other's comment.
**If both systems' *workers* ran live against the same issues at once, two workers could claim the
same bug simultaneously — one via `team.mjs claim`, one via `bugflow claim` — with neither lease
visible to the other's compare-and-swap.** The mitigation is structural, not procedural: throughout
Step 3, `bugflow claim`/`bugflow next` are **never invoked by a real worker** — only `import
--dry-run --diff` runs on the bugflow side. `scripts/campaign/bugs.mjs` and `scripts/team/team.mjs`
remain the sole *live* claim system until Step 4 actually flips the switch.

**Rollback:** nothing to roll back — this step, by construction, writes nothing anywhere.

## Step 4 — cutover

**Answering [GUARDRAILS.md](GUARDRAILS.md)'s (now-resolved) open question: bugflow's stop-hook
integration *follows* Gate 4, it does not supersede the hook itself.** Gate 4 (a non-blocking
`bugs.mjs sync` report, "Gate 4: bug-registry sync (reports, never blocks)") landed on `master` with
PR #597 (`10ddc3fa`, 2026-09-05) — `stop.mjs` carries Gates 1–4 today, confirmed by reading it
directly. Step 4 is where that already-existing Gate 4's call target flips from `bugs.mjs sync` to
`bugflow sync --quiet`; no new gate is added and none is removed, only what it shells out to changes.

| Legacy                                          | bugflow equivalent                         |
| ------------------------------------------------ | ------------------------------------------ |
| `node scripts/campaign-check.mjs` (CI gate)       | `bugflow check`                             |
| Gate 4 of `.claude/hooks/stop.mjs` (`bugs.mjs sync`) | `bugflow sync --quiet`                   |
| `team.mjs board`                                  | `bugflow board`                             |
| `team.mjs claim <issue#>`                         | `bugflow claim #<N>`                        |
| `team.mjs done <issue#> "[note]"`                 | `bugflow prove #<N> --pr <num>` (`sync` derives the rest) |
| `team.mjs release <issue#>`                       | `bugflow release #<N>`                      |
| `team.mjs reap`                                   | `bugflow reap`                              |
| `bugs.mjs next` / `waves`                         | `bugflow next` / `bugflow plan`             |
| `bugs.mjs brief`                                  | `bugflow brief`                             |
| `bugs.mjs file`                                   | `bugflow file`                              |
| `bugs.mjs prove` / `discharge`                    | `bugflow prove` + `bugflow verify --result green` |
| `bugs.mjs reopen`                                 | `bugflow verify --result red`               |
| `bugs.mjs render`                                 | `bugflow render`                            |
| `bugs.mjs self-test`                              | `bugflow self-test`                         |
| `team.mjs note` / `ask` / `answered`              | **no 1:1 verb yet** — `VERIFY`, closest today is a plain `gh issue comment` plus `needs:human` |
| `team.mjs setup` (label bootstrap)                | **no 1:1 verb yet** — `VERIFY`, see Step 1 |
| `bugs.mjs move` / `tier`                          | **no 1:1 verb yet** — `VERIFY`, today a direct `gh issue edit` (re-parent / relabel) |

`.claude/skills/bug-registry/SKILL.md` is rewritten as a thin pointer: strip the three-stores
explanation, the lock-directory mechanics, and the campaign-specific command reference; keep only
"bugs live in GitHub Issues; `bugflow brief #N` before starting; `bugflow next` to find work; see
`tools/bugflow/docs/` for everything else."

**Rollback:** cutover only changes which command a hook/CI-step/skill *calls*. `campaign-check.mjs`,
`bugs.mjs`, and `team.mjs` are not deleted until Step 5, so reverting Step 4 is reverting that one
call-site edit — nothing destructive yet.

## Step 5 — delete

- `.claude/campaign/status/*.jsonl` (every shard), `.claude/campaign/bugs.jsonl`,
  `.claude/campaign/board.json`.
- The shard/catalogue lockdir mechanism (`withShardLock`/`withCatalogueLock` and the two-lock-order
  race self-tests inside `bugs.mjs self-test`) — bugflow's claim CAS is GitHub-comment-based, so no
  local cross-machine lock is needed at all.
- `scripts/campaign/bugs.mjs`, `scripts/team/team.mjs`, `scripts/campaign-check.mjs` themselves.

**What's kept (as data or as ported code, not as the old files):**

- `classify()`'s regex patterns → `bugflow.config.json`'s `carveOut` key (the pattern data survives;
  the function and its file don't).
- The waves-colouring algorithm (connected components over shared non-hub files, greedy wave
  assignment, in-flight batches pre-coloured into wave 1) → ported into `bugflow plan`'s planning
  logic (see [PLANNING.md](PLANNING.md)).
- `scripts/campaign/normalize-evidence.mjs` and `scripts/campaign/reg-token.mjs` → ported
  near-verbatim into `tools/bugflow/src/` (both are already product-agnostic parsing utilities with
  no RouteFlow-specific import). **Port, verify test parity, then delete the old path** — never
  delete before the ported copy has its own passing tests.

**Rollback:** this is the one genuinely destructive step. Land it as its own commit/PR, separate from
Steps 2 and 4, only after Step 3's comparison window has run clean — a clean `git revert` of that one
commit is the rollback, and staying isolated is what keeps that revert clean.

## What NOT to delete

- `local-assets/docs/routeflow-bug-register.html` — stays as history. It's gitignored already, so
  "not deleting" means simply not touching it; it was never a shared/tracked artifact bugflow needs
  going forward.
- `.claude/campaign/bugs/*.md` (212 analysis records — real analyst time, not just data). The
  reversible default: **delete** once `bugflow import --dry-run --diff` reports zero diff against
  them — git history plus the Step 1 snapshot branch keep them recoverable, so deleting costs
  nothing a `git log`/`git show` can't undo. Archiving under `tools/bugflow/archive/` is the
  owner's opt-out if they want the prose readable without a git checkout, not the default.

## Risks and how each is checked

| Risk | Check |
| --- | --- |
| `bugflow import` silently mis-maps a legacy state | `--dry-run --diff` reviewed by a human (Step 3) before any real import; spot-check a sample per `state` value against the mapping table above |
| Dual-run split-brain (see Step 3) | Bugflow's claim path stays unexercised by any real worker throughout Step 3 — read-only comparison only |
| `REG-B###` (legacy) vs `REG-#N` (new) token continuity | `proof.tokenFormat` accepts both formats through the transition (config key, per the brief); `bugflow check` and `campaign-check.mjs` both run in CI until Step 4 confirms parity |
| Private-repo CI / merge-queue plan tier blocks cutover entirely | Resolve before Step 4 — the brief names this a stage-1 prerequisite; the Team/Enterprise merge-queue-on-private-repos question is still `VERIFY` |
| A worktree stash mixes up work mid-migration (several sessions touching `rf-registry` and `rf-bugflow` at once) | Never bare `git stash pop` with multiple worktrees live — `git stash list` first, always |
| A stale cached "green" masks a real parity failure between old and new | Project lesson L-034: force a fresh, uncached run of anything comparing legacy vs. new state; never trust a replayed CI summary for this specific comparison |
| Step 5 deletes something Step 2 silently failed to import | Land Step 5 as its own isolated commit, only after Step 3's window has run clean, never bundled with Step 2 or Step 4 |

## Open questions

- `VERIFY:` `source:owner` as the default mapping for legacy `"register-import"` rows (Step 2).
- `VERIFY:` parent-issue title convention for imported `F##` batches (Step 2).
- `VERIFY:` whether `roundSha`/`buildPlan` need a structured home beyond prose-in-a-comment (Step 2).
- `VERIFY:` `team.mjs note`/`ask`/`answered` and `bugs.mjs move`/`tier` equivalents (Step 4) — not
  decided here; today's answer is a direct `gh issue comment`/`gh issue edit`.
- `VERIFY:` dual-run window duration (Step 3) — left to the owner.

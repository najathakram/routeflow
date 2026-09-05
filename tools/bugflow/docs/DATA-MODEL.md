# Data model

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** bugflow implementers, anyone
writing a `bugflow.config.json` for a new repo, anyone auditing what a label or a snapshot row
means.

This is the GitHub-native schema bugflow reads and writes: the two issue types, the body template
a Bug issue's sections come from, the full label matrix (who writes each one, how many of each
kind an issue may carry), sub-issue and dependency rules, assignee semantics, the two snapshot
export formats, the id scheme, and how labels mirror onto Project fields. It supersedes nothing —
it is the GitHub-native replacement for the three stores described in
[MIGRATION.md](MIGRATION.md): `.claude/campaign/bugs/B###.md` (the record), `status/F##.jsonl`
(the ledger), and the GitHub board `team.mjs` already drove off PR/CI facts.

## Issue types

Two GitHub issue types (the first-class `type` field, GA August 2025 — distinct from labels):

| Type    | One per…                    | Created by                                   |
| ------- | ---------------------------- | --------------------------------------------- |
| `Bug`   | defect (`bugflow file`)      | a reporter, or an imported legacy `B###` record |
| `Batch` | group of bugs that share files and land in one PR (`bugflow plan`) | the planner, or promoted manually |

A `Bug`'s issue number **is** its id (`#N`). A `Batch` is a parent issue whose sub-issues are the
bugs currently attached to it (see [Sub-issues and parents](#sub-issues-and-parents)). Batches do
not nest — there is no epic level above a Batch in this model (unlike `team.mjs`'s older
`epic`/`task` pair, which was for feature work, not bugs).

## The issue body template

A Bug issue's body is the six sections the current `B###.md` record carries (`SECTIONS` in
`bugs.mjs`: Summary, What this feature is for, Root cause, User impact, Fix approach and UX, Test
plan), split across **filing time** and **triage time** so a reporter is never asked to analyse
their own report:

```markdown
## Symptom

<what is observably wrong — the reporter's own words>

## Expected

<what should happen instead>

## Repro

<steps, or "intermittent — see linked evidence">

## Files

- apps/api/src/orders/orders.service.ts
- apps/api/src/routes/routes.service.ts

## Analysis

### Purpose

_Not yet analysed._

### Root cause

_Not yet analysed._

### Impact

_Not yet analysed._

### Fix approach & UX

_Not yet analysed._

### Test plan

_Not yet analysed._
```

Symptom/Expected/Repro/Files are filled at filing time (`bugflow file`, or the issue form —
[templates/ISSUE_TEMPLATE.bug.yml](../templates/ISSUE_TEMPLATE.bug.yml)) and map onto
`B###.md`'s one-line title + `location` + the register's "Reported evidence" block. The five
Analysis subsections are the direct carry-over of `B###.md`'s remaining five narrative sections
(Summary folds into Symptom/Expected at this scale) and are filled by `bugflow triage`, exactly
the way `bugs.mjs`'s `cmds.expand` seeds every section with the literal placeholder
`_Not yet analysed._` and a later analysis pass replaces it section-by-section
(`note --section "<name>"`). A Bug whose Analysis is still all placeholders is what `triage`
means by "not yet triaged" — mirrored by the absence of `class`/`tier`/`severity`/`area` labels.

**Files** is a plain bullet list of repo-relative paths — the one departure from `B###.md`'s
front matter, which stores the same information as a single space-separated string
(`files: apps/api/... apps/api/...`). A list is what a GitHub issue form naturally produces; both
`bugflow plan` (batching) and `bugflow triage` (area/class inference) parse it as one path per
line, whether or not that line starts with a `- ` bullet marker — a compliant reporter always uses
the bullet, but the parser accepts a bare path line too rather than dropping it.

**Heading-level note.** A GitHub issue form (`templates/ISSUE_TEMPLATE.bug.yml`) renders each
field as an `### <label>` (H3) heading followed by the response, not the `##` (H2) shown above —
that's a platform rendering rule, not this template's choice. Every parser that reads a Bug
issue's body (`triage`, `plan`, `check`) should match `##?#? Symptom` etc. — accept either heading
level — rather than assume H2 everywhere; the alternative (a bot that rewrites a freshly-submitted
form's H3s to H2 on `issues: opened`) is extra moving parts for no real benefit once the parser
just accepts both.

## Label matrix

Namespaced, **exactly one label per namespace** except where noted. "Writer" is the only thing
allowed to add or remove that label — never hand-edit a status label, per
[LIFECYCLE.md](LIFECYCLE.md)'s derive-from-facts rule.

| Namespace     | Values                                                          | Cardinality | Writer                                   |
| ------------- | ---------------------------------------------------------------- | ----------- | ----------------------------------------- |
| `status:`     | `triage \| ready \| claimed \| in_progress \| in_review \| verifying \| done \| blocked \| parked \| regressed` | exactly 1 | `bugflow sync` / the command that caused the transition — never hand-set (see [LIFECYCLE.md](LIFECYCLE.md)) |
| `class:`      | `agent-safe \| money \| tenancy \| migration`                     | **see below** | `bugflow triage` (ports `classify()`) |
| `tier:`       | `t1` (Jest) `\| t2` (Playwright, deployed build) `\| t3` (manual build-plan row) | exactly 1 | `bugflow triage` |
| `severity:`   | `critical \| high \| medium \| low`                               | exactly 1   | `bugflow file` (reporter's claim), reconciled by `bugflow triage` |
| `area:`       | config-driven from path globs (`api`, `web`, `mobile`, `orders`, `finance`, `platform`, …), plus the reserved fallback `unknown` (no glob maps to it) | exactly 1 — the bug's primary surface | `bugflow file` / `triage`, computed from `--files` against `bugflow.config.json`'s `areas` map; `unknown` when `## Files` is empty, swept to a real area by the nightly triage routine |
| `wave:N`      | an integer                                                        | exactly 1 (absent until planned) | `bugflow plan` only |
| `harness:`    | `ralph \| full`                                                   | exactly 1   | computed by `bugflow triage` once class/tier/files are known (rule in [HARNESS.md](HARNESS.md)) |
| `source:`     | `owner \| monitor \| customer \| agent`                           | exactly 1   | set at filing time, `bugflow file --source <s>` |
| `approved:owner` | marker                                                          | 0 or 1      | **the owner only**, by hand — the one label a human sets deliberately |
| `needs:human`    | marker                                                          | 0 or 1      | `release` (harness cap-out) · `sync` (a claim/PR anomaly it cannot resolve on its own — two qualifying open PRs, an assignee/lease mismatch, or a housekeeping Witness finding) |
| `resolution:` | `wontfix \| duplicate \| cannot-reproduce`                        | 0 or 1 — always paired with `status:done` (closed-not-planned is still `status:done`; there is no status-less close) | whoever closes it not-planned (owner, or `triage` on an evidence-backed already-fixed/refuted finding) |

**`class:` cardinality is decided:** 1 `agent-safe`, **or** 1–3 carve-out classes together; never
both at once. `classify()` in `bugs.mjs` tests title+location against three *independent* regexes
and returns every match — a bug touching `billing.ts` inside `forTenant()` legitimately trips both
`money` and `tenancy` at once (`bug.sensitiveFor` is stored as a joined list, not a single value).
bugflow carries that behavior forward — **a Bug may carry more than one carve-out `class:` label**,
and `parked` triggers on the presence of *any* non-`agent-safe` one; collapsing to a single "worst"
category was considered and rejected as an unauthorized redesign.

Legacy imported bugs keep `[B###]` in the issue title (e.g. `[B129] Cancelling a run strands its
orders…`); everything else about them — labels, body, sub-issue links — is identical to a bug
filed straight into bugflow.

## Sub-issues and parents

A Bug has **at most one parent** at a time (`gh issue edit --set-parent` / `--remove-parent`) — a
Batch issue. A Batch's sub-issues are exactly its currently-attached bugs; attaching and detaching
is how [PLANNING.md](PLANNING.md)'s attach-or-wave phase works, and how a bug moves between
batches (there is no standalone "move" verb the way `bugs.mjs move` was one — re-parenting *is*
the move).

A Batch issue **does** carry its own point-in-time `status:` label — derived, like every other
`status:` value, and written by `sync` alone. The precedent is `bugs.mjs status`, which reports a
`done/total` fraction per batch rather than collapsing it to one state; here that becomes a single
coarse label instead: `in_progress` once any child is, `in_review` once every open child is
`in_review`+, and so on — purely for the "Now" view (detail in [DASHBOARD.md](DASHBOARD.md)). The
per-bug labels remain the ground truth for every dashboard filter or gate that needs precision;
the Batch's own label is a convenience derived from them, never authored separately.

## Dependency rules

Cross-bug ordering uses GitHub's native issue dependencies (`--blocked-by` / `--blocking`, `gh` ≥
2.94.0) — independent of the parent/sub-issue relationship above; a bug can be blocked by a bug in
an entirely different batch. A Bug with any **open** blocked-by relationship cannot carry
`status:ready` (see the Takeable predicate, [LIFECYCLE.md](LIFECYCLE.md)); it routes to
`status:blocked` instead, and returns to `ready` (subject to re-triage) only once every blocker is
closed.

## Assignee semantics

The assignee field is set (`--add-assignee <login>`) on a **won** claim, exactly as `team.mjs` does
today — a **human-readable mirror**, never the source of truth. The lease comment
([CLAIMS-AND-LEASES.md](CLAIMS-AND-LEASES.md)) is what a compare-and-swap actually reads; the
assignee field cannot disambiguate two bugflow identities that happen to authenticate as the same
GitHub account (the exact failure mode `team.mjs`'s own header comment names — `@me` "carries no
information about which session holds a claim"). Never branch dispatcher logic on `assignee`
alone.

## The ID scheme

- **New bugs:** the GitHub issue number, referenced as `#N`. There is no separate catalogue id —
  the issue *is* the row.
- **Legacy bugs:** keep `[B###]` verbatim in the title on import, so a human scanning the issue
  list can still cross-reference the old register.
- **Proof tokens:** `scripts/campaign/reg-token.mjs`'s `REG_TOKEN_RE` grammar (shared by `bugs.mjs`
  and `campaign-check.mjs`) carries forward almost exactly. A new bug's test names cite `REG-#N`
  (`proof.tokenFormat`: `REG-#{n}`); an imported legacy bug's tests keep citing `REG-B{n}`
  (`REG-B129`, unchanged) rather than forcing a rename of every existing regression test. `bugflow
  check` (the CI proof gate, [LIFECYCLE.md](LIFECYCLE.md)) accepts either grammar, matched as an
  **exact** token — `REG-#12` must never be satisfied by `REG-#120`, the same digit-boundary bug
  `reg-token.mjs`'s `REG_TOKEN_RE` was written to close (`(?![0-9])` after the digit run).

## Project fields mirrored from labels

`bugflow sync` mirrors every namespaced label onto a Projects v2 field of the matching name so the
board is filterable/groupable without re-deriving anything (full view design in
[DASHBOARD.md](DASHBOARD.md)):

| Label namespace | Project field      | Field type      |
| ---------------- | ------------------ | ---------------- |
| `status:`         | Status (built-in)  | single-select     |
| `wave:N`          | Wave                | number            |
| `class:`          | Class               | multi-select (1 `agent-safe`, or 1–3 carve-out classes) |
| `tier:`           | Tier                | single-select     |
| `severity:`       | Severity            | single-select     |
| `area:`           | Area                | single-select     |
| `harness:`        | Harness             | single-select     |
| assignee          | Claimed by          | (built-in, people) |
| the live lease's `exp=` | Lease expiry  | date              |
| parent Batch      | Batch               | (built-in, parent issue) |

## Snapshot formats

`bugflow snapshot` exports the current state to branch `claude/bugflow-snapshot` (config
`snapshot.branch`) — an offline, greppable, diffable mirror of the board, the same reason
`bugs.jsonl` exists: nothing here is a live agent's only way to read the registry.

### `snapshot/issues.jsonl` — one row per issue, replaced wholesale each run

Mirrors `bugs.jsonl`'s catalogue row, adapted to GitHub-native fields:

```json
{
  "issue": 742,
  "type": "Bug",
  "title": "Order search ignores the status filter after a customer merge",
  "legacyId": null,
  "parent": 201,
  "status": "in_progress",
  "class": ["agent-safe"],
  "tier": "t1",
  "severity": "high",
  "area": "orders",
  "wave": 1,
  "harness": "ralph",
  "source": "customer",
  "assignee": "alice",
  "blockedBy": [],
  "files": ["apps/api/src/orders/orders.service.ts"],
  "createdAt": "2026-09-04T12:00:00Z",
  "updatedAt": "2026-09-04T15:30:00Z",
  "closedAt": null
}
```

### `snapshot/events.jsonl` — append-only, never rewritten

One row per state transition, the flat equivalent of `B###.md`'s per-bug History log
(`appendHistory`/`appendEvent`) — a transition instead of a markdown bullet, so it can be
`grep`/`jq`'d across every bug instead of opened one file at a time:

```json
{ "ts": "2026-09-04T15:30:00Z", "issue": 742, "from": "in_review", "to": "verifying", "by": "bugflow-sync", "cause": "pr-merged+check-green", "evidence": "PR #900 merged; REG-742 passing in CI run 33715496781" }
```

`cause` names *why* `sync` derived the transition (`pr-merged+check-green`, `lease-expired`,
`deploy-green`, `deploy-red`, `blockers-closed`, `owner-approved`); `evidence` is the citation —
never empty for a transition into `verifying`, `done`, or `regressed`, the same discipline
`bugs.mjs`'s `prove`/`discharge`/`reopen` enforce today (a state that asserts something must name
what proves it).

### `snapshot/meta.json` — the high-water mark, replaced wholesale each run

The last GitHub issue-timeline event `snapshot` has already turned into an `events.jsonl` row —
what makes a repeated `snapshot` run over unchanged state append nothing, the same idempotency
`sync` itself relies on:

```json
{ "lastEventId": 987654321, "lastEventAt": "2026-09-04T15:30:00Z" }
```

Each run reads every open/recently-closed issue's `status:*` labeled/unlabeled timeline events
newer than this mark, appends one `events.jsonl` row per event found, then advances the mark to
the newest event it saw.

## Worked example

A freshly triaged, agent-safe bug, ready to claim:

**Issue #742 — `Order search ignores the status filter after a customer merge`**
Labels: `status:ready` `class:agent-safe` `tier:t1` `severity:high` `area:orders` `harness:ralph`
`source:customer`. No parent yet (not batched — see [PLANNING.md](PLANNING.md) for how `plan`
either attaches it to an in-flight batch or gives it a fresh one).

```markdown
## Symptom

Searching a merged customer's orders by status=PENDING returns orders from every status once
two customer records have been merged into one.

## Expected

The status filter should apply after the merge exactly as it does before one.

## Repro

1. Merge customer A (3 pending orders) into customer B (2 delivered orders).
2. GET /orders?customerId=<B>&status=PENDING on the merged customer.
3. Observe: all 5 orders returned, not 3.

## Files

- apps/api/src/orders/orders.service.ts
- apps/api/src/orders/orders.controller.ts

## Analysis

### Purpose

The status filter lets an operator find, e.g., every order still awaiting delivery for one
customer — load-bearing for daily dispatch triage.

### Root cause

`findOrdersForCustomer` builds its `where` clause before the merge-aware customer-id resolution
runs, so the resolved id list bypasses the `status` predicate that was attached to the original
(pre-resolution) query object.

### Impact

Every tenant that has ever used "merge duplicate customer" and then filters that customer's
orders by status. Silent — no error, just a wrong result set.

### Fix approach & UX

Apply `status` after id resolution, not before; no UX change (the filter is expected to behave
exactly like this already).

### Test plan

Tier `t1`. `REG-742`: a merged customer's status-filtered order query returns only orders matching
`status`, pre- and post-merge.
```

## Open questions

- **Two PRs both citing `Closes #N`** for one bug — `sync` prefers the earliest-opened non-draft
  PR and comments listing both, adding `needs:human` (see [LIFECYCLE.md](LIFECYCLE.md)'s
  invariants section).
- **Does the issue-form YAML schema support defaulting the `type` field** (Bug), or only
  `labels:`? See [templates/ISSUE_TEMPLATE.bug.yml](../templates/ISSUE_TEMPLATE.bug.yml)'s own
  header note. **VERIFY** against current GitHub docs at adoption time.

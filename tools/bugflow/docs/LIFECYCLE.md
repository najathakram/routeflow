# Lifecycle

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** bugflow implementers (`sync`,
`verify`, `check`), anyone debugging why an issue's status label isn't what they expected.

The state machine every Bug issue's `status:` label moves through, what `bugflow sync` checks and
in what order, the invariants a correct `sync` never violates, and how `campaign-check.mjs`'s
`proven` ≠ `done` distinction — the one mechanical control the current registry has — maps onto
this model. Read [DATA-MODEL.md](DATA-MODEL.md) first for what a label/field actually is.

## The one rule everything else follows

**Status is derived from facts, never authored.** `team.mjs`'s own header comment states the
precedent this ports directly: board position is "DERIVED from real PR + CI + review facts, never
authored. A lane you have to remember to set is a lane that will be wrong." `sync` is the only
writer of any `status:` label (claim/release/reap write it too, but only as a consequence of the
same fact-checking `sync` runs — see [CLAIMS-AND-LEASES.md](CLAIMS-AND-LEASES.md)). A human or an
agent hand-setting a status label is always a bug in the tooling, never a legitimate workaround.

## State table

| From         | To           | Trigger                                                              | Who/what writes it | Evidence required | Evidence recorded by |
| ------------ | ------------ | --------------------------------------------------------------------- | ------------------- | ------------------ | ---------------------- |
| `triage`     | `ready`      | class/tier/severity/area/files set; class is `agent-safe`; no open blocked-by | `bugflow triage`  | the fields themselves | — |
| `triage`     | `parked`     | class includes `money`/`tenancy`/`migration`                          | `bugflow triage`   | the `class:` label | — |
| `triage`     | `blocked`    | class is safe, but an open blocked-by exists                          | `bugflow triage` / `sync` | the blocked-by list | — |
| `ready`      | `claimed`    | claim CAS won                                                          | `bugflow claim`    | the winning lease comment | — |
| `claimed`    | `in_progress`| `bugflow start` records a branch/worktree                             | `bugflow start`    | the branch/worktree name posted | — |
| `claimed`/`in_progress` | `ready` | release, or lease expiry caught by `reap`                        | `bugflow release` / `bugflow reap` | a release comment, or an expired `exp=` | — |
| `in_progress`| `in_review`  | an open PR's body contains `Closes #N`                                | `bugflow sync`     | PR number + body match | — |
| `in_review`  | `ready`      | that PR closed unmerged                                               | `bugflow sync`     | PR state | — |
| `in_review`  | `verifying`  | PR **merged** and the tier's proof is present (passing, for `tier:t1` only) | `bugflow sync` | PR # + the tier's proof | `bugflow prove` (proof comment) + `bugflow check` (the pre-merge gate) |
| `verifying`  | `done`       | deploy SUCCESS + green post-deploy check                              | `bugflow sync`     | deployment id + check result | `bugflow verify --result green` (or `--manual`, `tier:t3` only) |
| `verifying`  | `regressed`  | post-deploy check or E2E red on that same `REG-#N`                    | `bugflow sync`     | the failing token/run | `bugflow verify --result red` |
| `regressed`  | `ready`      | reopened and re-triaged (severity bump)                               | owner / monitor, via `gh issue reopen` + `sync` | the regression citation + new severity | — |
| `parked`     | `ready` (+ `harness:full`) | `approved:owner` label present                           | `sync` (detects the label) | the label itself | — |
| `blocked`    | `ready`      | every blocker closed                                                   | `sync`             | the (now-empty) blocked-by list | — |
| `done`       | `regressed`  | a later `REG-#N` failure against a subsequent deploy                  | `bugflow sync`     | the failing token/run | `bugflow verify --result red`, run against a closed issue |

Every transition's `status:` write comes from `bugflow sync` alone — `prove`, `check`, and
`verify` never write a status label themselves; each only leaves the evidence `sync` reads on its
next pass. This is the direct port of `bugs.mjs`'s own split: `prove` *declares* "here is my
passing `REG-B###` test" the same way `bugflow prove`'s proof comment does; `campaign-check.mjs`
is what actually re-reads the test-report artifact and refuses to believe a claim it can't verify,
exactly like `bugflow check`. Neither side may invent the other's evidence, and neither writes the
status label its evidence eventually causes `sync` to derive.

## As a diagram

```
                     ┌─────────┐
                     │ triage  │
                     └────┬────┘
        ┌───class safe,───┼───class money/tenancy/migration──┐
        │  no blocker      │                                    │
        ▼                  │                                    ▼
   blocked ◄────has────┐   │                              ┌─► parked
     │  blocker cleared │   │ has open blocker             │     │ approved:owner
     └──────────────────┘   ▼                              │     │
                        ┌────────┐                          └─────┘
                 ┌─────►│ ready  │◄───────────────────────────────┐
                 │      └───┬────┘                                 │
     release/reap│          │ claim CAS won                        │
                 │          ▼                                      │
                 │      ┌─────────┐                                 │
                 └──────┤ claimed │                                 │
                        └───┬─────┘                                 │
                            │ bugflow start                         │
                            ▼                                       │
                       ┌───────────┐                                │
                       │in_progress│                                │
                       └─────┬─────┘                                │
                             │ PR opened, Closes #N                 │
                             ▼                                      │
                       ┌───────────┐   PR closed unmerged           │
                       │ in_review │───────────────────────────────┘
                       └─────┬─────┘
                             │ PR merged + REG-#N passing (prove + check)
                             ▼
                       ┌───────────┐  post-deploy/E2E red on REG-#N
                       │ verifying │───────────────────┐
                       └─────┬─────┘                    │
                             │ deploy SUCCESS + green    │
                             ▼                           ▼
                        ┌────────┐  later REG-#N fail ┌───────────┐
                        │  done  │───────────────────►│ regressed │
                        └────────┘                     └─────┬─────┘
                                                               │ reopened + re-triaged
                                                               ▼
                                                           (back to ready)
```

## The Takeable predicate

The only thing a worker (human or fleet seat) may claim:

```
Takeable(issue) =
      status == "ready"
  AND assignee == none
  AND blocked_by == []            -- defensive re-check, not just "status != blocked"
  AND NOT (any class label present without approved:owner)   -- defensive re-check of parked, too
  AND class ⊆ seat.allowedClasses  -- fleet seats: agent-safe only
  AND needs:human NOT present      -- cleared only by a human, directly or by re-triaging to harness:full
```

The two "defensive re-check" clauses look redundant with `status == "ready"` (an issue can't
simultaneously carry `status:blocked` or `status:parked`) — they are there anyway, on purpose. A
worker's own takeable check should never trust a single label in isolation; it should be able to
answer "is this really safe to start" even if `sync` is mid-run, stale, or a manual label edit
briefly left the two out of step. This mirrors a real, fixed bug in `bugs.mjs`'s own predecessor:
"parking used to `continue` before the busy tests ran… every hard conflict it carried was dropped
from the colouring" — the fix there was the same shape, checking the underlying fact again rather
than trusting one flag.

## What `sync` checks, in order

1. Pull live facts for every open Bug/Batch issue: labels, assignee, linked PRs and their
   state/CI/merge status (`gh pr list --json … | Closes #N` scan, exactly `team.mjs`'s `prIndex`),
   deploy/deployment-status for any issue in `verifying`.
2. `in_progress` issues: does an open PR closing this issue exist? → `in_review`. **More than one**
   open qualifying PR ⇒ prefer the earliest-opened non-draft one, comment listing every candidate,
   and add `needs:human` rather than guessing.
3. `in_review` issues: is that PR merged? Run `bugflow check` (the `REG-#N` proof gate: present per
   tier, passing required only for `tier:t1`) → merged + the tier's proof present ⇒ `verifying`. PR
   closed unmerged ⇒ `ready`. Otherwise unchanged (CI-failing/pending surfaces only in the
   dashboard's labels/views, never as a distinct `status:` value).
4. `verifying` issues: is there a deployment covering the merge commit? SUCCESS + a green
   post-deploy check citing `REG-#N` (or a `bugflow verify --manual` record, `tier:t3`) ⇒ `done`
   (close the issue, reason completed, severity unchanged). A red post-deploy check or a failing
   `REG-#N` in the next E2E run ⇒ `regressed` (reopen if closed, severity bumped one rank —
   `critical` stays `critical`).
5. `triage` issues: (re-)compute `class`/`tier`/`severity`/`area`/`harness` from
   title+`## Files` against `bugflow.config.json`; route per the precedence rule below.
6. `parked` issues: `approved:owner` present? ⇒ `ready` + `harness:full`.
7. `blocked` issues: every blocker closed? ⇒ `ready`.
8. `claimed`/`in_progress` issues: lease still live (per
   [CLAIMS-AND-LEASES.md](CLAIMS-AND-LEASES.md))? If expired and un-heartbeated, `reap` releases
   it ⇒ `ready`.
9. Every open issue: an **assignee with no matching live lease comment** is an anomaly, not a fact
   to trust — on a `ready` bug, remove the stray assignee and comment; on a `parked` bug, comment
   and add `needs:human` rather than letting it sit invisibly assigned.
10. Mirror every derived label onto the linked Projects v2 item's fields.
11. Idempotent: a second `sync` run with no new facts changes nothing. This is checkable — the
    whole point of deriving from facts is that re-running produces the same answer, the same
    property `bugs.mjs next`/`waves` are built to guarantee ("the answer must be stable between
    runs").

**Triage precedence (parked vs. blocked):** when a bug is *both* carve-out-sensitive and has an
open blocker, `parked` wins — `parked` requires an explicit owner action (`approved:owner`)
regardless of blockers, so it is the more restrictive state and should be visible as such. Once
approved, `sync` re-evaluates blocked-by on the next pass (step 7 above) — an approved-but-still-
blocked bug lands in `blocked`, not `ready`, since the Takeable predicate requires an empty
blocker list unconditionally.

## Invariants

- **Exactly one `status:` label at all times.** `sync` always replaces the whole `status:*` set
  with exactly one value; never additive.
- **`done` only after a deploy.** Never on merge alone — this is `campaign-check.mjs`'s
  `proven`/`done` split, ported whole (see below). A passing `bugflow check` only lets `prove`'s
  evidence carry a bug to `verifying`, via `sync`.
- **An `in_review` bug has exactly one linked PR.** Two open PRs both citing `Closes #N` is
  unhandled by the source design (batches were one-PR-per-batch by construction in the old
  system); `sync` prefers the **earliest-opened non-draft** PR, comments listing both candidates,
  and labels `needs:human` on any bug with more than one open qualifying PR, rather than guessing.
- **A `regressed` bug gets a severity bump.** One rank up (`high`→`critical`, `medium`→`high`, …),
  never a downgrade — `critical` stays `critical` — on the reasoning that a bug proven wrong in
  production is evidence of higher real impact than the original estimate. One step: the reopen
  and the severity bump are both written by `bugflow sync`, reading the `bugflow verify --result
  red` citation.
- **Never invent an intermediate CI-state status.** "CI failing", "review requested", etc. are
  **not** `status:` values — they are visible via the PR's own checks in the "Now" dashboard view
  ([DASHBOARD.md](DASHBOARD.md)), exactly as `team.mjs`'s board lanes (`CI failing`, `Review
  comments`) are a presentation-layer derivation, never a value stored back onto the issue.

## `proven` ≠ `done`: mapping the old ledger states onto this one

`campaign-check.mjs` is the one mechanical control the current registry has, and its five
claim-bearing states map cleanly onto this state machine:

| `campaign-check.mjs` state | What it asserts | bugflow equivalent |
| --------------------------- | ----------------- | -------------------- |
| `proven`                    | merged, with a passing `REG-B###` test | `in_review` → `verifying` (evidence from `prove` + `check`; `sync` writes the label) |
| `proven-pending-deploy`     | a `tier:t2` (Playwright) row that can't be proven pre-merge | folded into `verifying` — bugflow has **no separate pending-deploy status**; tier (`t2`) plus which check `bugflow verify` runs distinguishes it, since every tier now waits in the same `verifying` bucket for its post-deploy proof |
| `done`                      | post-deploy; **every** tier, including `t2`, now shows a passing test | `done` |
| `already-fixed` / `refuted` | a discovery-time finding, evidence-only, no test search required | `status:done` + `resolution:wontfix`/`duplicate`/`cannot-reproduce` + an evidence comment — **never enters `ready`/`claimed`/etc. at all** |
| `regressed`                 | a closed claim that came back; evidence-only, no test search | `regressed`, direct match |

The `proven-pending-deploy` fold is a genuine simplification, not a gap: the old system needed the
extra state because it tracked tier-specific proof mechanics in a flat ledger row; a GitHub Issue
can just sit in `verifying` for every tier and let `tier:t2` (a label already on the issue) tell
`bugflow verify` which check to run once a deploy lands.

**Recommended, not yet in the brief:** port `campaign-check.mjs`'s hardest rule for the
evidence-only states — `already-fixed`/`refuted`/`regressed` must all cite a **non-empty**
evidence field, checked mechanically, never trusted as a comment nobody reads. `bugflow check`
should refuse a `resolution:*` close or a `regressed` label with no evidence citation in the
closing comment, the same way `campaign-check.mjs` fails a ledger row with an empty `evidence`
field today.

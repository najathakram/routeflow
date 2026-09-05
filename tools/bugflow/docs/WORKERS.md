# Workers

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** whoever configures a machine or a
cloud Routine to run bugflow, and anyone reviewing a bugflow-authored PR

This is the map from a bugflow job to the Claude Code surface that runs it, why that surface and not
another, who each surface acts as on GitHub, how much throughput it buys, what the hard caps are and
why, what happens when a machine sleeps, the exact step sequence of one worker invocation, and a
checklist for anything that generates a worker prompt. It does not cover the harness those steps run
inside (see [HARNESS.md](HARNESS.md)) or the claim/lease mechanics themselves (see
[CLAIMS-AND-LEASES.md](CLAIMS-AND-LEASES.md)).

## The three surfaces

Bugflow runs on Claude Code subscription seats only — no Claude API, no Agent SDK, no
GitHub-Actions-hosted agent (see [GUARDRAILS.md](GUARDRAILS.md) for why that boundary matters: no
separate billing surface, no separate credential to leak, no infrastructure to run). Three surfaces,
in increasing order of "someone has to be watching":

| Surface | Where it runs | Permission prompts | Trigger | Identity |
|---|---|---|---|---|
| **Desktop scheduled task** | The developer's own machine, inside the Claude Code app | Whatever mode the task was configured with (can be zero) | Schedule (minimum 1 minute) or manual | The developer's own logged-in account |
| **Cloud Routine** | Anthropic-managed cloud, research preview | None, ever | Schedule (minimum 1 hour), an API `fire` with a bearer token, or a GitHub Pull-request/Release event (not Issues) | The account that created the Routine |
| **`/loop` + `/goal`** | Inside a running interactive session | Whatever the session already has | Session-scoped, ≤ 50 tasks, 7-day expiry (`/loop`); a condition a Haiku evaluator judges (`/goal`) | Whoever is running the session |

A Desktop task fires only while the Claude Code app is open and the machine is awake; it makes one
catch-up run for anything it missed on wake, and skips a tick outright if the previous run is still
going. A cloud Routine has no such dependency — it runs on Anthropic's infrastructure whether or not
any machine is on — but pays for that with a 1-hour scheduling floor and a cold `git clone` of the
default branch every run (the environment-setup script is cached; the checkout is not). `/loop` and
`/goal` live inside a session a human is or recently was driving, so they fit tending a run someone
already started, not unattended background capacity.

## Job → surface

| Job | Surface | Cadence | Why |
|---|---|---|---|
| Developer's own fix loop | Desktop scheduled task, **worktree toggle ON** | Every 30 min | Runs beside the developer's interactive work on the same machine; the isolated worktree keeps it off whatever branch the developer has checked out; 30 min is comfortably longer than one run (≤ 45 min, see caps below), so a tick never queues up behind the last one |
| Housekeeping (`reap`, `sync`, `snapshot`) | Cloud Routine | Hourly | Nothing here needs a working tree or a human's machine — it is API calls against GitHub. Hourly bounds a stale lease to at most ~30 min past its 90-min expiry before the next `reap` catches it, and keeps one account's daily Routine-run budget cheap |
| Triage (assign class/tier/severity/area, apply the carve-out) | Cloud Routine | Nightly | New bugs are not claim-latency-sensitive the way a lease is; batching the pass overnight matches the existing per-batch (not per-bug) analysis convention, and keeps the Routine's daily run count low |
| Deploy verification (`verifying` → `done` / `regressed`) | Not a separate surface — `sync` reading GitHub deployment + check-run facts | Piggybacks on the housekeeping tick | There is no new trigger to build: the deploy and its check runs are already GitHub facts a scheduled `sync` can read, the same design as `campaign-check.mjs` — which only ever trusts a run artifact, never a status someone typed |
| Fleet capacity | **Either** a dedicated Team seat's Desktop task at 5-min cadence on a machine that never sleeps, **or** a cloud Routine accepting the 1-hour floor and the cold-clone cost | 5 min (Desktop) / 1 hour (Routine) | Desktop buys much tighter cadence and a warm tree at the cost of real hardware to keep awake; Routine buys zero hardware at the cost of an hourly ceiling and a cold clone every run — pick per how much the always-on machine actually costs to run |

## Identity

There is no bugflow-specific service account anywhere in this — every surface authenticates as
whatever GitHub login the underlying Claude Code account carries.

- A **developer's Desktop task** acts as that developer's own GitHub login — the same one they use
  interactively. Its commits, PRs and claim leases are indistinguishable from that person's own manual
  work, which is exactly why claim identity is `login/host/worktree` and not `login` alone: the same
  developer running the task on two machines, or in two worktrees on one machine, is two different
  claimants under this scheme, not one.
- A **cloud Routine** acts as whichever account created it. Routines are not shared with teammates,
  cannot be handed to a co-worker, draw down that one account's own subscription usage, and are bound
  by that account's own per-day run cap.
- A **fleet seat** is its own dedicated GitHub **machine-user account, owned by the org**, with
  write access to the repo and its own Claude Code Team seat — not a real developer's personal
  login pressed into unattended service, and not a shared inbox. Two reasons: its automated
  commits stay attributable to "the fleet," not to a person who didn't write them; and its
  subscription usage stops competing with that person's own interactive work, which is the entire
  point of "dedicated" capacity. It can never approve a PR, including its own, and is excluded from
  CODEOWNERS by design (see [GUARDRAILS.md](GUARDRAILS.md)). `VERIFY:` GitHub's terms of service on
  machine-user accounts specifically — separate from whether the Claude Code plan supports the
  seat itself, which it does.

## Capacity

`throughput ≈ fleet seats × runs/day × first-pass success rate`

Every factor on the right is either a config knob (`seats.<login>.dailyClaimCap`, the schedule
interval) or a measured quantity only the cost ledger can supply — never guess it, per the pipeline
law's ten-run rule (see [HARNESS.md](HARNESS.md)).

**Worked example (illustrative numbers only — replace every one with the ledger's real figures once
Stage 1 has ten fleet runs; see Open questions):**

- 1 fleet seat, Desktop task, always-on machine, 5-min schedule. The schedule alone would allow 288
  ticks/day, but a run occupies the seat for up to 45 min and the next tick is skipped while one is
  in progress, so the real ceiling is wall-clock-bound: at an illustrative 30-min average run,
  ⌊24 × 60 / 30⌋ = 48 possible runs/day *if* work never runs out.
- Suppose the owner sets that seat's `dailyClaimCap` to 12 (illustrative for this worked example
  only, not a recommendation — the shipped default is 6) — that becomes the binding ceiling before
  the wall-clock one does.
- Suppose first-pass success (PR opens, gate stays green, no escalation) runs at an illustrative 50%:
  `1 × 12 × 0.5 = 6` shipped fixes/day from the fleet seat alone.
- Add 3 developer seats running the same worker opportunistically (their Desktop task competes with
  each developer's own interactive usage, so this is bycatch, not guaranteed capacity) — say 1–2 extra
  runs/day each at the same illustrative rate, +1.5–3 fixes/day, unpredictable day to day.
- Order-of-magnitude total: **6–9 shipped agent-safe fixes/day** across 3 devs + 1 fleet seat, with
  the fleet seat's guaranteed cadence supplying most of it.

## Caps, and why each exists

Subscription usage is finite and shared with the human's own interactive work on that same seat —
every cap below exists to stop an unattended loop from spending someone else's budget invisibly.

| Cap | Value | Why |
|---|---|---|
| Batches per run | 1 | Keeps one invocation's cost bounded and keeps the batch-scoped claim/lease model meaningful — a worker holding three leases against one wall-clock budget is exactly the failure this prevents |
| Ralph iterations | ≤ 8 | An unattended loop with no permission prompts has no other backstop against grinding on a wrong fix forever; capping it forces escalation to a human instead of silent spend |
| `dailyClaimCap` | per seat, owner-set | Stops one fast seat (especially a fleet seat) from claiming every ready bug before anyone else's worker gets a turn, and bounds that account's daily draw on the shared subscription pool |
| Wall-clock | 45 min max | Bounds a single run's cost and keeps the next scheduled tick from queuing up behind a hung one (a Desktop task skips a tick outright while the last is still running) |
| Release-on-failure | mandatory, with `needs:human` + an attempts comment | Without it, a bug a worker gave up on sits invisibly `claimed`/`in_progress` until the 90-min lease expires and `reap` notices — release-on-failure hands it back (or flags it) immediately instead of waiting on the lease clock |

## What happens when a laptop sleeps

A Desktop task simply does not fire while its machine is asleep or the Claude Code app is closed —
there is no queued backlog of missed ticks. On wake, it runs **one** catch-up invocation for whatever
it missed, then resumes its normal schedule. Two consequences worth planning for:

- A run that was mid-batch when the machine slept does not get to finish cleanly or release its
  claim — nothing runs during the sleep window at all (see above), but the 90-min lease keeps
  counting down in real time on GitHub the whole time the machine was asleep. If the sleep outlasted
  the lease, the hourly `reap` Routine has already freed the claim and possibly handed it to
  someone else before this task's next tick — which is exactly why every resuming action (a
  heartbeat, `bugflow start`, `bugflow prove`, …) re-verifies it is still the live claim holder
  before writing anything, and treats "no longer the holder" exactly like losing a race at claim
  time (see [CLAIMS-AND-LEASES.md](CLAIMS-AND-LEASES.md)'s race-condition table; CLI.md specifies
  this re-check for each of those commands).
- This is exactly why a developer's own Desktop-task capacity is treated as unreliable bycatch above,
  not part of the guaranteed throughput number — and exactly why a fleet seat is specified to run on
  a machine with "Keep computer awake" on, so it never hits this path at all.

## Run lifecycle — one worker invocation, step by step

1. **`bugflow next --json --seat <login>`** — what, if anything, this seat may take right now (its
   `allowedClasses`, its remaining `dailyClaimCap`, whether anything is even `ready`).
2. Nothing takeable → stop. This tick is done; the next scheduled fire checks again.
3. **`bugflow claim #N`** (or `batch:#M`) — the GitHub-assignee + lease-comment compare-and-swap.
   Exit 4 = not takeable (parked, blocked, wrong class for this seat); exit 3 = lost the race to
   another claimant — either way, stop.
4. **Worktree** — open (or create) this run's own isolated worktree (the Desktop task's worktree
   toggle, ON) and check out a branch for the batch. Never the machine's own interactive checkout.
5. **`bugflow start #N`** — records that branch/worktree against the issue; this is what actually
   moves it `claimed` → `in_progress` (per [LIFECYCLE.md](LIFECYCLE.md)'s state table), not merely
   having a checkout locally.
6. **`bugflow brief #N [--json]`** — the one thing to read. Not the code map, not the whole repo,
   unless `brief` itself points there.
7. **Harness** — route on the bug's own fields (see [HARNESS.md](HARNESS.md)'s predicate): the Ralph
   tier for a small agent-safe `tier:t1` bug, the full tier (the existing `bug-pipeline` skill) for anything
   else that still reached `ready`.
8. **PR** — opened with `Closes #N` in the body once the harness's own gate is green.
9. **`bugflow prove #N --pr <num>`** — cites the fix PR against the issue, the fact `sync`/`check`
   later verify against.
10. **Release-on-failure** — cap tripped (8 iterations, or 45 min) with no green gate:
    `bugflow release #N --reason "..."`, an attempts comment on the issue, `needs:human` added.

## What a worker prompt must contain

- Which GitHub login this run acts as, and that login's `allowedClasses` / remaining daily cap.
- The exact command for every lifecycle step above, in order — never a paraphrase a model might
  improvise around.
- The hard stop: **fix at most one batch; stop after 8 iterations or 45 minutes, whichever comes
  first.**
- What release-on-failure means concretely: the exact `release` call, what the attempts comment
  must say, and that `needs:human` is mandatory, not optional.
- The class/tier boundary this run may act on unattended — an agent-safe `tier:t1` bug, never a parked one,
  never one without `approved:owner` if it somehow reached `ready` anyway.
- What it may never touch: a parked or already-claimed bug, any file outside the batch's own
  `## Files` list, `bugflow.config.json` itself.
- The privacy rule, stated plainly: no live-client identifier — slug, business name, product,
  invoice/order number, tenant UUID — in anything this run writes (issue, PR, commit, comment).
- The model and effort to run at (Sonnet 5, `medium`, for the Ralph tier — see
  [HARNESS.md](HARNESS.md); the full tier sets its own per-stage models).
- Where "done" is defined (HARNESS.md's Definition of Done) so the loop knows when to stop
  iterating rather than polishing past a green gate.

See [`../templates/scheduled-task.SKILL.md`](../templates/scheduled-task.SKILL.md) for a worker
prompt built to this checklist.

## Open questions

- `VERIFY:` real sustained runs/day and first-pass success rate per seat — the capacity worked
  example above is illustrative until the ledger holds ten real fleet-seat runs (Stage 1 spike S2 in
  [ROADMAP.md](ROADMAP.md) is the first data point).
- `VERIFY:` whether a cloud Routine can be the developer's own per-machine worker at all, given
  Routines are not repo/host scoped the way a Desktop task's working folder is — today's mapping
  assumes a Desktop task for that job specifically because of the worktree toggle.

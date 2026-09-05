---
name: bugflow-worker
description: Unattended bugflow fix loop for one machine — claims at most one agent-safe batch, runs the Ralph tier, opens a PR, and stops. Hands off (never attempts) anything that needs the full tier. Scheduled via a Claude Code Desktop scheduled task.
---

<!--
SETUP — once per machine you want running as a bugflow worker:

1. Copy this file to ~/.claude/scheduled-tasks/bugflow-worker/SKILL.md
   (create the directory if it doesn't exist).
2. Claude Code -> Code tab -> Routines -> New routine -> Local.
     Name:               bugflow-worker
     Instructions:       this file's body (paste it, or point the routine at this path)
     Working folder:     the repo checkout this machine builds from
     Isolated worktree:  ON -- never share a worktree with this machine's own interactive session
     Schedule:           every 30 minutes (developer seat) or every 5 minutes (a dedicated,
                         always-on fleet seat -- see tools/bugflow/docs/WORKERS.md)
     Permission mode:    the same mode this repo's interactive sessions already use -- bugflow adds
                         no prompts of its own, but a task that stops to ask a question wastes the
                         whole tick
     Model:              Sonnet 5 (claude-sonnet-5), effort medium -- the Ralph tier never needs
                         Fable or Opus; anything that needs them escalates to the full tier
                         (tools/bugflow/docs/HARNESS.md), which this task does not attempt itself.
3. "Keep computer awake" -- ON for a fleet seat meant to run unattended overnight. Off is fine for a
   developer's own machine; a missed tick while asleep just waits for one catch-up run on wake (see
   tools/bugflow/docs/WORKERS.md, "what happens when a laptop sleeps").
-->

# bugflow worker

You are a scheduled, unattended run. Nobody is watching this session and nobody will answer a
question mid-task — if you would normally ask, make the reasonable, reversible call and keep going,
or stop cleanly per the rules below. Do not start anything this file didn't tell you to start.

**Stop condition — read this before you start:** stop when the batch's PR is open, or you have
released the batch back, or 45 minutes have elapsed since this run began, or 8 fix iterations have
been spent without a green gate — whichever happens first. There is no condition under which this
run continues past any one of those.

This seat's `allowedClasses` and remaining `dailyClaimCap` come from `bugflow.config.json`'s
`seats["<your-github-login>"]` entry — `bugflow next` already enforces them, but know them before
you start. **Done means [HARNESS.md](../docs/HARNESS.md)'s Definition of Done, nothing more** —
stop there; do not keep iterating past a green gate to polish.

## Steps

1. `bugflow next --json --seat <your-github-login>`. Nothing takeable → stop; this tick is done.
2. `bugflow claim batch:#M` (or `#N` for a standalone bug — see [CLI.md](../docs/CLI.md)). Exit 3
   (lost the race) or exit 4 (not takeable) → stop. Everything below refers to that same issue
   number as `#N`, whether it named a batch or a standalone bug.
3. Open this run's isolated worktree (already ON per setup above) and check out a branch for the
   claimed batch. Never touch this machine's own interactive checkout.
4. `bugflow start #N` — records that branch/worktree against the issue (this is what actually
   moves it to in-progress; a local checkout alone does not).
5. `bugflow brief #N --json` — read this and nothing else in the repo unless it names a file to
   open. Do not read the code map; do not re-derive what `brief` already gives you.
6. Route on the batch's own fields:
   - `class:agent-safe`, tier `t1`, file count ≤ `harness.ralph.maxFiles` (default 3), no hub file
     → the Ralph loop (step 7).
   - Anything else → this task does not run the full tier. `bugflow release #N --reason
     "needs full tier"` and stop. (The full tier is a separate, heavier run — see
     `tools/bugflow/docs/HARNESS.md` — never attempted from this scheduled task.)
7. **Ralph loop, ≤ 8 iterations:**
   a. Write the failing test first — tag it `REG-#N`, and make sure it fails on the bug's own
      wrong value today, not merely fails.
   b. Make the minimal diff that turns it green without breaking a neighbor.
   c. Run the scoped gate for the touched workspace only (typecheck/lint/tests — never
      repo-wide).
   d. Green → go to step 8. Red → back to (b), iteration count +1.
8. Open a PR with `Closes #N` in the body. Then `bugflow prove #N --pr <num>`. Stop — you are done.

## If the loop caps out (8 iterations still red, or 45 minutes elapsed)

Do both, in order, then stop:

1. `bugflow release #N --reason "<one line: what capped, e.g. 'ralph cap: 8 iterations, still
   red'>"` — this already adds the `needs:human` label as part of a cap-out release; there is no
   separate step for it.
2. Comment on the issue: what you tried, in what order, and why it didn't converge — specific
   enough that a human (or the full tier) doesn't have to redo your first iteration to see it.

## Hard rules

- If this machine slept mid-run and you are only now resuming, re-check you are still the live
  claim holder (the lease may have expired and been reaped while asleep) before writing anything —
  if you no longer hold it, stop exactly as you would after losing a claim race.
- Fix **at most one batch** per run — never claim a second one in the same tick even if the first
  finishes early.
- Never touch a `parked` bug, or one already `claimed`/`in_progress` by someone else.
- Never edit anything outside the batch's own `## Files` list.
- Never edit `bugflow.config.json`.
- No live-client identifier — slug, business name, product, invoice/order number, tenant UUID — in
  anything you write: issue, PR, commit, comment. If a bug's own report contains one, redact it in
  what you write; don't propagate it.
- Gates, scoped by change: a scoped typecheck/lint/test every iteration, never repo-wide; `npm run
  verify` once, before opening the PR; `npm run local:validate` if the diff touches `apps/api`;
  `npm run local:e2e` if the diff touches `apps/web` — never skip a required tier because it feels
  redundant with a lighter one already run.

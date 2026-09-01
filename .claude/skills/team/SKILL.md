---
name: team
description: >
  Run RouteFlow work as an agent team with a shared board. Auto-load when the owner states a new
  requirement, asks "what are the agents doing", "what's the status", "show me the board", wants
  work broken down and assigned, or asks to pick up a task. Keywords: "board", "backlog", "what's
  in progress", "break this down", "assign", "team", "sprint", "who is working on".
---

# The RouteFlow agent team

GitHub Issues is the board. `scripts/team/team.mjs` is how every agent reads and writes it. The
owner watches from the GitHub mobile app and answers questions there; agents reach him with
`PushNotification`.

Nothing here is hosted. The board is the repo's own issue tracker, so it survives any tool
decision, costs nothing, and cannot be paywalled.

## The roles

| Agent               | Owns                                                  | Never does                   |
| ------------------- | ----------------------------------------------------- | ---------------------------- |
| `@tech-lead`        | Scope, breakdown, sequencing, plan files              | Write feature code           |
| `@builder`          | One claimed task, test-first, in a worktree           | Review or merge its own work |
| `@feature-reviewer` | Independent pre-PR review against acceptance criteria | Re-implement                 |
| `@qa-engineer`      | Edge cases, tenant isolation, money math, stress      | Fix what it finds            |

The split is deliberate: the reviewer and QA are given the diff and the acceptance criteria but
**not** the builder's reasoning. A verifier who has absorbed the author's mental model inherits the
author's blind spots.

## The flow

```
owner states a requirement
   ↓
@tech-lead        epic + tasks on the board, plan files, sequence     → team.mjs epic / task
   ↓
@builder          claim → red tests → implement → verify → PR         → team.mjs claim / note / done
   ↓
@feature-reviewer + @qa-engineer   (parallel, both read-only)
   ↓
gates green → merge → deploy → issue closes via `Closes #N`
```

Run the two verifiers **in parallel** — independent review is the one place fan-out clearly wins.
Run builders **one per file set**, and for anything touching money math or tenant scoping, one
agent at a time. Parallel implementation is how three `pricing.ts` mirrors drift apart.

## Commands

```bash
node scripts/team/team.mjs board                 # every open issue, by derived lane
node scripts/team/team.mjs epic "<ask>" --client c3 --prio P1
node scripts/team/team.mjs task <epic#> "<title>" --area api
node scripts/team/team.mjs claim <issue#>        # comment-CAS, 90-minute lease
node scripts/team/team.mjs note  <issue#> "<progress>"
node scripts/team/team.mjs ask   <issue#> "<question for the owner>"
node scripts/team/team.mjs answered <issue#>     # print the owner's reply, clear the block
node scripts/team/team.mjs done  <issue#> "PR #501"
node scripts/team/team.mjs reap                  # release every expired lease
```

## Lanes are derived, not set

Board position is computed from live PR, CI and review state — adapted from Agent Orchestrator's
SCM-observer design. Nobody has to remember to move a card, so the board cannot lie:

| Lane                | Derived from                      |
| ------------------- | --------------------------------- |
| **Needs you**       | issue carries `blocked:owner`     |
| **CI failing**      | linked PR has a failing check     |
| **Review comments** | linked PR has `CHANGES_REQUESTED` |
| **Ready to merge**  | linked PR green **and** approved  |
| **In review**       | linked PR open                    |
| **In progress**     | a live claim, no PR yet           |
| **Ready**           | labelled `ready`, unclaimed       |

The link is the `Closes #N` line in the PR body. Without it the board cannot see the PR — so every
PR must carry one.

## Claiming: why comments and not assignees

Every Claude Code session on this box authenticates as the **same** GitHub account. `@me` is
identical in every session, and `--add-assignee` is an idempotent add to a set — it does not fail
when someone else holds the issue. Comment ids are server-assigned and totally ordered, so
"lowest live claim wins" is a real compare-and-swap. `claim` writes, jitters 2–5s, re-reads over
REST (never search, which lags minutes), and exits 3 if it lost.

**Exit code 3 means stop.** Implementing anyway is how two agents produce conflicting diffs.

Claim identity is the **worktree directory name** — it survives `/resume` and context compaction,
which session names and pids do not. Leases run 90 minutes; `reap` releases expired ones, because
a session killed hard never runs its own cleanup.

## Reaching the owner

When an agent is genuinely blocked on a decision only the owner can make:

```bash
node scripts/team/team.mjs ask 43 "Spec says discount after tax; existing invoices apply it before. Which wins?"
```

Then send a `PushNotification` with a one-line summary and **end the turn**. Do not guess, and do
not poll in a loop. The question is a GitHub comment, so it reaches the owner's phone through the
GitHub mobile app, and he replies there in plain English. A later session resumes with
`team.mjs answered 43`, which prints the reply and clears the block.

Ask when: acceptance criteria are ambiguous, the change would alter existing financial records, the
plan contradicts the code, or the answer depends on what a real client expects. Do not ask what the
code can already tell you — that is what the code map is for.

## Cost discipline

Tokens are the real budget here — GitHub is free, the box is paid for, and Claude usage is what
actually scales with output. The tiering is declared in each agent's frontmatter, so it applies
without anyone remembering to ask for it:

| Role                          | Model    | Effort | Why                                                                     |
| ----------------------------- | -------- | ------ | ----------------------------------------------------------------------- |
| `@tech-lead`                  | `fable`  | high   | One run per requirement; shapes every downstream token                  |
| `@builder`                    | `sonnet` | medium | Highest volume, longest turns — executes a spec that is already decided |
| `@qa-engineer`                | `sonnet` | high   | Cheap tier + high effort is the best value point in the team            |
| `@feature-reviewer`           | `opus`   | high   | Lowest volume, last gate, highest cost of a miss                        |
| gates (`verify`, `scan`, e2e) | —        | —      | No model at all. Deterministic checks are free; prefer them             |

**Escalate the model only for money math, migrations, and new tenant-scoped queries.** Those are
where a miss is unrecoverable. Everywhere else, a builder that seems to need Opus is telling you the
_plan_ was underspecified — fix the plan, which is cheap, rather than paying the premium on every
token of a long implementation turn.

### The main session orchestrates; it does not implement

Your interactive session runs on Opus. Every token it spends is billed at the top tier — so work
done _inline_ in the main loop is the most expensive work in the system, and implementation is
exactly the work that runs longest.

**Delegate volume work to `@builder` rather than writing the code in the main session.** The main
loop's job is to read the board, decide what happens next, spawn the right role, and relay the
result. That single habit moves the bulk of the team's tokens from the Opus tier to the Sonnet tier
without changing a line of what gets built.

Two things worth checking if costs ever look wrong: `CLAUDE_CODE_SUBAGENT_MODEL` takes precedence
over every `model:` field here, so setting it silently defeats the whole table above. And
`ANTHROPIC_API_KEY` must stay **unset** — when it is set, Claude Code prefers it over subscription
auth and quietly meters you per token. Both are unset today.

### The structural savings are bigger than the model choice

1. **The plan file is the only context handed over.** The builder never receives the lead's
   exploration, and the reviewer never receives the builder's reasoning. That is a correctness
   decision first — independent verifiers catch more — and it happens to cut the context of every
   downstream run.
2. **Read the code map, not the repo.** `INDEX.md` → area file → the one file it names. A broad grep
   across a 900-file monorepo is the single most expensive habit available, and it is why the map
   exists.
3. **Ask and stop; never thrash.** An agent guessing at an ambiguous spec burns tokens exploring and
   then usually guesses wrong. `team.mjs ask` costs one comment and one push notification.
4. **Claim before you work.** Two agents on the same task is exactly double the spend for one result.
   Exit code 3 means stop.
5. **Cheap gates first.** `verify` runs the signature scan (~20s) before typecheck before tests, so a
   known-bad shape fails in seconds rather than after a full suite.
6. **Small diffs.** One acceptance criterion, ~400 lines. Cheaper to review _and_ reviewed better —
   defect detection runs ~87% under 100 lines and ~28% over 1,000.
7. **Parallelise reads, serialise writes.** Run `@feature-reviewer` and `@qa-engineer` at the same
   time — they are independent and read-only. Never run two builders on the same file set.
8. **No persistent orchestrator.** A planning agent that stays resident is N+1 agents billed where
   you get N of work. The board is durable state; the agents are not. Spawn, finish, exit.
9. **`maxTurns` on every role.** An agent still going at its cap is thrashing. The cap converts an
   unbounded burn into a bounded failure that shows up on the board.
10. **Batch independent tool calls**, and never re-read a file to confirm an edit landed — the tool
    would have errored.

### Where NOT to save

Do not cut the independent review pass to save tokens. It is the cheapest role in the flow and it
guards the five defect classes that have actually cost this project production incidents. Cutting
verification to save tokens trades a small, predictable cost for a large, unpredictable one.

## House rules that outrank anything here

- **Web is the golden reference.** Mobile mirrors its endpoints, DTOs and flows.
- **Money** goes through `pricing.ts`; never re-derive `qty * unitPrice` on a boxed line; round every
  monetary write; move all three mirrors together.
- **Tenancy**: `forTenant()` or `tenantTransaction()`. A bare `$transaction` is not scoped.
- **Never test against a live client tenant.** Approved: `test`, `e2e-routeflow`, `routeflow-demo`,
  `qa-*`, `e2e-*`, `ux-audit-*`.
- **Client confidentiality**: the repo goes public during merge windows and issue events are
  permanently archived. Use opaque `client:cN` codes; the map lives in gitignored `local-assets/`.
- Update `.claude/code-map/` with every change — the `Stop` hook blocks the turn otherwise.
- **Read `.claude/lessons/LESSONS.md` before claiming a task**, and record the lesson after any
  bug fix — the same `Stop` hook (Gate 3) blocks fix-shaped turns that leave it untouched.

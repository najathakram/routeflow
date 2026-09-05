# Claims and leases

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** bugflow implementers (`claim`,
`heartbeat`, `release`, `reap`), anyone debugging "why does it say someone else has this."

How a worker takes exclusive ownership of a Bug or Batch issue with no database — a compare-and-
swap over ordinary GitHub issue comments — and why the one thing that has to change from the
mechanism already running in this repo (`scripts/team/team.mjs`) is the claim **identity**, not
the protocol. Read this after [LIFECYCLE.md](LIFECYCLE.md), which shows where `claimed` and
`in_progress` sit in the state machine.

## The mechanism, unchanged

Every session that will ever run bugflow authenticates to GitHub as *some* login, and multiple
sessions can share one — so `--assignee @me` and GitHub's own optimistic-locking primitives carry
no information about *which* session holds a claim. `team.mjs` solved this in 2026-08 with an
append-only comment protocol instead of a database row; bugflow inherits its compare-and-swap
*mechanism* exactly, but the grammar below is bugflow's own canonical one, not `team.mjs`'s literal
one (see "Legacy grammar retires at cutover" below):

1. **The marker.** A claim or release is one single-line HTML comment and nothing else —
   `<!--bugflow:claim id=<login>/<host>/<worktree> exp=<ISO-8601>-->` or
   `<!--bugflow:release id=<identity> reason=<...>-->`. A comment not matching this exact grammar
   from its first character is a human comment or unrelated bot chatter, never parsed as a
   claim/release — this is how the protocol tells an owner's reply apart from bot chatter, given
   both can post as the same account.
2. **No leading whitespace, no embedding.** An indented or embedded claim/release comment must not
   parse. A real incident this guards against, inherited from the mechanism it replaces: one
   implementation allowed a release line with leading whitespace inside somebody else's comment to
   silently free a lease the protocol still considered live.
3. **Server-ordered comment ids, lowest live wins.** GitHub issue-comment ids are assigned by the
   server and totally ordered. "Live" = a `<!--bugflow:claim …-->` comment whose `id` has no later
   `<!--bugflow:release …-->` naming it, and whose `exp=` hasn't passed. Sort live claims by
   comment id ascending; **the first one is the holder**, full stop — this is the only reason the
   protocol is a real compare-and-swap and not a race dressed up as one.
4. **Fetch structured comments, never a flattened line stream.** `gh api …/comments --paginate
   --slurp` and keep each comment's `id`/`body` as one unit. Rule 2 depends on a comment
   *boundary* — flattening every comment's body into one stream of lines (`--jq '.[].body'`)
   destroys that boundary and lets a release inside one person's comment cancel a claim inside
   someone else's.
5. **`--paginate`, always.** A claim is, by construction, the *newest* comment on a busy issue.
   Reading only page 1 (the oldest 100) makes every lease on comment 101+ invisible — the exact bug
   fixed on both sides of the old system (`team.mjs`'s `comments()` and `bugs.mjs`'s `readClaims`)
   in one commit, because both files parsed the same GitHub state and had to agree.

Claiming: post the claim comment, sleep a short random jitter (2–5s), **re-read** the comments. If
the now-lowest live claim isn't ours, we lost the race — post our own
`<!--bugflow:release id=<identity> reason=lost-race-->` and exit **3**. The re-read-after-jitter
step is what makes two simultaneous claimants converge on one winner instead of both believing
they won.

**Legacy grammar retires at cutover.** `team.mjs`'s own protocol — an `<!--rf:agent-->` marker
comment followed by an anchored `claim: id=<identity> lease-until=<ISO-8601>` /
`release: id=<identity> reason=<...>` line, with the multiline flag and no leading whitespace
permitted — is legacy-only: it keeps running only as long as `scripts/team/team.mjs` itself does
(retired in [MIGRATION.md](MIGRATION.md)'s Step 5), and no bugflow command ever reads or writes it.
The two grammars do not recognize each other's comments at all — see MIGRATION.md's dual-run
window for why that is the sharpest concrete risk in the whole cutover.

**Structural improvement bugflow gets for free:** `team.mjs` and `bugs.mjs` parse similarly-shaped
grammars independently today, and their own header comments warn that the two "MUST CHANGE
TOGETHER, IN ONE COMMIT" because there's nothing to import between two standalone CLI scripts.
bugflow is one real package — the claim-grammar parser (the comment regex, live-claim resolution)
is written **once**, in one module, and every command that needs it (`claim`, `heartbeat`,
`release`, `reap`, `sync`) imports it. The fragility the old warning exists to manage goes away
structurally, not by discipline.

## Identity: `login/host/worktree`, not the bare worktree name

The old identity was just the worktree directory's basename — chosen because it survives
`/resume` and context compaction, which a session name or a pid does not. That reasoning still
holds; what breaks is the *uniqueness* assumption once more than one developer is running
bugflow. Two developers who both name their working copy of a repo the same conventional thing
(`wt-bugflow`, or whatever a scaffolding script defaults to) produce **the same identity string**
from two different machines. The compare-and-swap still elects one winner correctly — comment ids
are still totally ordered — but every *report* of who holds a claim is now ambiguous: "`held by
wt-bugflow`" answers no useful question when two people could be that string.

Identity becomes `<github-login>/<hostname>/<worktree-name>`:

- **login** disambiguates the developer (or the fleet seat) — the piece the old identity had no
  room for at all.
- **host** disambiguates machine, for a developer who reasonably runs the same worktree name on a
  laptop and a desktop.
- **worktree** keeps the original property: stable across `/resume` and compaction, and
  disambiguates two concurrent sessions on one machine.

**Worked collision, old vs. new:** Alice and Bob each run a scheduled task in a worktree both
happen to call `wt-bugflow`. Old identity: both are literally the string `wt-bugflow` — a report
naming the holder is uninformative, and a naive equality check (`existing[0].id !== id`) could let
Bob's session believe it is *extending its own* claim when it is actually reading Alice's. New
identity: `alice/DESKTOP-A1B2/wt-bugflow` vs. `bob/LAPTOP-X9Z/wt-bugflow` — distinct strings, the
CAS and every report of it behave correctly.

## Lease, heartbeat, reap

- **Lease:** 90 minutes (`lease.minutes` in config, unchanged from `team.mjs`'s `LEASE_MINUTES`).
- **Heartbeat — new in bugflow, not present in the source `team.mjs`.** `team.mjs` has no renewal
  path at all; a claim simply expires at a fixed 90 minutes with no way to extend it short of
  reclaiming. bugflow's `bugflow heartbeat #N` **edits the existing claim comment in place**
  (`gh api -X PATCH .../issues/comments/:id`), refreshing `exp=` without posting a new one.
  This matters for a long `full`-tier bug-pipeline run that can legitimately exceed 90 minutes.
  **Correctness note, provable from GitHub's own comment semantics, not assumed:** editing a
  comment does not change its `id`. The lowest-live-comment-id ordering that makes the CAS correct
  is therefore **unaffected by a heartbeat** — a heartbeat can only push out the same, already-
  ordered claim's expiry; it can never let a claim jump ahead of one that was posted earlier.
- **Reap:** releases any live (unreleased) claim whose `exp=` — original or last heartbeated — has
  passed, posting `<!--bugflow:release id=<identity> reason=lease-expired-->`. Run as part of
  `sync` (a scheduled Routine, in practice) rather than only on demand.

**What reap cannot do, honestly stated.** `bugs.mjs`'s shard lock can detect a truly **dead**
process (`process.kill(pid, 0)` plus a boot-epoch check — and, per **L-070**, a `/proc/<pid>/stat`
state-`Z` read too, since signal 0 alone succeeds for an unreaped POSIX zombie) and break its lock
immediately, because it runs on one machine with real pids. A GitHub comment carries no such
liveness signal — reap can
only tell "the lease expired," never "the holder is actually still working." This is a genuine,
permanent property of a lease over a comment, not a bug to fix: the mitigation is that a worker
expected to run long must heartbeat *before* 90 minutes elapse, and a worker resuming after any
gap (see the "machine sleeps" row below) must re-check it still holds the claim before acting.

## Batch-level vs. bug-level claims

Work is claimed the way it already is today — **per batch, never per bug** ("the board card, the
pipeline folder and the PR are all batch-scoped," per the current `bug-registry` skill). Concretely:

- `bugflow claim batch:#M` posts the CAS comment on the **Batch** parent issue `#M`. On winning, it
  copies the assignee and sets `status:claimed` on every **open** sub-issue under that batch in one
  pass (R5) — the direct analog of `bugs.mjs`'s `cmds.claim`, which flips every workable row in a
  shard to `in-flight` under one lock hold, except the lock here is the comment CAS on the parent
  issue rather than an `mkdir`-based file lock.
- `bugflow claim #N` on a bug with **no parent** (not yet batched, or a singleton — see
  [PLANNING.md](PLANNING.md)) posts the CAS directly on that bug's own issue.
- A bug **attached** to an already-claimed batch (via `plan`'s attach phase) immediately gets the
  batch holder as assignee and `status:claimed`, without a separate claim step (R6) — the batch
  holder already has the lease and is already working the batch's files; leaving a newly-attached
  sibling at `ready` while parented under a claimed batch would make it simultaneously "takeable by
  anyone" and "already spoken for," which the Takeable predicate in [LIFECYCLE.md](LIFECYCLE.md) is
  built to prevent.

## Seat class permissions

The carve-out (`class:money`/`tenancy`/`migration` ⇒ `parked` until `approved:owner`) gates
**unattended** automation, not humans — nobody wants an agent fixing a money bug with no review,
not that a human is barred from it. But the CLI itself has no human-only bypass: `bugflow claim`
refuses a `parked` target with exit `4` regardless of who calls it, because the Takeable predicate
in [LIFECYCLE.md](LIFECYCLE.md) re-checks `parked` unconditionally. A human unparks a bug the same
way anyone would — `gh issue edit <N> --add-label "approved:owner"`, which the next `bugflow sync`
turns into `status:ready` + `harness:full` — and only then claims it like any other `ready` bug.
Fleet seats (`bugflow.config.json`'s `seats[login].allowedClasses`) are configured to `agent-safe`
only; a seat's `dailyClaimCap` bounds how many claims one login may hold per day regardless of
class.

## Race-condition table

| Scenario | What happens | Why it's safe (or isn't) |
| --- | --- | --- |
| Two seats claim the same issue within the same minute | Both post `<!--bugflow:claim …-->` comments, both jitter+re-read, both see the same lowest-comment-id winner. The loser posts its own `<!--bugflow:release … reason=lost-race-->` and exits 3. | Real CAS — comment ids are server-assigned and totally ordered; there is no window where both readers can disagree. |
| A lease expires mid-run (the worker is still actually running, past 90 min, never heartbeated) | `reap` releases it; a second seat can now win a claim on the same issue while the first is still silently working. Two workers may end up inside the same file(s). | **Not fully safe** — this is the honest limit of a time-based lease with no liveness signal (see above). Mitigation is process, not mechanism: a run expected to exceed the lease must heartbeat; `full`-tier's 45-minute cap and Ralph's 8-iteration cap are both comfortably under 90 minutes precisely so this should be rare in practice. |
| The claiming machine sleeps (desktop scheduled tasks only run while the app is open and the machine awake) | The lease keeps expiring in real time on GitHub while the machine is asleep. If the sleep outlasts the lease, `reap` frees it and someone else may claim it. On waking, the original worker's next action (heartbeat, `start`, `prove`, …) must **re-check it is still the live claim holder** before proceeding, and treat "no longer the holder" exactly like losing a race — release its own state and stop. | Safe *if* every resuming action re-verifies ownership first — a direct extension of the same "lost the race" check already required at claim time, just run again before any later write. CLI.md's `heartbeat`, `start`, `prove` and `release` entries each specify exactly this re-check. |
| A PR is opened with `Closes #N` after the claim was released (or reaped) | `sync`'s PR-driven transition (`in_progress`→`in_review`) triggers purely on "an open PR's body contains `Closes #N`" — it does not check who currently holds the claim, mirroring `team.mjs`'s own board-lane derivation, which is likewise claim-agnostic. A stray or late PR from a released session can resurrect an issue's status unexpectedly. | **Not caught by the base design.** Recommended guard, not yet in the brief: `sync` should compare the PR's author/head-branch against the issue's most recent claim identity and label `needs:human` on a mismatch rather than silently accepting it. **VERIFY** with the owner before relying on this. |

# Proposal: `bugs.mjs next-id` + a neighbor-query, scoped and priced

Written by Lane E (registry owner) at the fleet lead's request, for the owner. Scoping and
pricing only — **not built**. Evidence is this session's own incidents, not estimation.

## The problem, in numbers

Six real id-collision incidents in one fleet session tonight, four distinct root causes, all
the same shape: **allocation reads what the allocator can see, and nobody — human, agent, or
the `bugs.mjs file` tool itself — can see an id reserved in an unmerged branch until it's
fetched.**

| # | What happened | Root cause |
|---|---|---|
| 1 | Lead handed out B526 from a "next free" read of merged master | unaware PR #901 (unmerged) had already reserved B526–B532 |
| 2 | A lane's fix commit self-resolved to B523 as "the next real id" | blind to a second, earlier-filed branch independently claiming B523 |
| 3 | Lead allocated B536/B537 to a lane from memory | a request already asking the registry owner for B536 was still in flight, unacknowledged |
| 4 | A fix commit self-referenced "B510" in its own message | its actual registry record had been renumbered to B526 during filing, same day |
| 5 | Registry owner's own `bugs.mjs file` (no `--id`) minted B533 | which was already taken on a sibling branch pushed minutes earlier — caught before commit, not by the tool |
| 6 | Lane D minted a lesson as "L-199" | correct by their local view of `origin/master` (nextId 199 there); already taken in the unmerged consolidated PR (nextId 205) |

Every one of these was caught **by a human/agent doing a manual `git fetch --all --prune` +
`git log --all -- <path>` scan** — the exact thing this proposal turns into a single command.
Manual catching worked tonight because one session was watching full-time; it does not scale
past that, and it burns a full round-trip (fetch + scan + a chat message back and forth) per
allocation, which is the actual cost this pays for even when it works.

## Proposed command 1 — `bugs.mjs next-id`

```
bugs.mjs next-id [--for bug|lesson] [--reserve "<short description>"]
```

- Runs `git fetch --all --prune` (the step everyone currently skips or forgets), then scans
  **every local and remote ref** — `git log --all --oneline -- .claude/campaign/bugs/B*.md`
  (or the lessons-file equivalent for `--for lesson`) — for the true max id in use anywhere,
  unmerged branches included. This is exactly the manual sequence used to catch all six
  incidents above, just automated and run every time instead of only when someone remembers to.
- Prints the next free id and exits. No file writes, no state — a read-only query, safe to run
  from any worktree at any time.
- `--reserve` is the one piece of NEW mechanism: appends a line to a small, git-tracked
  `.claude/campaign/reservations.jsonl` (append-only, one line per reservation: id, requester,
  description, timestamp) so a *second* caller running `next-id` a minute later sees the
  reservation even before the reserving branch has a commit to scan. Without this, two people
  running `next-id` in the same 30 seconds can still both get the same answer — the `--reserve`
  file is what actually closes that last race, not just the fetch-and-scan.

## Proposed command 2 — the neighbor query

```
bugs.mjs neighbors --paths <file1> <file2> ...
```

- Greps every registry `.md`'s `location:` frontmatter field (already a plain string today,
  no schema change needed) for a substring match against any of the given paths.
- Prints every open (not `already-fixed`/`closed`) entry whose `location` overlaps — id, title,
  severity, state. A lane about to edit a file gets its neighbors in one command instead of
  grepping the registry by hand (which, per the owner's own standing instruction on
  opportunistic bug sweeping, is why lanes mostly don't do it today).
- Read-only, no new mechanism — pure query over data that already exists.

## Scope and cost

- **Both commands are additions to the existing `bugs.mjs`**, which already shells out to git
  and already has a `file`/`already-fixed`/`note` command family to extend. No new
  dependencies, no schema migration on existing records (`location` is already free text).
- **`next-id`**: ~40-60 lines — the fetch+scan logic already exists informally in every
  incident's manual recovery above; wrapping it in a command is transcription, not design. The
  `--reserve` file format is the only genuinely new piece (an append-only JSONL, same shape as
  `bugs.jsonl` itself) — maybe another 30-40 lines including a stale-reservation prune (an
  unfiled reservation older than, say, 24h stops blocking `next-id`, so an abandoned reservation
  doesn't permanently burn an id).
- **`neighbors`**: ~20-30 lines — a grep over already-loaded records, no new data.
- **Risk**: low. Both are read-only against existing data; the only write path (`--reserve`)
  appends to a new file nothing else reads yet, so it can't corrupt `bugs.jsonl` or any `.md`
  record even if something goes wrong.
- **Estimated total**: a single focused session, well under the scale of tonight's bookkeeping
  batch itself. This is the cheapest fix on the board relative to what it stops costing —
  today's six incidents each burned a chat round-trip plus, in three cases, a re-file/rename
  after the fact.

## What this does NOT fix

- It doesn't stop someone from *not running* `next-id` — a human or agent can still hand out an
  id from memory, as happened three times tonight even with the discipline already in place.
  The command makes the correct path cheap and fast; it can't force anyone onto it. Pairing this
  with a `bugs.mjs file` refusal when `--id` is omitted AND `next-id` wasn't run in the last N
  minutes is a plausible follow-up, not scoped here.
- It doesn't solve the parallel, adjacent problem this session also hit (verifying whether a fix
  is LANDED, not just allocating an id) — that's [[L-197]]/[[L-203]]'s territory, a different
  command (`bugs.mjs verify-landed <pr>` doing the fetch+resolve-commit+ancestor-check sequence)
  that would be a natural sibling proposal but isn't priced here.

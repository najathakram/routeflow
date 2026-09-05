<!-- Copy to .claude/loop.md at the repo root. Status: Proposed v0.1 · Date: 2026-09-04 ·
     Audience: whoever runs /loop in this repo. This is the DEFAULT prompt /loop falls back to
     when invoked with no explicit command. It is a maintenance loop, not a build loop: its job
     is to keep exactly one thing moving, never to start new work on its own initiative. -->

# Default maintenance loop

On each tick, in this order:

1. **Is there a PR open from a previous tick of this loop?** If yes:
   - CI red → find the failing check, make the smallest fix that turns it green, push.
   - Changes requested → address them, push.
   - Green and approved → this is as far as this loop goes; merging is a human or a merge-queue
     decision, never this loop's.
   - Otherwise → nothing to do this tick; stop.
2. **No PR open?** Run `bugflow next --json`. Nothing takeable → stop, this tick is done.
3. **Something takeable** → `bugflow claim batch:#M` (or `#N` for a standalone bug), then work
   exactly that one batch through the Ralph tier or hand it to the full tier if it doesn't fit
   Ralph's routing predicate (see `tools/bugflow/docs/HARNESS.md`). Stop once the batch's PR opens,
   or once you release it — never pick up a second batch in the same tick.

## Hard rules

- Tend the batch already in flight before ever asking `bugflow next` for a new one.
- Never start work `bugflow next` did not hand you — no unrelated refactors, no "while I'm here"
  fixes, no new features. This loop's whole job is bugflow's own queue, nothing else.
- Never touch a `parked` or already-claimed bug.
- No live-client identifier in anything this loop writes.
- Stop the tick the moment there is nothing left to do — a loop that keeps hunting for work to
  justify its own tick is the failure mode this file exists to prevent.

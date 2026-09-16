# Bug test plan — <bug id(s)> <slug>

> Fable @ high writes this from the fix ruling; Sonnet types the tests inside the engine. The red bar is
> BEHAVIORAL: each REG test must fail today on its own exact wrong value — reproduction is the point.

## Red set (REG-tagged; in the red gate)

| T#  | Title (starts with REG-<bug id>) | Setup | Asserts | Fails TODAY with | File |
| --- | -------------------------------- | ----- | ------- | ---------------- | ---- |

"Fails TODAY with" is the exact expected-vs-received the red gate will verify (e.g. `expected 7 received 6`) —
never merely "throws" or "undefined".

## Pins (no REG token; outside the red gate)

| T#  | Frozen behavior | File |
| --- | --------------- | ---- |

## Harness notes (verified by the engine's harness-integrity check)

- Which existing mocks/fixtures the fix's surface changes will break, and the one-line remedy each — e.g. a
  mocked service gaining a method, a fixture value a new validator rejects. Fix these IN THE SAME EDIT as the
  tests; a stale mock in a neighboring suite is the classic bug-batch blocker.

## Commands

- `redGate.commands`: scoped jest filtered to the REG tokens; expect fail.
- The REG token(s) double as the registry proof lines at close-out.

# Fix ruling — <bug id(s)> <slug>

> Fable @ high rules over the S1 brief + S2 refutation verbatim; it opens no file. One ruling per run.
> S2's verdict must be attached below this header, quoted in full.

## 1. Cause verdict

- **Accepted cause**: <the exact diverging line and why behavior departs from intent> — or the one question sent
  back to S2 (one round only; still undetermined → owner, not code).

## 2. Fix design (minimal diff)

- What changes, where (files + the shape of each edit); what must NOT change.
- **Invariant preserved**: <one sentence, testable>

## 3. Regression tests

| T#  | REG token | Fails TODAY on (exact wrong value) | Passes after fix on | Notes |
| --- | --------- | ---------------------------------- | ------------------- | ----- |

Pins (no REG token, outside the red gate): <behavior frozen, file>

## 4. Blast radius (`radiusFiles`)

- <files review depth belongs to — the fix's files, their specs, direct callers>

## 5. Sibling pattern (`siblingPatterns`)

- `<regex>` — <what a hit means> · or: **none plausible** (recorded; the sweep is skipped)

## 6. Data repair

- Corrupted persisted data? <no / plausibly — then: the read-only report script to run first; the owner decides
  the repair; never bundled with the fix>

## 7. Probe plan

| File | `revertFix` | REG test that must go red |
| ---- | ----------- | ------------------------- |

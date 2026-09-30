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

## 4. Blast radius (`radius:` per-`fix`-task `[before, after]` pair)

- <the context-line counts `review-pack.mjs --radius before,after` shows around each call-site hit of the fix's
  changed/exported symbols — NOT a file list; the script auto-discovers the radius files itself from those
  call sites>

## 5. Sibling pattern (engine-level `siblingPatterns`, read once for the whole run)

- `<regex>` — <what a hit means> · or: **none plausible** (recorded; the sweep is skipped)

## 6. Data repair

- Corrupted persisted data? <no / plausibly — then: the read-only report script to run first; the owner decides
  the repair; never bundled with the fix>

## 7. Probe plan

- Each row below becomes a `revert-probe {file, test}` task in the build plan, run sequentially after the
  fix's wave (never in parallel) and checksum-verified on restore by one shared `checksum:after` agent.

| File | Needs a `revert-probe` task? | REG test that must go red (`t.test`) |
| ---- | ---------------------------- | ------------------------------------ |

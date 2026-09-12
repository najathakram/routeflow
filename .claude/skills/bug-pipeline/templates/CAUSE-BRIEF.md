# Cause brief — <bug id(s)> <slug>

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every claim carries a
> file:line, a command output, or a quoted source. The suspected cause is recorded AS A CLAIM. No fix proposals.

## The bug as stated

- **Source**: <registry row / issue / user report, quoted verbatim>
- **Repro**: input X → observed Y; **expected Z** (the exact wrong value matters — the repro test will fail on it)
- **Suspected cause (claim, unverified)**: <quote whoever suspected it, with their evidence if any>

## Code path

- Entry point → diverging behavior, as a walked path with excerpts (file:line each hop)
- The implicated lines, quoted

## History

- `git log --oneline -5 -- <implicated files>`; `git blame` of the implicated lines
- When did this last change, in what PR/commit, and what else changed with it

## Existing tests around this behavior

- Which specs touch this path; what each asserts TODAY (does any assert the wrong behavior? name it)

## Production evidence (if any)

- Log lines, affected row counts, ids/amounts only — never client identifiers

## Open unknowns

- What S2 (cause refutation) most needs to check

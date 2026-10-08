# Design Gate: reviewer checklist

This checklist is for the Opus spec reviewer, the PR reviewer and the lead.

Run the mechanics first: `node .claude/skills/future-proof/scripts/check-gate.mjs <spec.md>`. If that
check fails, the spec goes back unreviewed. This checklist judges whether the answers are **right**, and
it runs against the code at the gate's base sha, not against the spec's own description of that code.

## Paste this into the reviewer's brief

> **Design Gate (future-proof).** Judge the spec's `## Design Gate` block against
> `.claude/skills/future-proof/references/REVIEWER-CHECKLIST.md`. Besides your design verdict, return
> `GATE: PASS` or `GATE: FAIL`, then one line per failed heading: `G#: <the FAIL trigger> — <evidence as
> path:line>`. A FAIL on any heading fails the spec. Check the facts at the gate's base sha; never take
> them from the spec.

## Per heading

### G1 Fit
- **PASS** when all of these hold:
  - the program or train is named, or "none" comes with a reason;
  - every load-bearing fact is path:line at the base sha, or a live command with its output;
  - the writers of each field the design reads are listed;
  - the design extends what exists, or gives a reason for new code;
  - one source of truth is named.
- **FAIL** when any of these is true:
  - a fact comes from memory or from a document;
  - the reviewer cannot find a field, state, writer or environment fact at the sha;
  - there is a second store or a second computation of the same thing, with no reason given;
  - a script or backfill writes beside the service function;
  - a rule shared with another spec is stated differently in each spec.

### Area sweep
- **PASS** when all of these hold:
  - all four sources were queried, with the commands shown;
  - every open id in the area is fixed (with its own commit and red test), or deferred with a reason
    and a row;
  - the chunk is within the size cap, or is split by sub-area.
- **FAIL** when any of these is true:
  - no queries were run;
  - an open money or high item in the same files is neither fixed nor deferred;
  - one branch covers two areas;
  - the chunk is over the cap.

### G2 Variation map
- **PASS** when all of these hold:
  - all ten axes and the surfaces line are answered, each with a real difference or a reasoned n/a;
  - each SEAM NOW names a concrete seam in this change, and the real type, tier or program behind it;
  - rules read a derived capability, a setting or a registry;
  - new gates ship dark, and their flip is planned.
- **FAIL** when any of these is true:
  - an axis says "same everywhere" when the reviewer can name a type or tier where it differs;
  - a SEAM NOW has nothing in the change;
  - a rule is keyed on a profile key, a tenant slug or a raw mode;
  - a seam is speculative, with no named need;
  - a LATER item is built.

### G3 Replace-later
- **PASS** when all of these hold:
  - the planned programs that touch the area are listed, each with an answer;
  - any interim has an owner-approved expiry, a follow-up row, and the conditions that keep it safe.
- **FAIL** when any of these is true:
  - a program in the plan would rework this, and it is not listed;
  - an interim has no expiry;
  - business state is kept on one device, or in a single-instance shape, without the owner's OK;
  - a round of folding opened new must-fix findings, and the model was not re-picked.

### G4 Class, not instance
- **PASS** when all of these hold:
  - the class is stated;
  - the inventory is defined by a code predicate, with its count at the sha;
  - one helper exists;
  - a pin, or a required parameter, fails on a new bypass;
  - nothing fails open;
  - every red row states master's **observed** value and fails on that value.
- **FAIL** when any of these is true:
  - the fix is a set of per-site edits;
  - the inventory is a hand list, or the pin is scoped by a list of file names;
  - an optional parameter or an env default stands where a missing value must throw;
  - a red row fails on a compile error, an unknown field or a validation 400;
  - a master value is predicted rather than observed;
  - the structural pin is the only test.

### G5 Data and time
- **PASS** when all of these hold:
  - schema changes are additive and placed in a sitting folder, with any SEAM NOW columns in the same
    folder;
  - snapshots are named;
  - the server owns money figures and identities;
  - any value decided earlier is re-read under a lock or CAS;
  - event order, redelivery, multi-device use and offline replay are covered;
  - old-shape rows have a census and a dual-read end date;
  - the dark-to-enforced flip is planned;
  - money goes through `@routeflow/pricing`.
- **FAIL** when any of these is true:
  - a schema change is outside a sitting, or not additive;
  - a past record is re-derived from live data;
  - a client figure or identity is trusted;
  - a value decided at creation is used at completion with no re-read;
  - in-flight or legacy rows are ignored;
  - money math happens outside the pricing package.

### G6 Scale
- **PASS** when all of these hold:
  - queries are paginated or batched, the index is named, and there are no per-row queries;
  - caps are named constants or settings;
  - the UI covers the 10,000-item case.
- **FAIL** when any of these is true:
  - a `findMany` is unbounded;
  - there are N+1 queries;
  - a literal cap is repeated;
  - a picker fetches everything;
  - an index is assumed but not checked.

### G7 UX lens
- **PASS** when all of these hold:
  - the planned flow is reasoned through A1–A5;
  - every changed screen has a parity inventory;
  - both apple-ux and apple-design agree on placement, with reasons;
  - n/a is used only for work with no UI.
- **FAIL** when any of these is true:
  - a control is lost or hidden without the owner's OK;
  - one state has two primary actions;
  - a destructive step has no undo;
  - placement was decided by one lens only;
  - a moved control has no link from its old place.

### G8 Change-friendliness
- **PASS** when all of these hold:
  - each setting's home matches `SETTINGS_REGISTRY`, with a row and a screen;
  - shared types, enums and error codes live in `packages/types`, with parity;
  - every flag has a removal plan;
  - a code-map entry is planned;
  - every SEAM NOW and LATER line has a diff size of S or smaller, or an M with a reason.
- **FAIL** when any of these is true:
  - behaviour is hardcoded that a setting or registry should carry;
  - an enum or DTO is redeclared;
  - a flag has no removal plan;
  - a known future need is sized L;
  - the reviewer judges a size to be at least one step too small.

### G9 Cost and stop
- **PASS** when all of these hold:
  - one line says why this shape beats the quick fix;
  - any hotfix has a dated, owner-approved follow-up;
  - speculative seams are cut.
- **FAIL** when any of these is true:
  - a quick fix is used outside a P0 or an owner deadline;
  - a P0 has no follow-up row;
  - the design is over-engineered: a framework, a base class, or a setting nobody sets.

### G10 Owner questions
- **PASS** when the answer is "none", or the questions are batched with the recommended option first for
  each, and they were asked before the build.
- **FAIL** when any of these is true:
  - an assumption stands in for an owner preference;
  - a question is left for the builder;
  - questions arrive one at a time, mid-build.

## PR stage: the builder's output against the gate

Each of these is a BLOCK under `pre-merge-review` semantics:

1. A SEAM NOW item is missing from the place the gate put it (a column, a parameter, a registry row or a
   setting).
2. A LATER item was built, or a BUILD NOW item is missing.
3. The inventory pin is missing, or it does not go red when one call site bypasses the helper. Ask for
   the revert-red evidence.
4. A red row was not observed red on master. The report must show the observed value.
5. A chunk breaks a rule: it covers more than one area, issues share a commit, the PR body lists no
   closed ids or deferred rows, or it is over the size cap.
6. The builder decided an owner question.
7. The PR has no gate reference: no spec link, and no Lite or Hotfix block in the PR body.

## Lead steps

1. Run `check-gate.mjs` before dispatching any review. If it exits 1, return the spec to the SA with the
   printed list.
2. Put the snippet above in the reviewer brief, and record `GATE: PASS` or `GATE: FAIL` beside the
   verdict.
3. A ruling that folds review text names the gate headings it re-checked.
4. The builder brief carries the BUILD NOW list, the SEAM NOW list with locations, the pin, the red rows
   and the chunk ids.
5. Write one RUN-LOG line per gated spec: the verdict, the rounds, the misses and the catches.

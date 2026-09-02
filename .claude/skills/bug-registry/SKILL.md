---
name: bug-registry
description: >
  File, track and close bugs in RouteFlow's in-repo registry. Auto-load when the owner reports a
  bug, asks to "update the bug registry", "file a bug", "add this bug", "log this", asks what is
  known about a bug id (B###), asks which bug an agent should take next, or when a fix lands and
  the registry needs closing out. Keywords: "bug registry", "file a bug", "report a bug", "log a
  bug", "B###", "what's the status of B", "which bug next", "close out the bug".
---

# The bug registry

Three stores, each owning exactly one thing. They are not redundant, and nothing should be copied
between them by hand — everything downstream of the record is derived.

| Store                             | Owns                                              | Written by                |
| --------------------------------- | ------------------------------------------------- | ------------------------- |
| `.claude/campaign/bugs/B###.md`   | What the bug **is** — analysis + append-only history | this skill, analysis agents |
| `.claude/campaign/status/F##.jsonl` | What the bug **is doing** — state + proof          | the batch pipeline        |
| GitHub Issues (one card per batch) | What is **in flight** — lanes derived from PR/CI    | `scripts/team/team.mjs`   |

`local-assets/docs/routeflow-bug-register.html` is a **rendered view**, not a source. It is
gitignored and only the owner can republish it. Never treat it as authoritative and never block on
it.

## Reporting a bug (the owner's entry point)

The owner describes a bug in plain English. Do not interrogate them — file first, analyse second.

```bash
npm run bugs -- file "<one-line title>" --location "<file path or Area · surface>" --severity critical|high|medium|low --batch F## --tier T1
```

Pass `--batch` whenever you know it: without a batch there is no ledger row, so `campaign-check` and `next` cannot see the bug at all. That allocates the next id (**max + 1, never filling a gap** — a gap is an id reserved by an
unmerged branch), writes the catalogue row, creates `.claude/campaign/bugs/B###.md`, and prints
whether the bug trips the carve-out. Then run the analysis pass below.

If the owner's report is really several bugs, file each one separately. A record that describes two
defects cannot be closed by one proof, and `campaign-check` will refuse it later.

## The analysis pass

Run this **once per batch at claim time, not once per bug at file time.** Bugs are batched because
they share files; analysing them individually re-reads the same service ten times and is the single
most wasteful thing available here. The exception is a freshly filed bug with no batch yet — give
that one a quick pass so it can be routed.

Use a **Fable** agent (high effort). Fill each section with `npm run bugs -- note B### "<text>" --section "<name>"`:

1. **What this feature is for** — the user-visible purpose. You cannot judge a fix without it.
2. **Root cause** — the actual defect, and its **class**. Check whether that class already has a
   signature in `.claude/skills/bug-hunt/scripts/scan-signatures.mjs`; if it does, search for
   siblings, because the same shape is usually in three more places.
3. **User impact** — who hits this, how often, and what it costs them. Severity is a claim; this is
   the evidence for it.
4. **Fix approach and UX** — including the question that matters most: **can this class be made
   structurally unwritable?** A fix that patches one call site prevents one bug; a lint rule, a
   type, or a scan signature prevents the next N. Issue #502 is the standing home for that work.
   Name the UX consequence explicitly — a correct fix that degrades the flow is not done.
5. **Test plan** — the tier and the **exact `REG-B###` test name**. `campaign-check` will refuse to
   close this bug without a passing test carrying that token, so decide it here, not later.
   T1 = jest, T2 = Playwright against the deployed build, T3 = manual row in the batch build-plan.

## The carve-out — what an agent may fix unattended

Owner decision, 2026-09-02. `classify()` in `scripts/campaign/bugs.mjs` is the single expression of
it; do not re-implement the judgement anywhere else.

- **Agent-safe** — plan it, fix it, open the PR, unattended.
- **Parked** — anything matching **money**, **tenancy** or **migration** patterns. Analyse and plan
  it fully, then stop and hand the owner a ready plan. Do not write the fix unattended.

The classifier is deliberately over-broad: a false "sensitive" costs one glance, a false "safe"
costs a production money bug. It currently parks 17 of 21 queued batches, so most throughput comes
from the analysis pass, not from unattended fixing.

## Picking up work

```bash
npm run bugs -- status              # every batch: done/total, how many analysed, board issue
npm run bugs -- next                # the next agent-SAFE batch (carve-out applied)
npm run bugs -- brief F11           # ⭐ everything needed to start: plan, ordering, per-bug fix + test plan
npm run bugs -- show B129           # one bug in full
npm run bugs -- list --open --batch F11
```

**`brief` is the one an agent should run.** It assembles the batch plan (ordering, file conflicts,
risks), then each bug with its Summary, Fix approach and Test plan, and ends with the exact commands
to close out. Reading it is the difference between fixing the right bug and fixing it the right way —
every F11 card, for instance, carries a fix the adversarial pass REFUTED, and `brief` leads with that.

Work is claimed per **batch**, never per bug — the board card, the pipeline folder and the PR are
all batch-scoped. `node scripts/team/team.mjs claim <issue#>` is a real compare-and-swap;
**exit code 3 means another agent holds it — stop.**

## Closing out

Two transitions, and they are deliberately separate — `proven` means merged with a passing test,
`done` means live after a green deploy. Collapsing them is the fiction `campaign-check` exists to
prevent, so neither command will invent the other's evidence.

```bash
# after the PR merges, per bug
npm run bugs -- prove B129 --pr 601 --proof "REG-B129 jest: cancelling a run leaves its orders sweepable"

# after a GREEN DEPLOY, per batch
npm run bugs -- discharge F11 --evidence "Railway deploy <id> SUCCESS; Actions run <id> E2E green against it"
```

Both write the ledger **replace-in-place** and update the record's front matter and History.
Never hand-edit `status/F##.jsonl`: a second row for the same id is a duplicate the gate rejects,
and that is the first mistake everyone makes.

Guards you cannot talk your way past:

- `--proof` must cite the exact `REG-B###` token (a prefix will not do — `REG-B12` must not be
  satisfiable by `REG-B120`).
- `--evidence` must actually name the deploy and the run. This is the one claim `campaign-check`
  cannot verify for you, so it is the one place a lie would survive.
- `--pending-deploy` is T2-only.

`sync` also runs as **Gate 4 of `.claude/hooks/stop.mjs`** every turn, so a landed fix records its
own commits. Commit the changed `bugs/B###.md` files alongside the fix.

## House rules that outrank anything here

- **Never name a live client** in a record — slug, business name, product, invoice or order number,
  tenant UUID. The repo goes public during CI windows and these files are tracked. Use `acme`-style
  placeholders.
- **Money** goes through `pricing.ts`; move all three mirrors together.
- **Tenancy**: `forTenant()` or `tenantTransaction()`; a bare `$transaction` is not scoped.
- Record the lesson after any fix — `.claude/lessons/LESSONS.md`, enforced by Gate 3.

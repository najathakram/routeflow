# Planning

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** bugflow implementers (`plan`,
`next`), anyone trying to predict what batch they'll be handed next.

Attach-or-wave: how `bugflow plan` decides whether a freshly-triaged `ready` bug joins a batch
already in flight or starts a new one, how new batches get grouped, and how batches are coloured
into waves so four fleet seats never get handed two batches that will fight over the same file.
The wave-colouring half of this is a direct port of `computeWaves`/`selectBatches` in
`scripts/campaign/bugs.mjs` (on master since #597); the attach
half and the connected-component batching are new, given directly in the brief. Read
[DATA-MODEL.md](DATA-MODEL.md) for what a Batch issue is and
[CLAIMS-AND-LEASES.md](CLAIMS-AND-LEASES.md) for what "in flight" means mechanically.

## Inputs

- Every `ready` bug's `## Files` list (see [DATA-MODEL.md](DATA-MODEL.md)'s issue body template).
- Every **in-flight** batch — a Batch issue whose own claim is live and whose bugs are `claimed`
  or `in_progress`, not yet `in_review` — and the union of its sub-issues' Files.
- `bugflow.config.json`'s `hubFiles` (a static allow-list, e.g. `orders.service.ts`,
  `invoices.service.ts`, `routes.service.ts`, `schema.prisma`) and `batch.maxBugs` (default 4).
- The standing four-agent cap (the same `AGENT_CAP = 4` `bugs.mjs` uses, citing the house rule
  that a wave proposing more parallel batches than the fleet can run "is not a plan").

**Design note on hub files:** `bugs.mjs` computes its hub set *dynamically* — any file touched by
`hubThreshold` (default 10) or more open bugs is treated as shared surface, not a conflict,
because a god-file gets touched constantly and a naive shares-a-file rule found "no batch was EVER
parallel-safe." bugflow's `hubFiles` is a **static, config-provided list** instead — the brief's
own config schema calls for a plain list, not a threshold. This is a real simplification worth
naming: a repo that grows a new hot file has to add it to config by hand rather than have it
detected; the trade is a config a human can read and reason about, in exchange for needing to
notice when a new file deserves the label. Not a discrepancy to fix — the brief specifies the
static list deliberately — but worth knowing if hub coverage ever looks stale.

## Step 1 — Attach

For each `ready` bug not already parented: does its Files list share **at least one file** with an
in-flight batch's aggregate Files, **in the same area**? If yes, `gh issue edit --set-parent`
attaches it to that batch — the batch holder's next iteration picks it up (see
[CLAIMS-AND-LEASES.md](CLAIMS-AND-LEASES.md) for why the attached bug goes straight to the batch
holder's assignee + `status:claimed` rather than sitting at `ready` under a claimed parent). This is a same-area,
any-file-overlap rule — it does **not** exclude hub files the way the hard-conflict rule below
does, because attaching to a batch already touching a file is a much cheaper mistake than
scheduling two *separate* batches to touch it in parallel: at worst the batch holder finds one
extra bug already staged in their own working set.

Otherwise, the bug carries forward to Step 2 unattached.

## Step 2 — Group unattached bugs into batches

Build a graph over every remaining unattached `ready` bug: an edge between two bugs exists when
they share at least one **non-hub** file (`hubFiles` excluded, exactly `buildGraph`'s `hard` edge
rule in `bugs.mjs`). Take connected components:

- A component of size 1 (no hard-conflict edges to any other ready bug) **stays a standalone
  bug** — `plan` does not wrap a lone bug in a trivial one-bug Batch issue; it participates in
  wave-colouring individually and can be claimed directly (`bugflow claim #N`). This avoids
  parent-issue overhead for the common case of an isolated fix.
- A component of size ≥ 2 becomes a new Batch issue (`gh issue create --type Batch`), with every
  member `--set-parent`'d to it.
- A component larger than `batch.maxBugs` (4) is split: sort its members by severity rank, then
  issue number ascending (older first) — the same tie-break `bugs.mjs`'s `rankBatches` uses
  (worst severity first, then a deterministic second key) — and slice into chunks of `maxBugs`,
  each chunk becoming its own Batch. Because every chunk was cut from the **same** connected
  component, every pair of chunks still shares at least one non-hub file by construction — Step 3's
  wave colouring therefore always lands them in **different waves**, the same as any other
  hard-conflicting pair; the split never creates two chunks a fleet seat could safely run in
  parallel.

## Step 3 — Colour batches into waves

Rank every takeable unit (new batches, in-flight batches, and standalone bugs) worst-severity
first, then by size (bigger first), then by age (lower issue number first) — `bugs.mjs`'s
`rankBatches` order, adapted with issue-number age in place of a "batch name" string compare.
Greedily assign each to the lowest-numbered wave where (a) that wave isn't already at the 4-batch
cap, and (b) no unit already in that wave shares a non-hub file with it.

**In-flight batches are pre-coloured into wave 1, never deleted from the graph** — this is the
exact fix `bugs.mjs`'s own history records: "claiming F11 used to make F11↔F12 vanish, and `next`
then offered F12 to a second agent editing the same two web files." A busy batch occupies a cap
slot and keeps every hard conflict it carries, so a new batch sharing a non-hub file with it is
pushed to a later wave instead of being handed out in parallel alongside it. Cited as **L-069**
(process, #597) — the mechanism itself is confirmed independently by reading `computeWaves`'s own
source and comments, regardless of which lesson id names it.

`next` = the head of wave 1 among units that are unclaimed and takeable for the calling seat
(class ⊆ `seat.allowedClasses`) — the same reason `bugs.mjs next` returns "the head of wave 1, not
the head of a severity sort": the worst bug routinely hard-conflicts with whatever batch someone
is already in.

## Idempotency

Re-running `plan` with no new `ready` bugs and no batch having advanced past in-flight produces
the identical wave assignment — the ranking, the component/split ordering, and the colouring are
all deterministic functions of current facts, never of a memoized previous plan. Running `plan`
again after a batch finishes (leaves in-flight) needs no explicit "return" step either: the graph
is rebuilt fresh from current labels/parent-links each time, so a finished batch's former
conflicts simply re-enter the ranked pool on the next pass. This makes `plan` safe to run on a
schedule (a housekeeping Routine) rather than only by hand.

## Worked example — 7 bugs → 3 batches → 2 waves

Config's `hubFiles`: `orders.service.ts`, `invoices.service.ts`, `routes.service.ts`,
`schema.prisma`. Seven freshly-triaged, unattached `ready` bugs:

| Bug | Severity | Area | Files |
| --- | --- | --- | --- |
| #101 | critical | orders | `orders.service.ts`(hub), `order-templates.service.ts` |
| #102 | high | orders | `order-templates.service.ts`, `order-templates.controller.ts` |
| #103 | medium | orders | `order-templates.controller.ts`, `order-templates.dto.ts` |
| #104 | high | finance | `invoices.service.ts`(hub), `credit-notes.service.ts` |
| #105 | medium | finance | `credit-notes.service.ts`, `credit-notes.controller.ts` |
| #106 | critical | orders | `order-templates.service.ts`, `routes.service.ts`(hub), `route-optimization.service.ts` |
| #107 | low | orders | `route-optimization.service.ts`, `route-optimization.controller.ts` |

**Step 2 — components (non-hub shared files only):**

- `#101 — #102` share `order-templates.service.ts` → hard edge.
- `#102 — #103` share `order-templates.controller.ts` → hard edge. (`#101`/`#103` share nothing
  directly, but the component is connected transitively through `#102`.)
- `#104 — #105` share `credit-notes.service.ts` → hard edge.
- `#106 — #107` share `route-optimization.service.ts` → hard edge. `#106` **also** shares
  `order-templates.service.ts` with `#101`/`#102` → hard edge into that component too.

Three components: **{#101, #102, #103}**, **{#104, #105}**, **{#106, #107}** — each ≤ 4, so no
splitting. `plan` creates three Batch issues:

- **Batch #201** ({#101, #102, #103}), area orders, worst severity **critical**, 3 bugs.
- **Batch #202** ({#104, #105}), area finance, worst severity **high**, 2 bugs.
- **Batch #203** ({#106, #107}), area orders, worst severity **critical**, 2 bugs.

Cross-batch check: #201 and #203 both touch `order-templates.service.ts` (non-hub) → **hard
conflict, #201 ↔ #203**. #201/#203 also each touch a *different* hub file (`orders.service.ts`,
`routes.service.ts` respectively) — hub overlap is never a conflict, so that alone would not have
linked them even without the real edge above. #202 shares nothing with either.

**Step 3 — ranking and colouring (cap 4):** #201 and #203 tie on worst severity (critical); #201
wins the tie on size (3 bugs > 2), so ranks first. Order: **#201, #203, #202**.

- #201 (rank 1) → wave 1.
- #203 (rank 2): hard-conflicts with #201, which already occupies wave 1 → pushed to **wave 2**.
- #202 (rank 3): no conflict with #201 → fits in **wave 1** alongside it (wave 1 now holds 2 of 4
  cap slots).

**Result: wave 1 = {Batch #201, Batch #202}; wave 2 = {Batch #203}.** `next` (for an unclaimed,
`agent-safe`-only fleet seat) returns Batch #201 — the higher-ranked of the two wave-1 batches —
unless a seat filter or an existing claim on #201 has already moved past it, in which case #202.

A bug arriving later that touches `order-templates.dto.ts` would **attach** to Batch #201 if that
batch is still in flight (Step 1); a bug touching an unrelated file in a different area starts its
own fresh component on the next `plan` run instead.

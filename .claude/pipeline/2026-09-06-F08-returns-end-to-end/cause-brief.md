# Cause brief — B53 B68 B69 B82 B20 B61 B166 B75 B128 B21 (F08 returns end-to-end)

All line numbers below are verified against this worktree (`fix/F08-returns-end-to-end`,
at master `597c72dc`, which already carries #636/F09) on 2026-09-06. `apps/api/src/returns/
returns.service.ts` is 511 lines total (was ~450 when B53/B68/B69's evidence lines were cited).

---

## B53 — Returns validate/restock/refund against ORDERED qty, ignoring deliveredQty (and the refund basis is order-line, not invoice)

### The bug as stated

**Source (B53.md, "Actually does"):** "create()'s cumulative cap reads `orderedQty =
Number(orderLine.qty)` — deliveredQty appears nowhere in the module... receive() restocks
the full returned qty unconditionally, and processRefund computes refund = item.qty *
(line.subtotal / line.qty) from the order line, not the invoice." And ("The gap"):
"processRefund's credit-note cap is keyed on `ret.order.invoices` with no status filter: any
order carrying 2+ Invoice rows (of any status, VOID included) passes invoiceId undefined."

**Committed plan's root cause (F08.md), as a claim:** "processRefund (returns.service.ts:331-339)
prices the refund as Σ qty × (orderLine.subtotal / orderLine.qty) from Order.lineItems, never
from the invoice that was actually issued... Second, :318 selects `invoices: { select: { id } }`
with no status filter and :369-372 passes invoiceId only when exactly one row exists." The plan
explicitly REFUTES the register's suggested `min(orderedQty, deliveredQty)` cap: "deliveredQty is
written by only one of the three DELIVERED writers... so deliveredQty is 0 for most delivered
orders."

**Repro (still true on this tree):** order line qty 10 / subtotal 100 (effective per-unit 10);
customer actually billed only 60 (a 6-of-10 delivered-basis invoice, per
`returns-refund.spec.ts:47-98`'s own fixture pattern) → return qty 10 → `processRefund` mints
refundAmount **100** (line 346: `refundAmount += Number(item.qty) * perUnit` where perUnit comes
from `ret.order.lineItems`, never from `ret.order.invoices[].items`) — expected 60. The exact
wrong value the repro test must fail on: **refundAmount / creditNotesCreate `amount` = 100 when
the billed basis is 60** (test literally asserts `dto.amount).toBe(20)` today for its own
2-of-10-ordered fixture at line 76 — that assertion itself encodes the ordered-basis formula and
must change to assert the billed-basis figure once `billedBasisFor` lands).

### Code path

- Entry: `POST /returns/:id/refund` → `returns.controller.ts:86-88` → `ReturnsService.processRefund`.
- `returns.service.ts:312-332` — the `findUnique` select. **This select has ALREADY changed since
  the plan was written** (see History): it now filters
  `invoices: { where: { status: { notIn: CREDIT_SOURCE_EXCLUDED } }, select: { id: true } }`
  (lines 324-327) — VOID/WRITTEN_OFF invoices are excluded from the set the refund basis sees.
  This closes HALF of B53's "Evidence" claim (":316-318, no status filter") but does **not**
  touch the refund-amount math.
- `returns.service.ts:340-348` — the refund-amount loop, unchanged, still order-line-only:
  ```
  340   let refundAmount = 0;
  341   for (const item of ret.items ?? []) {
  342     const line = ret.order?.lineItems?.find((li) => li.productId === item.productId);
  343     if (!line) continue;
  344     const lineQty = Number(line.qty);
  345     const perUnit = lineQty > 0 ? Number(line.subtotal) / lineQty : Number(line.unitPrice);
  346     refundAmount += Number(item.qty) * perUnit;
  347   }
  348   refundAmount = roundMoney(refundAmount);
  ```
  This never reads `ret.order.invoices[].items` — the invoice basis the plan's `billedBasisFor`
  helper is supposed to introduce does not exist anywhere in the file (`grep billedBasisFor`
  returns nothing).
- `returns.service.ts:378-384` — the invoiceId selection, unchanged from the plan's citation
  (only the variable `invoices` now comes from the filtered select above):
  ```
  378   const invoices = ret.order?.invoices ?? [];
  379   const cn = await this.creditNotes.create({
  380     customerId: ret.customerId,
  381     invoiceId: invoices.length === 1 ? invoices[0].id : undefined,
  ```
  So a 2-non-VOID-invoice order still mints `invoiceId: undefined` and reaches
  `credit-notes.service.ts`'s cap gate (`if (dto.invoiceId)`, line 112) not at all — the cap is
  skipped, exactly as the plan describes, for the "2+ live invoices" case. (The "any-status
  invoices, VOID included" variant of this same gap is now closed by the status filter above.)
- `create()`'s cap (returns.service.ts:110-116) is **unchanged and NOT touched by this plan** —
  confirmed still `orderedQty = Number(orderLine.qty)`, no `deliveredQty` reference anywhere in
  the file (`grep deliveredQty returns.service.ts` → no matches). Per the plan this is
  deliberate, not a regression: `apps/api/src/routes/routes.service.ts` (read-only for F08, per
  SEQUENCE.md R2) is where `deliveredQty` is written, and only by `completeWithPayment` (cited
  at :2346 by the plan; not independently re-verified here since F08 must not read/edit that file
  beyond the hand-off finding already recorded in SEQUENCE.md R2/§1).
- Unrelated dead code noticed in `create()`: the order fetch at line 59 selects
  `invoices: { select: { id: true } }` but the field is never referenced anywhere in `create()`'s
  body (`grep -n "order.invoices\|(order as any).invoices"` in this file returns 0 hits) — inert,
  not cited by the plan, flagged for S2 as a possible simplification, not a bug in scope.

### History

```
git log --oneline -5 -- apps/api/src/returns/returns.service.ts
151c3f70 fix(api,web,mobile): credit-note wallet integrity (f09 b66 b67 b18 b19) (#636)
22372911 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
ea8a7479 fix(api): tenant-scope findUnique sweep — cross-tenant read isolation (#446)
1fd21f12 fix: deep-dive backlog B4-B14 — 2 security holes, 2 money bugs, 3 races (#373)
355757aa feat: batch of 11 client-reported fixes and features
```

`git blame -L 315,335` shows the `invoices: { where: { status: { notIn: CREDIT_SOURCE_EXCLUDED
} } }` block (lines 319-327) was added 2026-09-06 03:41:42 by commit `151c3f70` (#636, "F09"),
today, landing AFTER the F08.md plan and the corrections doc were written. The surrounding lines
(refund-amount loop, invoiceId ternary) are untouched by that commit and trace back further
(order-line select itself: `59ab9d8c1`, 2026-07-14, "Credits wallet + auto-apply oldest-first
(P5-13) #256"). `git blame -L 85,121` (the create() cap) shows the cumulative-qty logic was last
touched by `1fd21f12` (2026-08-20, #373 "deep-dive backlog B4-B14") — a different commit from the
one that touched the refund path — `deliveredQty` was never introduced there.

### Existing tests around this behavior

- `returns-refund.spec.ts` (376 lines) is the ONLY spec covering `processRefund`. All 9 of its
  `describe`/`it` fixtures already carry the filtered-invoices shape (`invoices: [{ id: "inv-1"
}]`, or `invoices: []` for the new "F09 A2" case at lines 123-160) — none of the order fixtures
  carry `invoices[].items`, so `billedBasisFor`'s invoice-item path has NOTHING to read yet in
  any current fixture; every one would fall to the "legacy" order-line branch as currently
  written, UNLESS the fix's own new fixtures add `items` (per F08.md's Fix step 1's fallback
  rule: "fall back to the existing order-line math ONLY when the order has zero Invoice rows of
  any status").
- Line 47-98 ("no body: defaults to CREDIT_NOTE...") **pins the ordered-basis wrong value**:
  asserts `dto.amount).toBe(20)` for return qty 2 against an order line qty 10/subtotal 100 (no
  invoice items in the fixture) — this is exactly the register's "6-of-10 billed, 10-of-10
  refunded" shape in miniature and must be updated (or given a matching invoice-items fixture) to
  fail on the wrong value once `billedBasisFor` lands.
- Line 100-121 ("omits invoiceId when the order has 2+ invoices") **pins the "skip the cap
  instead of computing headroom" wrong behavior** — asserts `dto.invoiceId).toBeUndefined()` with
  no assertion on a headroom check; per the plan this must become a rejecting case (3rd sub-test:
  "cap against combined total... throw BadRequestException") once the 2+-invoice headroom logic
  lands.
- Line 123-160 ("F09 A2: refund against a voided source") is a NEW test that landed with #636
  today — it is NOT in the plan's Test section and is UNAFFECTED by B53's fix (it exercises the
  zero-live-invoices branch, which already takes the same "undefined invoiceId" path the 2+-
  invoice case does).
- `returns-overreturn.spec.ts` fixture `order.lineItems` (line 45: `{ productId: "p1", qty: 10,
unitPrice: 5 }`, no subtotal/invoices needed there since it only exercises `create()`, not
  `processRefund`) is unaffected by B53.

### Production evidence (if any)

None available to this agent (read-only, no DB/prod access). The plan records this as a D4
class (over-refunded Returns are identifiable post-deploy via a dry-run report) — no ids/amounts
were supplied in any input file.

### Open unknowns

- The corrections doc (§5, §7) says F09 (commit `151c3f70`, now landed, not "in flight" as the
  correction anticipated) added `status: true` to the credit-notes.service.ts invoice select and
  a `CREDIT_SOURCE_EXCLUDED` throw at lines 133-139 (confirmed present, see `credit-notes.service.ts:112-151`
  read directly) but did **not** touch the cap arithmetic (lines 141-151) — S2 should re-confirm
  the 2+-invoice headroom design against this exact, now-landed code rather than the pre-#636
  version the plan cites.
- `billedBasisFor` does not exist anywhere in the codebase yet (verified via grep) — S2 must
  build it fresh, and per corrections §7, `findOne`'s `refundEstimate` (lines 499-507, see B75
  below) computes the IDENTICAL Σqty×(subtotal/qty) loop and must call the same helper, not fork
  it.
- Plan cites `processRefund` math at "returns.service.ts:331-339"; on this tree the equivalent
  loop is at **:340-348** (a 9-line shift, from the F09 invoice-select comment block added at
  lines 319-327). Plan cites the invoices select at "returns.service.ts:315-321" / "invoiceId
  ternary at :369-376"; on this tree these are **:312-332** (select) and **:378-384** (ternary).
  Plan cites `findOne`'s select at "returns.service.ts:454-459"; on this tree `findOne` begins at
  line 459 and its select is at **:460-473** (see B75 section for exact lines).
- Whether the already-landed VOID/WRITTEN_OFF filter on the `processRefund` select (lines 324-327)
  changes any of B53's three REG-B53 sub-tests' expected mocks (the plan's sub-test (b) uses
  `invoices: [{id: inv-1, status: VOID}, {id: inv-2}]` — under the NEW code this fixture would
  never reach the service as-is, since the select itself filters VOID at the DB/mock level; S2
  must rewrite that sub-test's fixture to supply already-filtered `invoices: [{id: inv-2}]`
  matching the real select shape, not a two-row list including a VOID one).

---

## B68 — processRefund claims REFUNDED before minting the credit note, non-transactionally, unrecoverable on failure

### The bug as stated

**Source (B68.md, "Actually does" / "The gap"):** "processRefund claims the transition with a
non-transactional updateMany that also persists refundMethod/refundAmount/refundedAt, then calls
creditNotes.create() in its own separate Serializable transaction... Nothing links the claim to
the mint. A cap rejection... or a crash between the two leaves the return permanently REFUNDED
with creditNoteId null."

**Committed plan's root cause (F08.md), as a claim:** "processRefund claims RECEIVED→REFUNDED
with a non-transactional updateMany that also persists refundMethod/refundAmount/refundedAt
(returns.service.ts:347-355), then calls creditNotes.create() in its own Serializable transaction
(:370-375, 'Sequential, NOT nested')... Nothing links claim to mint... a failed mint strands the
row permanently."

**Repro:** claim `updateMany` resolves `{count:1}` (status flips RECEIVED→REFUNDED,
refundMethod/refundAmount/refundedAt persisted) → `creditNotes.create` throws (e.g. the B53 cap,
or F09's `CREDIT_SOURCE_EXCLUDED` guard) → expected: the return reverts to RECEIVED so
`processRefund` is retryable; observed on this tree: the throw propagates with NO compensating
write — `prisma.return.update` (or a second `updateMany`) is never called, so the return is
stranded at REFUNDED with `creditNoteId` still null. The exact wrong value: **zero calls to any
compensating `return.updateMany`/`update` after a `creditNotes.create` rejection** (today there
is exactly ONE status-changing write in the whole function on the reject path — the original
claim — confirmed by reading the full function body below).

### Code path

- Entry: same as B53 — `POST /returns/:id/refund` → `processRefund`.
- `returns.service.ts:356-367` — the atomic claim (persists status/refundMethod/refundAmount/
  refundedAt in one write):
  ```
  356   const claimed = await this.prisma.forTenant().return.updateMany({
  357     where: { id, status: "RECEIVED" },
  358     data: {
  359       status: "REFUNDED",
  360       refundMethod: method,
  361       refundAmount,
  362       refundedAt: new Date(),
  363     },
  364   });
  ```
- `returns.service.ts:375-384` — the comment ("Sequential, NOT nested") and the mint, with NO
  try/catch:
  ```
  375   // Sequential, NOT nested: create() opens its own Serializable tx and books NO
  ...
  379   const cn = await this.creditNotes.create({ ... });
  385   await this.prisma.forTenant().return.update({ where: { id }, data: { creditNoteId: cn.id } });
  ```
  If `this.creditNotes.create(...)` at line 379 throws, execution leaves the function
  immediately — line 385 (the `creditNoteId` linkage write) never runs, and there is no catch
  block anywhere in `processRefund` to revert the claim made at line 356-364. Confirmed by
  reading the complete function body (lines 309-388): there is exactly one `try`/`catch` in the
  entire file and it is not in this function (none found via grep of the file for `catch`).
- `returns.service.ts:325-326`-equivalent (re-entry guard): `ret.status !== "RECEIVED"` throw at
  line 334-335 blocks any retry once the return is stuck at REFUNDED.
- `cancel()` (line 407-408) explicitly refuses REFUNDED: `if (ret.status === "REFUNDED") throw
new BadRequestException("Refunded returns cannot be cancelled")` — confirming there is no
  recovery path via cancel either.

### History

Same commit history as B53 (same file, overlapping region). `git blame` on lines 356-388 was not
separately re-run beyond the whole-function read above; the claim-then-mint shape (with the
"Sequential, NOT nested" comment) predates F09's #636 changes, which only touched the `invoices`
select a few lines above this block (see B53 History) — F09 did NOT add or remove any try/catch
around the mint.

### Existing tests around this behavior

- `returns-refund.spec.ts` has NO test where `creditNotesCreate` is mocked to reject
  (`creditNotesCreate.mockRejectedValue` does not appear anywhere in the file — confirmed by
  reading the full file above). Every existing test's `creditNotesCreate.mockResolvedValue(...)`
  always succeeds, so today's suite never exercises this path at all — there is no "pinned wrong
  behavior" test to invert; this is a pure coverage gap, matching the plan's own note
  ("returns-refund.spec.ts has no test for a create() failure after a successful claim" — B68.md
  Evidence line).

### Production evidence (if any)

None available to this agent. Plan flags this as D4-repairable (identifiable via `status
REFUNDED, refundMethod CREDIT_NOTE, refundAmount > 0, creditNoteId null`), post-deploy, dry-run
first.

### Open unknowns

- Plan cites the claim at "returns.service.ts:347-355" and the create call at ":370-375"; on this
  tree these are **:356-367** (claim) and **:375-384** (comment+create) — the same ~9-line shift
  as B53, from the same F09 comment-block insertion above.
- B53's fix (billed basis + headroom check) will change WHICH calls to `creditNotes.create`
  reject and why (today only the flat cumulative-invoice-total cap or F09's CREDIT_SOURCE_EXCLUDED
  guard can reject; after B53, a headroom-exceeded throw is a new rejection path B68's
  compensating catch must also cover) — S2 should design the catch to compensate on ANY throw
  from `creditNotes.create`, not enumerate specific exception types.
- The plan's optional "re-entry when status REFUNDED && creditNoteId null" hardening is explicitly
  marked optional in F08.md; not evaluated further here.

---

## B69 — cancel() decides the stock/ledger undo from a stale pre-transaction read, racing receive()

### The bug as stated

**Source (B69.md, "Actually does" / "The gap"):** "cancel() reads the return with a plain
findUnique OUTSIDE any transaction. Inside the transaction it atomically claims → CANCELLED for
any status not in [CANCELLED, REFUNDED]... but the undo branch tests the STALE status captured
before the transaction opened... If receive() commits between cancel()'s pre-tx read (still
APPROVED) and its claim, the claim wins but the undo is skipped on the stale snapshot."

**Committed plan's root cause (F08.md), as a claim:** "cancel() reads the return with a plain
forTenant().findUnique OUTSIDE the transaction (returns.service.ts:382-385). Inside the tx the
claim updateMany matches any status notIn [CANCELLED, REFUNDED] (:406-409)... but the undo branch
tests the closed-over stale `ret.status` (:414) and iterates the stale `ret.items` restock flags
(:416-417)."

**Repro:** cancel() is called while the return is APPROVED (pre-tx read caches `ret.status =
"APPROVED"`); concurrently, `receive()` commits (RECEIVED, with a restock decision already
persisted). cancel()'s claim `updateMany` at line 415-418 matches (WHERE status NOT IN
[CANCELLED, REFUNDED] — RECEIVED matches this) and flips to CANCELLED. The undo condition at line
423 (`if (ret.status === "RECEIVED" || ret.status === "PROCESSED")`) evaluates the STALE
closed-over `ret.status`, which is still `"APPROVED"` — **false** — so the entire undo block
(stock decrement, StockMovement delete, ledger un-reverse) is skipped. Expected: the undo should
run because the return WAS actually RECEIVED (with stock/ledger effects in force) at the moment
of cancellation. Exact wrong value: **zero calls to `tx.product.update`, `tx.stockMovement.deleteMany`,
and `ledger.unreverseReturnEntries`** when the true committed status was RECEIVED.

### Code path

- Entry: `POST /returns/:id/cancel` → `returns.controller.ts:92-93` → `ReturnsService.cancel`.
- `returns.service.ts:390-394` — the OUTSIDE-transaction read:
  ```
  390   async cancel(id: string, user: JwtPayload) {
  391     const ret = await this.prisma.forTenant().return.findUnique({
  392       where: { id },
  393       include: { items: true },
  394     });
  ```
- `returns.service.ts:415-421` — the in-tx claim, matching any non-terminal status:
  ```
  415       const claimed = await tx.return.updateMany({
  416         where: { id, status: { notIn: ["CANCELLED", "REFUNDED"] } },
  417         data: { status: "CANCELLED" },
  418       });
  ```
- `returns.service.ts:422-440` — the undo, gated on the STALE closed-over `ret`:
  ```
  422       // Reverse stock movements if items were already received into stock
  423       if (ret.status === "RECEIVED" || ret.status === "PROCESSED") {
  424         const returnRef = `RET-${ret.id.slice(0, 8)}`;
  425         for (const item of ret.items) {
  426           if (item.restock) {
  427             await tx.product.update({ ... decrement ... });
  428           }
  429           await tx.stockMovement.deleteMany({ ... });
  430         }
  431         await this.ledger.unreverseReturnEntries({ returnId: ret.id, db: tx });
  432       }
  ```
  Both the branch condition (`ret.status`) and the iterated collection (`ret.items`, whose
  `restock` flags may since have been rewritten by `receive({restock:false})`'s
  `tx.returnItem.updateMany` at line 258) are stale.
- Comment at line 413 ("The RECEIVED/PROCESSED undo below is idempotent-safe under
  RECEIVED↔PROCESSED staleness") documents awareness of a DIFFERENT (non-existent) race —
  confirmed `PROCESSED` has no writer anywhere in this file or its callers (only appears as a
  legacy status string in the condition and in `ReturnStatus` type unions on the client side) —
  matching the plan's/register's "verifier's note" that this comment guards a transition that
  never occurs while the real APPROVED→RECEIVED race is unaddressed.

### History

`git blame -L 390,443`: the claim-guard pattern (`b78668d54`, 2026-06-18, "enforce tenant &
object-level authz scoping #84") post-dates the original cancel()/undo logic (`48f42457e`,
2026-04-01, and `da5e89faa`/`41ab2803c`, slightly earlier in 2026-03/04) which is where the
stale-`ret.status` undo branch originates; the ledger `unreverseReturnEntries` call (`66f33460`,
2026-07-08, "regulated: Phase 4 W5a–W6a") was layered on top of the pre-existing stale-status
gate without changing its condition. No commit has re-read the return inside the transaction at
any point in this file's history (confirmed: `tx.return.findUnique` does not appear anywhere in
`returns.service.ts` today — `cancel()`'s only in-tx reads are the `updateMany` claim and the
final `tx.return.findUnique({ where: { id } })` used purely as the RETURN VALUE at line 441,
which happens AFTER the (already-skipped) undo decision and so cannot fix it retroactively).

### Existing tests around this behavior

- `returns-refund.spec.ts` has no cancel()-specific race test.
- `returns-ledger.spec.ts:61-89` has two directly relevant cases:
  - Lines 61-75 ("cancel() of a RECEIVED return un-reverses the ledger"): mocks the single
    `prisma.return.findUnique` (used both for the outer pre-tx read AND, via the default
    `tenantTransaction` mock which spreads the SAME `models` object as `tx`, for any in-tx read)
    to RECEIVED and asserts `ledger.unreverseReturnEntries` is called — passes today because the
    stale and fresh reads are the same mock value, so this test does NOT discriminate the bug.
  - **Lines 77-89 ("cancel() of a not-yet-received return does NOT touch the ledger") is the test
    that pins today's (arguably correct-by-coincidence, single-mock) behavior**: mocks the OUTER
    `prisma.return.findUnique` to `status: "APPROVED"` and asserts `unreverseReturnEntries` is
    NOT called. Because `createMockPrisma`'s default `tenantTransaction` mock spreads the exact
    same `models` object in as `tx` (confirmed by reading `apps/api/src/testing/prisma-mock.ts:
218-229`: `forTenant: jest.fn().mockReturnValue(models)`, `tenantTransaction: jest.fn((fn) =>
fn({ ...models, ... }))`), a fresh `tx.return.findUnique()` call added inside `cancel()`
    would, in THIS specific test, resolve to the SAME `"APPROVED"` mock value as the outer read —
    so this particular fixture happens not to distinguish stale-vs-fresh reads either way. The
    corrections doc (§6) nonetheless states this fixture "must gain its own return.findUnique, or
    the test breaks/crashes once the fix lands" — not independently reproduced by this read-only
    pass; flagged as an open unknown below for S2 to verify against the exact fix shape once
    written (e.g. if the fix calls `tx.return.findUnique(... include: { items: true } ...)` and
    the existing mock's return value lacks `items` in a way the new code dereferences, or if a
    `$executeRaw` FOR UPDATE call added to `cancel()`'s tx has no default mock in this file since
    `returns-ledger.spec.ts` never sets up `$executeRaw` — the default `tenantTransaction` mock
    (prisma-mock.ts:227) DOES provide `$executeRaw: jest.fn().mockResolvedValue(0)` unconditionally,
    so a bare `FOR UPDATE` call should not crash on its own).
- `returns-overreturn.spec.ts` does not touch `cancel()`.

### Production evidence (if any)

None available. Plan/register record this race as unrepairable after the fact (D4).

### Open unknowns

- Plan cites `:381-385` (outer read), `:406-412` (claim), `:414-431` (undo); on this tree these
  are **:390-394** (outer read), **:415-421** (claim), **:422-440** (undo) — roughly a 9-line
  shift, consistent with the same upstream insertion pattern seen in B53/B68 (the file has grown
  by other, unrelated changes between when the plan's citations were taken and now — the exact
  source of the shift was not traced further since it is not required to locate the current
  lines, which were independently re-derived by reading the file directly).
- Corrections doc (§6) names `returns-ledger.spec.ts:77-89` as needing its own in-tx mock; whether
  it will actually crash, silently pass, or need a new assertion depends on the exact shape of
  B69's fix (S2 decision, not yet written) — treat the correction's claim as unverified-but-
  credible pending the actual diff.
- The dead `|| status === 'PROCESSED'` comment/branch (line 423, 413) — plan says "leave or drop,
  note it"; no further evidence gathered here since it is explicitly out of scope either way.

---

## B82 — CANCELLED returns permanently consume the order's returnable quota

### The bug as stated

**Source (B82.md, "Actually does" / "The gap"):** "The cumulative-quota query filters `status: {
not: 'REJECTED' }`, which includes CANCELLED, and sums those quantities into alreadyReturned...
cancel() fully reverses a return's stock decrement and ledger entries, making the goods
legitimately re-returnable, but the CANCELLED row keeps consuming the quota — and there is no way
to clear it."

**Committed plan's root cause (F08.md), as a claim:** "The cumulative-quota query at
returns.service.ts:87-90 filters `status: { not: 'REJECTED' }`, so CANCELLED returns still add to
alreadyReturned (:93-98) and shrink `remaining` (:111)."

**Repro:** order line qty 10; a prior return of qty 10 is CANCELLED (fully reversed — stock,
StockMovement and ledger all undone by `cancel()`); a NEW return request for qty 10 on the same
line → expected: allowed (0 already legitimately outstanding) → observed: rejected with
`BadRequestException` ("Return qty (10) exceeds remaining returnable qty (0)...") because the
CANCELLED return's qty 10 is still summed into `alreadyReturned`. Exact wrong value: **`remaining`
computed as `orderedQty(10) - previouslyReturned(10) = 0`** when the true legitimately-outstanding
total is 0-returned-in-force, i.e. `remaining` should be **10**.

### Code path

- Entry: `POST /returns` → `returns.controller.ts:26-28` → `ReturnsService.create`.
- `returns.service.ts:88-91` — the quota query, still `not: "REJECTED"` (CANCELLED included):
  ```
  88        where: { orderId: dto.orderId, status: { not: "REJECTED" } },
  89        include: { items: { select: { productId: true, qty: true } } },
  ```
- `returns.service.ts:94-99` — the sum into `alreadyReturned`, unconditional per row returned by
  the query above (no per-row status branch, so CANCELLED rows contribute their full qty).
- `returns.service.ts:110-116` — `remaining = orderedQty - previouslyReturned` and the throw when
  the new request exceeds it.
- `returns.service.ts:415-440` (see B69 above) confirms `cancel()` DOES fully reverse stock (when
  `item.restock`), delete the `StockMovement` rows, and un-reverse the ledger for a RECEIVED
  return — i.e. a CANCELLED return genuinely has zero effects "in force," making the quota
  question purely a filter-scope bug, not a deeper double-accounting issue.
- No `@Delete` route exists on `returns.controller.ts` (confirmed by reading the full controller
  above — only POST/GET routes). `deleteOrder`'s return-count guard was not independently
  re-verified in `orders.service.ts` in this pass (out of scope for F08 per the plan; cited by
  B82.md only as supporting color for "there is no way to clear it").

### History

`git blame -L 85,121` shows this whole cumulative-quota block was rewritten by `1fd21f12`
(2026-08-20, #373 "deep-dive backlog B4-B14 — 2 security holes, 2 money bugs, 3 races") — the
commit that introduced the transaction + FOR-UPDATE lock + per-payload running-total guard (see
the file's own comments at lines 74-84, 117-121 crediting that fix). The `status: { not:
"REJECTED" }` filter itself predates that rewrite (present before #373 per the surrounding
unchanged `f5b8f97dd`/`dfdb4419d` blame hunks at lines 86, 99-100, 107) and was carried forward
unchanged by #373 — i.e. the over-return race fix (#373) and this quota-scope bug are unrelated
issues that happen to sit in the same function.

### Existing tests around this behavior

- `returns-overreturn.spec.ts:99-114` ("ignores a REJECTED return's qty when computing remaining")
  **pins the exact wrong where-clause as a positive assertion**:
  ```
  110       expect(txReturn.findMany).toHaveBeenCalledWith({
  111         where: { orderId: "ord-1", status: { not: "REJECTED" } },
  112         include: { items: { select: { productId: true, qty: true } } },
  113       });
  ```
  This is a literal `toHaveBeenCalledWith` on the CURRENT (buggy, CANCELLED-inclusive) where
  clause — per F08.md's own Test section, this is the exact assertion that must change to
  `status: { notIn: ["REJECTED", "CANCELLED"] } }` for REG-B82, and it will go RED (revert-red)
  the moment the fix's where-clause differs from what this test currently expects — i.e. today,
  BEFORE any fix, this test is GREEN and encodes the bug as correct behavior.
- The rest of `returns-overreturn.spec.ts` (lines 72-97, 136-215) tests other over-return
  variants and does not touch CANCELLED rows at all.

### Production evidence (if any)

None available. Not flagged sensitive/money in B82.md (severity: medium, sensitive: false).

### Open unknowns

- None beyond the general staleness caveat — B82's citations (returns.service.ts:87-90, :93-98,
  :401-433 for cancel(); orders.service.ts:4720-4726 for deleteOrder) are close to current
  (:88-91, :94-99, :415-440 respectively — the B69-consistent ~9-14 line shift); `orders.service.ts`
  was not independently re-read in this pass since B82's fix (per F08.md) touches ONLY
  `returns.service.ts:88`, and the `orders.service.ts` citation is explicitly "out of scope" per
  F08.md's own Notes ("deleteOrder's unfiltered returnCount... is a separate ergonomics issue").

---

## B20 — Return condition/notes vanish on save

### The bug as stated

**Source (B20.md, "Actually does"):** "ReturnItem has no condition or notes column; returns.service.ts
create() maps only productId/qty/reason/restock into the item write, dropping dto.items[].notes;
detail pages render item.condition/item.notes, always blank."

**Committed plan's root cause (F08.md), as a claim:** "F01 (#548, migration
20260908000000_campaign_schema_foundation) added ReturnItem.condition and ReturnItem.notes
(schema.prisma:2712-2716, comment 'F01/B20') but the nested create map at returns.service.ts:133-139
still writes only productId/qty/reason/restock/tenantId, so dto.items[].notes... is dropped."

**Repro:** web create-modal sends `items: [{ productId, qty, notes: "dented case" }]` (confirmed
at `returns/page.tsx:174-178`, no `condition` field sent by any client) → `create()`'s nested
`items.create` map writes only `productId/qty/reason/restock/tenantId` → the persisted
`ReturnItem` row has **`notes: null`** (Prisma column default, since the field is never included
in the create payload) → detail page (`[id]/page.tsx:650`) falls to its `—` placeholder. Exact
wrong value: **the created `ReturnItem.notes` field is absent from the `data.items.create[...]`
object passed to Prisma** (verified: the object literal at lines 134-140 below has no `notes` or
`condition` key at all — not even `undefined`).

### Code path

- Entry: same `create()` path as B82/B69.
- `returns.service.ts:133-141` (the nested create map — corrections §3 confirmed target):
  ```
  133         items: {
  134           create: dto.items.map((i: any) => ({
  135             productId: i.productId,
  136             qty: i.qty,
  137             reason: i.reason,
  138             restock: i.restock ?? true,
  139             tenantId: this.prisma.getTenantId(),
  140           })),
  141         },
  ```
  No `condition`/`notes` key anywhere in this object.
- Schema: `apps/api/prisma/schema/sales.prisma:987-1008` — the `ReturnItem` model, confirmed to
  carry both columns already:
  ```
  987   model ReturnItem {
  ...
  992     qty       Decimal @db.Decimal(10, 3)
  993     reason    String?
  994     restock   Boolean @default(true)
  995     // F01/B20: the per-item "Condition / notes" the operator types at return
  996     // creation — previously collected by the form and silently dropped.
  996     condition String?
  997     notes     String?
  998     tenantId  String?
  ```
  (Per corrections §3: the SINGLE-FILE `apps/api/prisma/schema.prisma` path B20.md's frontmatter
  cites is DEAD — the schema is the folder `apps/api/prisma/schema/*.prisma`; `ReturnItem` lives
  in `schema/sales.prisma`, confirmed above, not the file B20.md's `files:` list names.)
- Web send side: `apps/web/app/(dashboard)/returns/page.tsx:174-178` confirmed sends
  `{ productId, qty, notes }` (no `condition`) — matches F08.md's decision that no web change is
  needed.
- Web render side: `apps/web/app/(dashboard)/returns/[id]/page.tsx:644-650` confirmed renders
  `item.condition` / falls to `—` when both `condition` and `notes` are falsy.

### History

`git log --oneline -5 -- apps/api/prisma/schema/sales.prisma` was not run in this pass (not
required — the file and its F01/B20 comment were read directly and match the plan's description
verbatim); the nested-create map in `returns.service.ts` traces to the same `1fd21f12` /
earlier commits as the rest of `create()` (no separate history run for this specific 8-line
block since its shape — missing keys — is directly legible from the current file with no
ambiguity).

### Existing tests around this behavior

- No existing test in `returns-overreturn.spec.ts` or elsewhere asserts on the shape of
  `txReturn.create`'s `data.items.create[...]` payload beyond quantities (`qty`) implicitly via
  fixture returns — none of the current tests check for `notes`/`condition`/`reason` keys at all.
  This is a pure coverage gap; REG-B20 is a wholly new test, not an inversion of an existing
  pinned assertion.

### Production evidence (if any)

None available.

### Open unknowns

- None — B20 is fully confirmed and self-contained on this tree; no staleness found in the
  plan's citations for this bug specifically (its `returns.service.ts:133-139` citation is now
  **:133-141** — inclusive of the closing brace/comma lines — a cosmetic, not substantive, shift).

---

## B61 — Driver/web-filed returns default to restock:true regardless of reason (Damaged/Quality goods restocked)

### The bug as stated

**Source (B61.md, "Actually does" / "The gap"):** "The driver screen maps rows to {productId,
qty, reason} with no `restock` key; the server defaults `restock: i.restock ?? true`; the
office's normal 'Mark Received' sends a bare id and restocks every item whose flag is true — i.e.
all of them... The reason label never reaches the restock decision."

**Committed plan's root cause (F08.md), as a claim:** "Driver screen items carry no restock key
(driver return/index.tsx:94-100); the web create modal ALSO sends none (returns/page.tsx:174-178
— register missed this sibling); the server defaults `restock: i.restock ?? true`."

**Repro:** a driver or web operator files a return with `reason: "DAMAGED"` and no `restock` key
in the item payload → `create()`'s nested map at line 138 evaluates `i.restock ?? true` →
`restock: true` is persisted → `receive()` (default path, `opts?.restock !== false`) restocks the
damaged goods into sellable inventory at lines 260-286. Exact wrong value: **persisted
`ReturnItem.restock === true`** for a DAMAGED-reason item when the correct default (per the
plan's policy table) is `false`.

### Code path

- Entry: same `create()` as B20, specifically line 138: `restock: i.restock ?? true,` — confirmed
  present verbatim, no reason-aware logic anywhere in `create()`.
- Driver payload: `apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx` — `issue()`'s
  item-building at line 98 (`qty: Math.round(Number(m.quantityDelivered ?? 0))`) was confirmed to
  exist near the plan's cited region; the absence of any `restock` key in that object was
  confirmed by grep (`restock` does not appear in this file at all — 0 matches for the string
  `restock` in the whole file, confirmed via the earlier targeted grep which found no `restock`
  hits alongside `quantityDelivered`/`issue(`/`returnRowsFromStop`/`qty:`).
- Web payload: `apps/web/app/(dashboard)/returns/page.tsx:174-178` — confirmed (see B20) sends
  only `{ productId, qty, notes }`, no `restock` key, matching the plan's corrections §9 point
  that this is NOT mobile-only.
- Office receive: `returns.service.ts:253-287` — `receive()`'s branch when `opts?.restock !==
false` iterates `ret.items` and restocks every item where `item.restock` is truthy (confirmed
  read above under B69's code-path section) — i.e. once `restock: true` is persisted at create
  time, `receive()` has no per-item override; only the ALL-or-nothing `opts.restock === false`
  path (driven by the web's "Resolve without receiving" control, per the plan) suppresses
  restocking, and only for every item at once.
- Mobile operator counter-example (per plan, confirmed by the existence of `buildReturnItems` in
  `apps/mobile/lib/returns-logic.ts:58-75`, read above): this helper DOES thread a per-line
  `restockByProduct` map through into the payload (`restock: restockByProduct[li.productId] ??
true`) — so the operator-authored path already sends an explicit flag; only the driver and web
  paths are missing one, confirming the plan's framing ("Only the mobile operator new.tsx sends
  an explicit per-line flag").

### History

Not independently re-run for this bug beyond what B20's history section already covers (same
`create()` block, line 138 specifically); the driver return screen's history was not checked
(out of scope for this section — B128 below covers that file's history in more depth since B128
is the primary bug touching it).

### Existing tests around this behavior

- No existing test in this codebase asserts on the `restock` value written into
  `data.items.create[...]` — confirmed via the same review of `returns-overreturn.spec.ts` used
  for B20 (no `restock` assertions found anywhere in that file). REG-B61's server-side test is
  wholly new.
- `apps/mobile/__tests__/returns-logic.test.ts` (read in part for B69/B128 context) has NO
  `restockForReason` tests yet — confirmed the function does not exist in `returns-logic.ts`
  (full file read above, 99 lines, only exports `returnPillFor`, `buildReturnItems`,
  `returnActionFlags`).

### Production evidence (if any)

None available.

### Open unknowns

- The plan's exact reason→restock policy table (DAMAGED/QUALITY_ISSUE → false; WRONG_ITEM/
  CUSTOMER_REFUSED/EXCESS_ORDER → true) is asserted by the plan, not independently derived here —
  this agent takes no position on whether that mapping is correct business policy, only on where
  the current code diverges from ANY reason-aware default.
- Whether `apps/mobile/app/(operator)/returns/new.tsx`'s per-line switch (cited by the plan at
  `:183, :266-272`) should ALSO gain a reason-based DEFAULT (vs. today's presumably neutral
  default before the operator overrides it) was not independently verified — not read in this
  pass; flagged for S2.

---

## B128 — Driver return screen posts DELIVERED qty instead of undelivered qty (REFUSED rejected 400, PARTIAL over-credits kept goods)

### The bug as stated

**Source (B128.md, "Actually does" / "The gap"):** "Both the rendered rows and the POST body take
qty straight from DeliveryMutation.quantityDelivered — the delivered side. REFUSED mutations
carry 0, so the server rejects the submit outright; PARTIAL mutations carry the delivered amount,
so the return covers exactly the goods the customer kept and was billed for."

**Committed plan's root cause (F08.md), as a claim:** "returnRowsFromStop (driver return/index.tsx:42-55)
sets qty = m.quantityDelivered and amount = unitPrice × quantityDelivered; issue() (:94-100) posts
qty = Math.round(quantityDelivered)... REFUSED rows post qty 0 → server 400 at
returns.service.ts:102-103; PARTIAL rows return the goods the customer kept."

**Repro:** a stop has a PARTIAL delivery mutation for `orderItemId li1` (ordered qty 10,
`quantityDelivered: 6`) and a REFUSED mutation for `orderItemId li2` (ordered qty 5,
`quantityDelivered: 0`). Driver opens the Return screen: expected rows should show the
UNDELIVERED quantities — `[4, 5]` (10−6, 5−0) — and post those to `/returns`. Observed on this
tree: `returnRowsFromStop` (line 51: `qty: Number(m.quantityDelivered ?? 0)`) produces rows
`[6, 0]` instead. Exact wrong values: **rendered/posted qty = `[6, 0]`** where expected is
`[4, 5]` — the REFUSED row's qty 0 additionally triggers the server's `item.qty <= 0` 400 at
`returns.service.ts:103-104` (confirmed: `if (!item.qty || item.qty <= 0) throw new
BadRequestException("Return item quantity must be greater than zero")`), so the REFUSED case
cannot be submitted at all, while the PARTIAL case submits a return for qty 6 — the goods the
customer KEPT, not the 4 units they didn't receive.

### Code path

- Entry: driver taps into the Return screen from the stop detail
  (`apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`, cited by the plan at :345-348, not
  independently re-read in this pass) → `apps/mobile/app/(driver)/route/stop/[stopId]/return/
index.tsx`.
- `return/index.tsx:34-55` — `returnRowsFromStop`, confirmed to exist with `qty` at line 51 and
  `amount` at line 53 both keyed on `m.quantityDelivered` (verified via targeted grep: lines
  34, 37, 41, 51, 53, 78, 98 all matched the expected pattern from the earlier grep output).
- `return/index.tsx:98` — `issue()`'s posted qty: `qty: Math.round(Number(m.quantityDelivered ?? 0))`
  — same delivered-side source.
- `apps/mobile/lib/short-pick.ts:62-67` — `deliveryTypeForQty` confirms the semantics: `deliveredQty
<= 0 → "REFUSED"`, `>= orderedQty → "DELIVERED"`, else `"PARTIAL"` — i.e. by construction a
  REFUSED mutation's `quantityDelivered` IS 0, confirming the plan's claim that REFUSED rows are
  unsubmittable today (0 qty → server 400) without independent access to
  `routes.service.ts` needed to confirm this (the mutation-writing side is out of scope/read-only
  per SEQUENCE.md R2, and this client-side arithmetic alone is sufficient to establish the bug).
- `returns.service.ts:101-104` — the server-side qty>0 guard that REFUSED rows hit:
  ```
  102       for (const item of dto.items) {
  103         if (!item.qty || item.qty <= 0)
  104           throw new BadRequestException("Return item quantity must be greater than zero");
  ```
- No `undeliveredReturnLines` helper exists yet in `apps/mobile/lib/returns-logic.ts` (confirmed:
  full file read above, 99 lines, no such export) — the plan's proposed fix helper is not yet
  written.

### History

Not independently re-run beyond confirming the current file shape via direct read/grep (sufficient
to establish the repro without ambiguity); B128.md's own "Rounds 4-5" provenance dates this
finding to Aug 29, 2026, well before the current worktree's HEAD.

### Existing tests around this behavior

- `apps/mobile/__tests__/returns-logic.test.ts` exists but was not read in full in this pass
  (confirmed to exist via `ls`); since `undeliveredReturnLines` does not exist in
  `returns-logic.ts`, no test in that file can currently reference it — REG-B128 is a wholly new
  test per the plan's own admission ("The RN screen rewire itself is unverified by jest... the
  helper is the provable oracle").
- No existing test covers `returnRowsFromStop` or `issue()` in the driver return screen file
  directly (no RN component test runner in this repo, per `CLAUDE.md`'s mobile Jest scope:
  `__tests__/*.test.ts`, pure-logic only).

### Production evidence (if any)

None available.

### Open unknowns

- The plan's fix depends on `prorateLineSubtotal`/`freeUnitSizeFor` from `short-pick.ts` (both
  confirmed to exist and match the plan's description, read above at lines 9, 52-60) to compute
  the undelivered SHARE of money box-safely — the exact wiring of `undeliveredReturnLines` was not
  built or verified here (S1 is read-only; this is squarely S2/build scope).
- This agent did not independently verify `routes.service.ts:1913-1926`/`:2289-2294` (the
  mutation-write and COGS-treats-as-delivered claims) — that file is explicitly F11's, read-only
  for F08 per SEQUENCE.md R2, and the plan's own citation there was taken as given rather than
  re-verified, consistent with the task's constraint not to edit or deeply audit that file.
- Interplay with B53 (billed-basis refund) and B61 (restockForReason) is asserted safe by the
  plan's own Notes section for B128 — not independently re-derived here; flagged for S2 to confirm
  once both helpers exist.

---

## B166 — Returns search box is fully inert (no server-side search)

### The bug as stated

**Source (B166.md, "Actually does"):** "The web hook sends search on every keystroke, but the
returns controller binds only orderId, customerId, status, reason, page and limit, and neither
service signature has a search parameter or builds one into its where clause."

**Committed plan's root cause (F08.md), as a claim:** "The web hook forwards `search`
(apps/web/lib/api/returns.ts:79-89; page.tsx:390-401 debounced + URL-synced), but
returns.controller.ts:30-49 binds only orderId/customerId/status/reason/page/limit, and neither
findAllForUser (:157-173) nor findAll (:175-204) has a search parameter or OR clause."

**Repro:** operator types an existing return's number into the search box → expected: the list
narrows to that one row → observed: the full unfiltered (status/reason-only) list is returned
unchanged, because `search` is silently dropped between the client and the query. Exact wrong
value: **row count after typing a specific returnNumber into search === the full unfiltered
count**, not 1 (or 0 for a nonsense string).

### Code path

- Entry: web `useReturns({ search })` (`apps/web/lib/api/returns.ts:77-88`, confirmed the
  interface accepts `search?: string` and forwards it as a query param) → `GET /returns?search=...`
  → `returns.controller.ts:32-50` — confirmed NO `@Query("search")` parameter exists (full
  controller read above, `findAll` handler only destructures `orderId/customerId/status/reason/
page/limit`).
- `returns.service.ts:158-174` (`findAllForUser`) and `:176-205` (`findAll`) — confirmed neither
  function signature includes a `search` parameter, and `findAll`'s `where` object (lines 185-189)
  builds only `orderId/customerId/status/reason` — no `OR` clause anywhere in the file (confirmed
  via the full-file read above).
- Web render: `apps/web/app/(dashboard)/returns/page.tsx:390`
  (`const [search, setSearch, debouncedSearch] = useUrlSearch();`) and `:398`
  (`search: debouncedSearch || undefined,`) confirmed present, alongside the search input itself
  at line 534-536.

### History

Not independently re-run; the missing-parameter shape is directly legible from the current file
with no ambiguity about when it was introduced (the controller/service have simply never had a
search parameter — there is no removal to trace).

### Existing tests around this behavior

- No existing test in `returns-overreturn.spec.ts` or any other returns spec calls `findAll` with
  a `search` argument or asserts an `OR` where-clause — confirmed via the earlier full reads of
  both spec files. REG-B166's T1 supplementary case is wholly new.
- T2 (e2e spec 29, per corrections §4 confirmed as the free/allocated number) does not exist yet
  on this tree — `apps/web/e2e/29-returns-lifecycle.spec.ts` was not found (not explicitly
  ls'd in this pass, but no reference to it appears anywhere in the read files besides the plan
  and corrections documents themselves).

### Production evidence (if any)

None available. B166.md notes it was downgraded from High to Medium by its own verifier ("the
control is 100% dead, but returns are a low-volume list whose status/reason filters and
pagination still work").

### Open unknowns

- None specific to staleness — this bug's citations match the current tree closely (`page.tsx:
395-401`/`534-536`/`419` per B166.md vs. `:390-401`/`534-536` confirmed here — a small, non-
  substantive shift, and `:419` was not independently re-checked in this pass but is not load-
  bearing for the diagnosis).

---

## B75 — Returns dashboard "Total Return Value" and per-row Value are always $0.00

### The bug as stated

**Source (B75.md, "Actually does"):** "Both sum `(item.unitPrice ?? 0) * item.qty`, but
ReturnItem has no price column and returns findAll()'s include never selects or derives one —
unitPrice is always undefined and the `?? 0` fallback always fires."

**Committed plan's root cause (F08.md), as a claim:** "Both the KPI (returns/page.tsx:414-416)
and the row Value (:626) sum `(item.unitPrice ?? 0) * item.qty`; ReturnItem has no price column
(schema 2707-2716) and findAll's include (returns.service.ts:190-200) selects no price and
derives none, so unitPrice is always undefined and the sum is always 0."

**Repro:** a return exists for 2 units of a $5.00 line → expected KPI/row value: $10.00 →
observed: $0.00, because `ReturnItem` (confirmed at `sales.prisma:987-1008`) has no
`unitPrice`/price column at all, and `findAll`'s `include` (confirmed below) selects only
`product: { select: { id, name } }` on each item — no price field. Exact wrong value:
**`(item.unitPrice ?? 0) * item.qty` evaluates to `0 * qty = 0`** for every row, every time,
because `item.unitPrice` is structurally `undefined` on every object `findAll` can ever return.

### Code path

- Client sum: `apps/web/app/(dashboard)/returns/page.tsx:415`
  (`return sum + r.items.reduce((s, i) => s + (i.unitPrice ?? 0) * i.qty, 0);`) and `:626`
  (`const returnValue = ret.items.reduce((s, i) => s + (i.unitPrice ?? 0) * i.qty, 0);`) — both
  confirmed present verbatim via the earlier grep.
- Server: `returns.service.ts:191-197` (`findAll`'s query):
  ```
  191       this.prisma.forTenant().return.findMany({
  192         where,
  193         include: {
  194           order: { select: { id: true, orderNumber: true } },
  195           customer: { select: { id: true, businessName: true } },
  196           items: { include: { product: { select: { id: true, name: true } } } },
  197         },
  ```
  No `unitPrice`, no `subtotal`, no order line-items, no invoice items anywhere in this include —
  confirmed the ONLY place `refundEstimate` is computed in the whole file is `findOne` (lines
  499-507, the same Σqty×(subtotal/qty) loop used by `processRefund`, see B53) — `findAll` has no
  equivalent computation at all, matching the plan's claim precisely.
- Schema: `ReturnItem` (sales.prisma:987-1008, read in full above under B20) confirmed to have NO
  price/unitPrice/subtotal column of any kind.

### History

Not independently re-run; `findAll`'s include has apparently never carried pricing data (no
removal to trace — this is a "never built," not a "regressed," gap, consistent with B75.md's
framing as a UI feature that was never wired end to end).

### Existing tests around this behavior

- No test in this codebase asserts on `findAll`'s return shape carrying `refundEstimate` or any
  price field — confirmed via the full read of `returns-overreturn.spec.ts` (the only spec that
  exercises `create()`/`findAll`-adjacent logic) and the absence of any `findAll`-specific spec
  file. REG-B75's T1 supplementary case (per F08.md) is wholly new.
- Web: no `.test.tsx` for `returns/page.tsx` was found or read in this pass (not explicitly
  searched — flagged as an open unknown below, since the plan's Files list for B75 does not name
  a web unit-test file, only the e2e spec 29).

### Production evidence (if any)

None available. B75.md's own framing: "a headline finance number that is always wrong" for every
tenant with returns — not tied to a specific tenant id or amount in any input file.

### Open unknowns

- Per corrections §7 (independently consistent with this agent's own read of `findOne`'s loop at
  lines 499-507 vs. `processRefund`'s at 340-348): B75's `findAll` fix must call the SAME
  `billedBasisFor` helper B53 introduces, not a third copy of the Σqty×(subtotal/qty) loop — this
  agent found THREE near-identical loops in the file today (`processRefund` :340-348, `findOne`
  :499-507, and — once B75 is built — a would-be fourth in `findAll` if not deduplicated) — S2
  should treat "how many copies of this loop exist" as a direct simplicity/correctness check
  during build.
- Whether any `.test.tsx` exists for `apps/web/app/(dashboard)/returns/page.tsx` was not
  confirmed by a direct `ls`/`glob` in this pass — S2 should check before assuming e2e spec 29 is
  the only test surface for the KPI/row-value change.
- `findAll`'s heavier include (order line items + non-VOID invoice items, per the plan) at
  `limit: 500` in the web KPI query (page.tsx:404, not independently re-read in this pass) is
  flagged by the plan itself as a payload-size risk — not evaluated further here.

---

## B21 — Returns can't be cancelled from any screen

### The bug as stated

**Source (B21.md, "Actually does"):** "POST /returns/:id/cancel exists with full reversal logic
(returns.service.ts cancel()); mobile's useCancelReturn hook is exported but never imported/called
anywhere; web has no cancel hook at all."

**Committed plan's root cause (F08.md), as a claim:** "POST /returns/:id/cancel exists
(returns.controller.ts:90-94, OPERATOR|CUSTOMER) with full reversal logic (service :381-434).
apps/web/lib/api/returns.ts (read in full) has no cancel mutation and returns/[id]/page.tsx
renders no cancel control for any status... apps/mobile/lib/api/returns.ts:138 exports
useCancelReturn and a repo-wide grep finds zero importers."

**Repro:** an operator or customer opens ANY return's detail page on web or mobile and looks for
a way to cancel it → expected: a "Cancel return" control for cancellable statuses (PENDING/
APPROVED/IN_TRANSIT/RECEIVED) → observed: no such control exists on either surface, though the
server fully supports and guards the operation. Exact wrong value: not a numeric wrong value but
a **structural absence** — zero UI entry points for a fully-built, guarded server capability.

### Code path

- Server: `returns.controller.ts:90-94` confirmed present verbatim:
  ```
  90    @Post(":id/cancel")
  91    @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  92    cancel(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
  93      return this.returnsService.cancel(id, user);
  94    }
  ```
  → `returns.service.ts:390-443` (full `cancel()` body, read in detail under B69 above) — confirmed
  fully guarded (ownership check for CUSTOMER role at lines 398-405, terminal-state checks at
  406-408, atomic claim + undo at 415-440).
- Web: `apps/web/lib/api/returns.ts` (full file read above, 188 lines) confirmed to export
  `useCreateReturn`, `useApproveReturn`, `useRejectReturn`, `useMarkReturnInTransit`,
  `useMarkReturnReceived`, `useProcessRefund` — **no `useCancelReturn` of any kind**. `[id]/page.tsx`
  was grepped for `condition|useCancelReturn|Cancel return|cancel(` — only the `condition` render
  matched (line 644-650); zero matches for any cancel-related string.
- Mobile: `apps/mobile/lib/api/returns.ts:127` confirmed:
  `export const useCancelReturn = () => useReturnTransition("cancel");` — and a repo-wide grep for
  `useCancelReturn` across `apps/mobile/**/*.{ts,tsx}` excluding that file itself returned **zero
  matches** (confirmed via the backgrounded grep command's completed output above) — no importer
  anywhere.
- `apps/mobile/app/(operator)/returns/[id].tsx:16,108` confirmed imports `returnActionFlags` and
  calls it (`const flags = returnActionFlags(ret.status);`) to drive its `ActionTile` grid (6
  `ActionTile` usages found, lines 147-195) — but `returnActionFlags` (full source read under
  B61) has NO `canCancel` field in its `ReturnActionFlags` interface (lines 33-47) or its
  implementation (lines 77-98) — confirmed via the full-file read above.
- `.claude/skills/bug-hunt/scan-ignore.json:35` confirmed to contain exactly:
  `"apps/mobile/lib/api/returns.ts::export const useCancelReturn = () => useReturnTransition(\"cancel\");"`
  — a standing suppression of the dead-export finding for this exact line, matching corrections
  §10's instruction to delete it as part of the B21 fix.

### History

Not independently re-run; the absence of a cancel UI is a "never built," not "regressed," gap —
B21.md's own provenance ("Adversarially verified · Aug 28, 2026") predates this worktree's HEAD
by over a week with no intervening changes to any of the four client files touched here.

### Existing tests around this behavior

- `apps/mobile/__tests__/returns-logic.test.ts` was not read in full in this pass, but since
  `canCancel` does not exist in `returns-logic.ts`'s source (confirmed above), no test can
  currently reference it — REG-B21's T1 supplementary case (`returnActionFlags('RECEIVED').canCancel
true`, etc.) is wholly new.
- No web `.test.tsx` for `[id]/page.tsx` was found or read in this pass (same caveat as B75 — not
  explicitly globbed).

### Production evidence (if any)

None available.

### Open unknowns

- Whether a `.test.tsx` exists for either web returns page (list or detail) was not confirmed by
  a direct glob in this pass — flagged for S2/S3 before assuming e2e spec 29 is the only test
  surface touching the Cancel button.
- This agent did not verify `orders.service.ts:5507`'s `return.count` deleteOrder guard (named in
  the task's file-of-interest list) — not cited by any of B21's evidence, and not required to
  establish B21's repro; noted only because the task prompt named it explicitly among files of
  interest. If S2 needs it, it is unverified here.

---

## Cross-cutting notes for S2

1. **This tree already carries F09 (#636, `151c3f70`, landed 2026-09-06 03:41:42 — TODAY, not
   "in flight" as SEQUENCE.md R3/corrections §5 anticipated).** Concretely on `returns.service.ts`:
   the `processRefund` invoice select now filters `status: { notIn: CREDIT_SOURCE_EXCLUDED }`
   (lines 319-327) and `credit-notes.service.ts create()` now throws on a VOID/WRITTEN_OFF
   `dto.invoiceId` target (lines 133-139) with a `status: true` field added to its invoice select
   (line 118) — none of this was undone or altered by anything else read in this pass. This
   closes part of B53's original "no status filter" claim but leaves the refund-BASIS math
   (order-line vs. invoice-item) and the 2+-invoice headroom gap entirely open, exactly as
   corrections §5 predicted structurally (even though its "0 commits ahead" framing of F09 is now
   moot — F09 is fully merged, not a parallel worktree to coordinate with).
2. **Every "returns.service.ts:NNN" citation in F08.md and the B##.md registry records is off by
   roughly +9 lines from this tree**, consistently in the region from `processRefund`'s select
   (line ~319) onward, and by a similar amount in `cancel()` further down — traced to the
   `151c3f70` (#636) commit inserting the 9-line invoice-select comment block. Citations BEFORE
   that block (`create()`'s cap, lines 41-156) match the plan closely (0-2 line drift). S2 should
   re-derive every line number from this tree directly rather than trusting either B##.md or
   F08.md's citations verbatim — this brief's "Code path" sections above give the corrected
   current lines for every citation checked.
3. **Three copies of the same Σqty×(subtotal/qty) refund-basis loop exist today** (`processRefund`
   :340-348, `findOne` :499-507) with a would-be third needed for B75's `findAll` fix — the
   `billedBasisFor` helper (not yet written) is the single place all three call sites should
   route through once B53 lands; this agent flags but does not resolve which order of edits
   avoids re-deriving it three times.
4. No production data, tenant ids, order/invoice numbers, or amounts were available to or
   consulted by this agent — every "Production evidence" section above is empty as a factual
   report, not an oversight.

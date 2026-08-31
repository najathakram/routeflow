# Build plan: F06 — updateOrderItems authorization + line build

> **Stage S5.** Authored by Fable 5 on 2026-08-31. Status: `APPROVED`
> Inputs: [discovery.md](./discovery.md) · [spec.md](./spec.md) (R#) · [ux-spec.md](./ux-spec.md)
> · [test-plan.md](./test-plan.md) (T#) · `.claude/pipeline/design-system.md` (derived cache).
> All line numbers refer to master `26037bd4` (this worktree's baseline).

---

## Objective

Fix six confirmed register bugs in `OrdersService.updateOrderItems` and the buyer-portal
merge: buyers can no longer be overcharged by denomination-mixing merges (B47), author their
own prices via unlisted lines (B51), or rewrite dispatched/delivered orders (B63); operator
replace-all edits stop destroying buyer-earned BOGO snapshots (B60, reframed); the buyer
merge carries urgent/date/notes (B78); the web order editor gates pricing-dependent controls
until the customer's contract is loaded (B62). One PR; campaign proof tokens REG-B47/51/60/62/63/78.

**In scope:** the packages below. **Out of scope (scope fence):** staff-promotion widening
(P5-04 invariant stands); product lookups inside `foldMergeItems` itself (normalization is a
separate pre-step); change-request UX; ANY edit to `apps/api/src/invoices/invoices.service.ts`
(**F07 owns that file — read-only here**); UpdateOrderItemsDto gaining urgent/date fields;
web unit tests (campaign D1); edits to `orders.scan-hardening.spec.ts`, `orders.service.spec.ts`
or `orders-promo-bogo.spec.ts` (pinned suites — they must pass UNMODIFIED).

---

## Constraints & conventions

- **Stack:** NestJS 11 + Prisma 7 (api), Next.js 14 App Router (web). Jest specs beside
  source (`*.spec.ts`), `Test.createTestingModule`, mock at the module boundary. Playwright
  e2e in `apps/web/e2e/NN-name.spec.ts` with a per-spec `projects[]` entry.
- **Money:** all line math through `computeLineSubtotal` / `normalizeBoxesPieces` /
  `roundMoney` from `apps/api/src/common/pricing.ts`. Never `qty * unitPrice` by hand for
  boxed lines. On box-unaware lines of boxed products, `qty` counts SELLING UNITS and
  `unitPrice` is the box price (pricing.ts header).
- **Formatting:** Prettier (semicolons, double quotes, width 100). Format ONLY files you
  edited — NEVER run a repo-wide prettier pass (a prior pipeline run dirtied 47 unrelated
  files; that commit had to be dropped).
- **Landmines:**
  - `updateOrderItems` runs its writes inside `prisma.tenantTransaction(..., Serializable)`;
    reference reads are hoisted BEFORE the tx on purpose (P5-08b pool starvation) — do not
    add queries inside the tx beyond the pattern already there.
  - The CUSTOMER branch (:2891-3058) also serves non-diff **DRIVER** edits. Every new guard
    must be scoped so DRIVER behavior is byte-identical (T6, T9).
  - `buyerPromos` is `[]` for staff (P5-04, :92-98). `bogoPromos` (:2855-2857) loads only
    when a line already carries `promoFreeUnits > 0` — B60's preservation reuses it, adding
    ZERO queries.
  - F03 changed `resyncOrderInvoicesForEdit`/`reconcileOrderDraftInvoice`/`buildInvoiceItemData`
    under this method (confirmed-payment predicates + REG-B50 basisQty cap). Tests must not
    re-derive invoice money independently.
  - The web order page auto-enters edit mode on DRAFT (:1637-1689) — keep that; only the two
    pricing-dependent controls wait (ux-spec).
  - TanStack Query v5: a disabled query stays `isPending` forever — `pricingReady` must
    short-circuit on `!order?.customerId`.

---

## Test packages

### TP1 — merge fold + normalization units
- **writes:** `apps/api/src/orders/merge-items.spec.ts` (NEW)
- **tests:** T1, T2
- **brief:** Direct unit tests of `foldMergeItems` and `normalizeBoxUnawareSnapshots` from
  `apps/api/src/orders/merge-items.ts` (module CREATED by WP1 — use the guarded dynamic
  import pattern so absence fails as an assertion, not an import error). T1: box-split
  existing {boxes:2,pieces:0,qty:24,unitsPerBox:12} + incoming {qty:12,boxes:1,pieces:0}
  → single line {boxes:3,pieces:0,qty:36}, unitPrice ABSENT (derived price re-prices). T2:
  box-unaware existing {boxes:null,pieces:null,qty:2} normalized with live upb 12 →
  {boxes:2,pieces:0,qty:24,unitsPerBox:12}, then fold with incoming {qty:12,boxes:1} →
  {boxes:3,pieces:0,qty:36}. Also: non-boxed product (upb 0/1) passes normalization
  untouched; already-split lines pass untouched; unlisted lines pass through the fold.
  Titles carry `REG-B47`; describe `(T-B47 / REG-B47)`.
- **must fail with:** guarded-import assertion ("merge-items exports … expected true,
  received false").

### TP2 — updateOrderItems guards (service level)
- **writes:** `apps/api/src/orders/orders.update-items-guards.spec.ts` (NEW)
- **tests:** T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13
- **brief:** Copy the mocked-Prisma harness style from `orders.service.spec.ts`'s
  `updateOrderItems` describes (e.g. "customer ADD of a NEW boxed line", :4278) — mock
  `PrismaService.forTenant()` + `tenantTransaction` (executes callback with a mock tx),
  `PromotionsService.activeForCatalog`, capture `orderItem.create` data. Oracles and exact
  expected values per test-plan §2/§2.1. REG tokens in it() titles: REG-B47 (T3), REG-B51
  (T4, T5), REG-B63 (T7, T8, T9), REG-B60 (T10, T11, T12, T13). T6/T8/T9/T12 sit in
  describes titled `(pin — green pre-fix)` and are EXCLUDED from the red-gate must-fail set.
  T7 must assert ForbiddenException thrown BEFORE `tenantTransaction` is entered and that
  `revertLinkedInvoicesForOrderEdit`, `appendOrderRevision`, deleteMany/create spies are
  all uncalled.
- **must fail with:** assertion failures per test-plan §6 (e.g. "expected 30, received 360";
  "expected ForbiddenException, resolved instead").

### TP3 — buyer merge controller wiring
- **writes:** `apps/api/src/buyer/buyer.controller.merge.spec.ts` (NEW)
- **tests:** T14, T16
- **brief:** Copy the module setup from `buyer.controller.spec.ts`. Mock OrdersService
  (`findActiveOrder`, `updateOrderItems`, `applyBuyerMergeHeader`, `mergeAllPendingForCustomer`,
  `create`, `findOne`) and PrismaService (product findMany → upb map). T14 + a REG-B47
  companion: merge branch calls `updateOrderItems(activeOrder.id, {items: <folded, catalog
  only, e.g. {productId, qty:36, boxes:3, pieces:0}>, replaceAll:true}, pseudoUser)` — never
  the naive `{qty:14}` sum, never unlisted entries; `applyBuyerMergeHeader` called with
  {notes, urgent, requestedDeliveryDate} BEFORE `mergeAllPendingForCustomer` (assert call
  order via mock.invocationCallOrder). T16: no active order → `create` called with the same
  dto mapping as today. Titles: REG-B47 on the fold-payload case, REG-B78 on the header case.
- **must fail with:** "expected applyBuyerMergeHeader to have been called — spy uncalled /
  method undefined"; "expected items[0].boxes 3, received undefined (payload {qty:14})".

### TP4 — e2e spec 24 (B62)
- **writes:** `apps/web/e2e/24-order-edit-pricing.spec.ts` (NEW), `apps/web/playwright.config.ts`
  (append ONE `projects[]` entry — this is test wiring, not implementation)
- **tests:** T15
- **brief:** Mirror specs 21/22: imports from `./helpers/auth` (`setTenantCookie`),
  `./helpers/constants` (`TENANT_SLUG`), `./helpers/api` (`apiBase`, `operatorAccessToken`);
  `test.describe("Order-edit pricing readiness (F06)")`, single test titled starting exactly
  `REG-B62 …`. Fixture: API-create a customer with pricingTier 2 + a tier-2 price for a
  seeded product + a DRAFT order for that customer (unique per-run suffix; NEVER first-row
  selection — see the #556 lesson in the config's own comments). Flow: `page.route` holds
  `**/customers/<id>` (fulfill later); open `/orders/<id>`; expect the add-product input
  disabled AND the text "Loading customer pricing…" visible AND the Substitute trigger (if a
  line exists) disabled; release the route; expect the input enabled and the hint gone; type
  the product name, add it, expect the line's displayed unit price to equal the tier-2 price
  (exact seeded value), not the list price. Config entry: name `order-edit-pricing`,
  testMatch `/24-order-edit-pricing\.spec\.ts/`, `dependencies: ["setup"]`, operator
  storageState, banner comment naming REG-B62 + mutation-safety note (creates its own
  order/customer on the seed tenant; deletes nothing) + the "WITHOUT THIS ENTRY THE SPEC
  NEVER RUNS" line. **This spec is NOT in the red gate** (runs post-deploy, campaign D1).
- **must fail with:** n/a (excluded from red gate; will fail against prod until F06 deploys).

**Red gate command** (every non-pin test must fail on an assertion; pins stay green):

```bash
cd apps/api && npx jest merge-items orders.update-items-guards buyer.controller.merge --silent
```

---

## Work packages

### WP1 — extract merge-items module + snapshot normalization
- **files:** `apps/api/src/orders/merge-items.ts` (NEW), `apps/api/src/orders/orders.controller.ts`
- **satisfies:** R12, enables R1
- **provenBy:** T1, T2 (+ existing `orders.scan-hardening.spec.ts` staying green, zero edits)
- **dependsOn:** none
- **brief:** MOVE `MergeLineSnapshot`, `MergeIncomingItem`, `deriveUnitsPerBox`,
  `foldMergeItems` from `orders.controller.ts:35-248` into the new pure module
  `apps/api/src/orders/merge-items.ts` **byte-identical** (exported; keep every comment).
  `orders.controller.ts` imports them from `./merge-items` (it uses `normalizeBoxesPieces`
  inside the fold — move that import along). ADD to the new module:

```ts
/**
 * B47 (REG-B47): a box-UNAWARE line (boxes/pieces null) of a BOXED product
 * states its qty in SELLING UNITS — pricing.ts's contract: unitPrice IS the
 * box price and computeLineSubtotal bills unitPrice x qty. Folding that qty as
 * loose pieces mis-bills it (~1/unitsPerBox of its value); summing it raw with
 * pieces over-bills ~unitsPerBox x. Normalize such snapshots to an explicit
 * box split BEFORE folding, using the LIVE unitsPerBox the caller supplies.
 * Non-boxed products (upb <= 1) and already-split lines pass through untouched.
 */
export function normalizeBoxUnawareSnapshots(
  lines: MergeLineSnapshot[],
  liveUnitsPerBoxByProductId: Map<string, number>,
): MergeLineSnapshot[] {
  return lines.map((li) => {
    if (!li.productId || li.boxes != null || li.pieces != null) return li;
    const upb = Math.trunc(Number(liveUnitsPerBoxByProductId.get(li.productId) ?? 0));
    if (upb <= 1) return li;
    const sellingUnits = Math.trunc(Number(li.qty ?? 0));
    if (sellingUnits <= 0) return li;
    return { ...li, boxes: sellingUnits, pieces: 0, qty: sellingUnits * upb, unitsPerBox: upb };
  });
}
```

### WP2 — updateOrderItems guards + BOGO preservation + header helper (service)
- **files:** `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/dto/update-order-items.dto.ts`
- **satisfies:** R2, R3, R4, R5, R6, R7, R8, R9, part of R1 (shouldSplit), part of R10 (helper)
- **provenBy:** T3-T13, T14 (helper semantics)
- **dependsOn:** none
- **brief:** Five surgical edits, all inside/around `updateOrderItems` (:2735-3856) plus one
  new small method. The CUSTOMER branch also serves non-diff DRIVER edits — every guard
  below is scoped to CUSTOMER (`isBuyerEdit` — verify the existing variable name used by the
  shouldSplit gate at :2989-2999 and reuse it; it must mean role===CUSTOMER, not the branch).

**(a) B63 gate** — immediately after the CANCELLED check (:2751-2753), before ANY side
effect (before the :2765 diff-shape logic and the :2806-2811 invoice revert):

```ts
// B63 (REG-B63): buyers self-edit only pre-dispatch orders — the post-dispatch
// relaxation in the comment above is operator + driver only. Thrown BEFORE any
// side effect (invoice revert, line writes, revision, status event); buyers use
// the change-request flow once the order is out the door.
const POST_DISPATCH_STATUSES: OrderStatus[] = [
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.DELIVERED,
];
if (user?.role === UserRole.CUSTOMER && POST_DISPATCH_STATUSES.includes(order.status)) {
  throw new ForbiddenException(
    "This order is already out for delivery. Send a change request instead.",
  );
}
```

**(b) B51 preservation** — the CUSTOMER-branch delete at :2950 becomes scoped, the loop
skips client unlisted input for buyers, surviving unlisted rows re-stamp after the loop:

```ts
// B51 (REG-B51): buyers can neither author, reprice, nor drop unlisted
// (catalog-free) lines — create()'s staff-only rule, mirrored. Stored unlisted
// rows are preserved IN PLACE (same row ids — invoice/delivery references
// survive); client-supplied unlisted input is ignored on the buyer path.
// Drivers keep today's authoring behavior.
await tx.orderItem.deleteMany({
  where: { orderId, ...(isBuyerEdit ? { productId: { not: null } } : {}) },
});
```
In the recreate loop's `!item.productId` arm: `if (isBuyerEdit) continue;` before the
existing driver/unlisted create logic. After the loop (buyer path only): findMany the
surviving `productId: null` rows ordered by position and re-stamp `position: pos++`.
Verify the totals recompute (:3681-3692) reads ALL the order's lines from the tx (it must
include the preserved rows — T4 asserts totals include the unlisted subtotal).

**(c) B47 shouldSplit signal** — extend the gate at :2989-2999:

```ts
const shouldSplit =
  upb > 1 &&
  (pieceDenominated.has(item.productId) ||
    // REG-B47: a folded merge payload carries an explicit box/piece split —
    // treat it as piece-denominated and re-split server-side from qty + LIVE
    // unitsPerBox (B13 posture: the split is a signal, never trusted verbatim).
    (isBuyerEdit && (item.boxes != null || item.pieces != null)) ||
    (isBuyerEdit && !existingProductIds.has(item.productId)));
```
Update the stale DTO comment at `dto/update-order-items.dto.ts:58-59` (client boxes/pieces
now serve as a denomination signal on the buyer path).

**(d) B60** — two parts.
*Plumbing (R9, behavior-neutral):* in BOTH operator add blocks (:3141-3236 replaceAll,
:3306-3405 diff-add): add `freeUnits: 0` to the two non-resolver arms of the `priced`
ternary, destructure and pass `freeUnits: priced.freeUnits` into `computeLineSubtotal`, and
add `promoFreeUnits: priced.freeUnits > 0 ? priced.freeUnits : null` to the create data.
*Preservation (R7/R8, the real fix — replaceAll block only):* build once, before the
replaceAll loop, a map of pre-edit BOGO counterparts from `order.lineItems` (first
non-cancelled line per productId with `Number(promoFreeUnits ?? 0) > 0`, capturing qty,
boxes, unitPrice, priceType, promoFreeUnits). For each recreated catalog line with a
counterpart: if the incoming price is ABSENT or equals the stored unitPrice (tolerance
0.005 — a client echoing the line's current price is not an override decision), then do
exactly what the stored-price qty-edit branch does (:3529-3675 is the semantic oracle —
copy its `rescaleBogoFreeUnits` call shape at :3615-3632 verbatim, with `bogoPromos`, the
product row from `productMap`, oldUnits = counterpart boxes ?? qty, newUnits = new
boxes ?? qty): keep the stored unitPrice and priceType, write the rescaled
`promoFreeUnits` (null when 0), and pass those freeUnits into `computeLineSubtotal`. If
the incoming price genuinely differs → today's override path unchanged (MANUAL flip, no
snapshot — T12 pins this). Diff-add block gets plumbing only (a fresh add has no
counterpart).

**(e) B78 helper** — new public method on OrdersService (near `toggleUrgent`, ~:4873):

```ts
/**
 * REG-B78: header fields a buyer's cart merge must carry onto the EXISTING
 * order — merge semantics, not create semantics: notes APPEND (never clobber),
 * urgent only ever SETS true (a non-urgent add never clears an urgent order),
 * requestedDeliveryDate sets when provided and never clears.
 */
async applyBuyerMergeHeader(
  orderId: string,
  header: { notes?: string; urgent?: boolean; requestedDeliveryDate?: string },
  user: JwtPayload,
): Promise<void> {
  const order = await this.prisma.forTenant().order.findFirst({ where: { id: orderId } });
  if (!order) throw new NotFoundException("Order not found");
  if (user.role === UserRole.CUSTOMER) {
    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub } });
    if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
  }
  const data: Record<string, unknown> = {};
  const notes = (header.notes ?? "").trim();
  if (notes) data.notes = order.notes ? `${order.notes}\n${notes}` : notes;
  if (header.urgent === true) data.urgent = true;
  if (header.requestedDeliveryDate) {
    data.requestedDeliveryDate = /* copy create()'s exact parse of requestedDeliveryDate
      (see the create path / :2107-2109 region) so merge and create agree on timezone */
      new Date(header.requestedDeliveryDate);
  }
  if (Object.keys(data).length) {
    await this.prisma.forTenant().order.update({ where: { id: orderId }, data });
  }
}
```
(The ownership-check shape mirrors `toggleUrgent`'s — read it and keep them consistent.)

### WP3 — buyer merge rewrite (controller)
- **files:** `apps/api/src/buyer/buyer.controller.ts`
- **satisfies:** R1, R2 (controller leg), R10, R13
- **provenBy:** T14, T16 (+ T3 end-to-end shape)
- **dependsOn:** WP1, WP2
- **brief:** In `createOrder`'s merge branch, replace the naive Map merge (:523-543) and the
  call at :546-550 with:

```ts
// REG-B47: denomination-aware fold (F30's staff exemplar, shared module) over
// LIVE-normalized snapshots — a box-unaware line of a boxed product counts
// selling units, so give the fold its real box split before summing.
// REG-B51: unlisted lines are server-preserved by updateOrderItems now —
// filter them out of the payload entirely (single owner).
const lineItems = activeOrder.lineItems ?? [];
const productIds = lineItems
  .map((li: { productId?: string | null }) => li.productId)
  .filter((id: string | null | undefined): id is string => !!id);
const products = productIds.length
  ? await this.prisma.forTenant().product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, unitsPerBox: true },
    })
  : [];
const upbByProduct = new Map(products.map((p) => [p.id, Number(p.unitsPerBox ?? 0)]));
const mergedItems = foldMergeItems(
  normalizeBoxUnawareSnapshots(lineItems, upbByProduct),
  dto.items ?? [],
).filter((i) => i.productId);
await this.ordersService.updateOrderItems(
  activeOrder.id,
  { items: mergedItems, replaceAll: true } as UpdateOrderItemsDto,
  makePseudoUser(ctx),
);
// REG-B78: carry the buyer's header fields onto the merged order (append/OR/set
// semantics) BEFORE the sibling-order sweep, so they land on the surviving order.
await this.ordersService.applyBuyerMergeHeader(
  activeOrder.id,
  { notes: dto.notes, urgent: dto.urgent, requestedDeliveryDate: dto.requestedDeliveryDate },
  makePseudoUser(ctx),
);
```
Keep the existing `mergeAllPendingForCustomer` + `findOne` tail exactly as is. Import
`foldMergeItems`, `normalizeBoxUnawareSnapshots` from `../orders/merge-items` and
`UpdateOrderItemsDto` if not already imported. Verify the controller's PrismaService
injection + `forTenant()` usage pattern against its existing methods (it has both).
`addAllLow` (:721-731) delegates to `createOrder` and inherits the fix — do not touch it.

### WP4 — web pricing-readiness gate
- **files:** `apps/web/app/(dashboard)/orders/[id]/page.tsx`
- **satisfies:** R11
- **provenBy:** T15 (post-deploy)
- **dependsOn:** none
- **brief:** Per [ux-spec.md](./ux-spec.md) and design-system.md's "Order-edit page notes".
  Destructure the loading/error flags the page currently discards (:1533-1559):

```tsx
const {
  data: customerDetail,
  isPending: customerPending,
  isError: customerFailed,
} = useCustomer(order?.customerId ?? "");
const {
  data: customerPrices,
  isPending: pricesPending,
  isError: pricesFailed,
} = useCustomerPrices(order?.customerId);
// B62 (REG-B62): tier defaults to 1 while these queries are in flight, so any
// line added/substituted in that window bakes the LIST price (the substitute
// path even SENDS it). Gate pricing-dependent controls until both settle.
// NOTE: a disabled query is isPending forever — short-circuit when there is no
// customer. An errored fetch falls back to today's tier-1 degraded mode.
const pricingReady =
  !order?.customerId ||
  ((!customerPending || customerFailed) && (!pricesPending || pricesFailed));
```

  Thread `pricingReady` into `EditableLineItems` (defined in-file at :861, rendered at
  :2595) as a prop. Gate, using the page's own vocabulary (design-system.md): the
  add-product `<input>` in the scan row (:1324-1356) gets `disabled={!pricingReady}` and its
  container shows, while `!pricingReady`,
  `<span className="flex items-center gap-1 text-xs text-navy/70"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading customer pricing…</span>`;
  the suggestion-dropdown rows (:1357-1374) and the Substitute trigger (:1205-1210) get
  `disabled={!pricingReady}` + `disabled:opacity-50` (raw-button pattern at :206-207).
  Also gate the custom-item "Add" path only if it consumes tier pricing (it does not —
  leave it). Do NOT delay the page render or the DRAFT auto-edit effect (:1637-1689).

### Package map

| WP | satisfies | provenBy | dependsOn | Wave |
|---|---|---|---|---|
| WP1 | R12 (+R1 enabler) | T1, T2 | — | 1 |
| WP2 | R2-R9, R10(helper), R1(signal) | T3-T13 | — | 1 |
| WP4 | R11 | T15 | — | 1 |
| WP3 | R1, R2, R10, R13 | T14, T16, T3 | WP1, WP2 | 2 |

Cross-check: every R1-R13 appears in a `satisfies:` except R12's proof (existing pinned
suite) and R11/R13 covered above. Every T1-T16 appears in a `provenBy:`.

---

## Acceptance criteria

1. R1 — the register scenario (box-unaware qty=2 line, upb 12, box price 10.00; buyer adds
   1 box) persists boxes=3/qty=36, subtotal exactly 30.00 — not 140.00 (today) and not 360.00.
2. R2/R3 — after any CUSTOMER edit, stored unlisted rows are unchanged (same ids) and no
   payload can create or reprice one; DRIVER unlisted authoring unchanged.
3. R4 — CUSTOMER items-edit on the three post-dispatch statuses throws ForbiddenException
   with zero side effects; R5 — CONFIRMED edit still succeeds and reverts to PENDING.
4. R7/R8 — staff replaceAll at unchanged/echoed price lands exactly where a qty edit of the
   same line lands (stored price, PROMO kept, snapshot rescaled, free units in subtotal);
   a genuinely changed price still flips MANUAL with no snapshot.
5. R10 — a merging cart's notes append, urgent=true sticks, urgent=false never clears,
   date sets when provided — on the order the merge returns.
6. R12 — `orders.scan-hardening.spec.ts`, `orders.service.spec.ts`, `orders-promo-bogo.spec.ts`
   pass UNMODIFIED.
7. Deploy day — no schema change, no client update needed, no backfill; blocked buyers get
   an actionable 403 message.
8. Boundary — `git diff --name-only` contains NO file owned by F07 (`apps/api/src/invoices/invoices.service.ts`).

---

## Verification commands

Per round:

```bash
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
cd apps/api && npx jest merge-items orders.update-items-guards buyer.controller.merge orders.scan-hardening --silent
```

Final:

```bash
cd apps/api && npx jest src/orders src/buyer src/common --silent
npm run verify
```

(`npm run verify` = lock-edge validator → scanner self-test → scanner → turbo
check-types/lint/test → campaign-check. It is green on the untouched baseline.)

---

## UI verification

Skipped in-pipeline (no local web stack in this worktree; campaign D1 proves web logic
post-deploy via e2e spec 24 — see Risks). The design-system lens still reviews WP4 against
`.claude/pipeline/design-system.md` + [ux-spec.md](./ux-spec.md).

---

## Risks & rollback

| Risk | Likelihood | Blast radius | Watch |
|---|---|---|---|
| B60 preservation over-reaches (keeps snapshot on a genuinely repriced line) | low | money wrong | T12 pins the MANUAL flip; refuters + final pass |
| B63 gate over-blocks (CONFIRMED or DRIVER) | low | buyer/driver workflow break | T8/T9 pins |
| B51 preservation breaks totals (preserved rows missed by recompute) | low | order totals wrong | T4 asserts totals include unlisted |
| Fold normalization misreads a non-boxed product | low | money wrong | T2's pass-through cases |
| Web gate wedges the editor (disabled query pending forever) | med | operator cannot add lines | short-circuits on !customerId + isError; e2e T15 |
| B62 has no pre-deploy browser proof | accepted | — | post-deploy e2e spec 24 discharges REG-B62; manual browser spot-check after deploy |

- **Rollback:** revert the squash commit; no schema change; no data written that a revert
  strands (D4 repair of PRE-existing damage is a separate post-deploy step).
- **Observability:** refused buyer edits appear as 403s in API logs; campaign-check + REG
  suite guard regressions.

---

## Pipeline args

```js
{
  planPath: '.claude/pipeline/2026-08-31-f06-update-order-items/build-plan.md',
  discoveryPath: '.claude/pipeline/2026-08-31-f06-update-order-items/discovery.md',
  specPath: '.claude/pipeline/2026-08-31-f06-update-order-items/spec.md',
  uxSpecPath: '.claude/pipeline/2026-08-31-f06-update-order-items/ux-spec.md',
  testPlanPath: '.claude/pipeline/2026-08-31-f06-update-order-items/test-plan.md',
  designSystemPath: '.claude/pipeline/design-system.md',
  scale: 'major',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-F06',
  context: 'Campaign F06 (money+auth): B47/B51/B60/B63/B78 in updateOrderItems + buyer merge, B62 web gate. apps/api/src/invoices/invoices.service.ts is READ-ONLY (F07 owns it). Never edit orders.scan-hardening.spec.ts / orders.service.spec.ts / orders-promo-bogo.spec.ts. Format ONLY files you edited.',
  formatCommand: '',
  testPackages: [ TP1, TP2, TP3, TP4 as specified above ],
  redGate: { commands: ['cd apps/api && npx jest merge-items orders.update-items-guards buyer.controller.merge --silent'], expect: 'fail' },
  packages: [ WP1, WP2, WP4 (wave 1), WP3 (dependsOn WP1+WP2) ],
  verifyCommands: {
    perRound: [
      'cd apps/api && npx tsc -p tsconfig.build.json --noEmit',
      'cd apps/api && npx jest merge-items orders.update-items-guards buyer.controller.merge orders.scan-hardening --silent'
    ],
    final: [
      'cd apps/api && npx jest src/orders src/buyer src/common --silent',
      'npm run verify'
    ]
  },
  mutationProbe: { targets: [
    { file: 'apps/api/src/orders/orders.service.ts', behavior: 'a CUSTOMER items-edit on a post-dispatch order is refused before any side effect', test: 'REG-B63 (T7)' },
    { file: 'apps/api/src/orders/orders.service.ts', behavior: 'a CUSTOMER payload can never create or touch an unlisted line; stored unlisted rows survive buyer edits in place', test: 'REG-B51 (T4/T5)' },
    { file: 'apps/api/src/orders/orders.service.ts', behavior: 'staff replaceAll preserves + rescales an existing BOGO snapshot at unchanged price', test: 'REG-B60 (T10)' },
    { file: 'apps/api/src/orders/merge-items.ts', behavior: 'box-unaware selling-unit snapshots normalize before folding; boxes fold with boxes', test: 'REG-B47 (T2)' },
    { file: 'apps/api/src/buyer/buyer.controller.ts', behavior: 'the merge hands updateOrderItems the folded payload with replaceAll true, never the naive qty sum', test: 'REG-B47 (T14 companion)' },
    { file: 'apps/api/src/buyer/buyer.controller.ts', behavior: 'the merge applies notes/urgent/date to the merged order before the sibling sweep', test: 'REG-B78 (T14)' }
  ] }
}
```

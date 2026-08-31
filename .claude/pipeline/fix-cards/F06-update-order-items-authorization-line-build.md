# F06 · updateOrderItems — authorization and line-build

**Bug IDs (6):** B47, B51, B60, B62, B63, B78

**Root cause:** One method missing the guards its siblings have. A buyer can price their own unlisted line (B51) and edit a delivered order (B63); a box-count and a piece-count are summed and billed as boxes (B47, ~4.7x overcharge); freeUnits is dropped on staff add (B60); urgent/date/notes vanish on merge (B78).

**Ships as:** One PR.

**Files:** orders.service.ts updateOrderItems (the single biggest method in the API, L2533-3609, 1,077 lines) · buyer.controller.ts · dto/update-order-items.dto.ts · web orders/[id]/page.tsx

**Together because:** Every one of them is inside the same method or its immediate caller. Splitting guarantees rebase conflicts on the hottest file in the repo.

**Guardrails / shared infra:** None new. B47 is Critical and its evidence (buyer.controller.ts, orders.service.ts, common/pricing.ts) is squarely T1-testable despite also touching a web page.

**Dependencies / lane notes:** Requires F04 (semantic). Positional lock with F07, F24 (same file/region — updateOrderItems vs changeStatus) — must merge before them since it is earlier in the lane order (F06 -> F07 -> F11 -> F22+F24 -> F16).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F06.jsonl`)

| ID  | Tier | Hunt-round SHA | Citation status              |
| --- | ---- | -------------- | ---------------------------- |
| B47 | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B51 | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B60 | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B62 | T2   | e5b0af8e       | MOVED (disambiguate in-file) |
| B63 | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B78 | T1   | e5b0af8e       | TOKEN_NOT_FOUND              |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B47 — Buyer "add to existing order" merges box counts with piece counts, then bills the sum as boxes

**Area:** apps/api/src/buyer/buyer.controller.ts + apps/api/src/orders/orders.service.ts

**Meant to do:** Adding more of a boxed product through the buyer cart, on top of an existing line for the same product, should merge into a correct combined quantity and price at the same box-aware subtotal as any other boxed line.

**Actually does:** The merge does `Number(li.qty) + item.qty` on a raw Map, discarding boxes/pieces. A pre-existing box-UNAWARE line (boxes/pieces null, qty=2 meaning 2 boxes — how order-template and operator-built lines are written) plus a cart add of 1 box (qty=12 pieces) sums to 14. updateOrderItems' shouldSplit gate then skips re-splitting precisely because the productId already exists on the order, so 14 is stored raw and computeLineSubtotal falls into its non-boxed branch: box unitPrice x 14.

**The gap:** A buyer who added one box on top of two is billed for 14 selling units instead of 3 boxes — a ~4.7x overcharge that scales with unitsPerBox. The denomination-aware merge (mergeBoxedContributions) exists but is only used by mergeAllPendingForCustomer, never by this controller.

**Evidence:** apps/api/src/buyer/buyer.controller.ts:462-488 (naive qty-only Map merge, boxes/pieces dropped); apps/api/src/orders/orders.service.ts:2732-2746 (pieceDenominated/existingProductIds sets), :2787-2805 (shouldSplit gate — both clauses false for this case), :2821-2853 (line persisted qty=14, boxes/pieces null); apps/api/src/common/pricing.ts:98-120 (non-boxed branch = unitPrice*qty) and header lines 1-12 (unitPrice IS the box price for boxed products); apps/api/src/orders/orders.service.ts:119-174 (resolveBuyerLinePrice returns the tier BOX price); apps/api/src/order-templates/order-templates.service.ts:349-372 (template lines written box-unaware, the common source of such a line).

**Suggested fix:** Route the buyer add-to-active-order merge through a denomination-aware merge (reuse/extract mergeBoxedContributions) that converts both sides to a common piece basis before summing, instead of the raw qty Map.

### B51 — Buyer can inject an arbitrarily-priced unlisted line through the order-items endpoint

**Area:** apps/api/src/orders/orders.service.ts — updateOrderItems (reached from buyer.controller PATCH /buyer/orders/:id/items)

**Meant to do:** A CUSTOMER editing their own order adjusts catalog-product quantities only; unlisted (free-text name + price) lines stay staff-only, exactly as create() already enforces.

**Actually does:** updateOrderItems' CUSTOMER branch accepts any item lacking productId and, when name/qty/unitPrice are present, creates it with priceType MANUAL at the client-supplied unitPrice — no role check anywhere in that branch, and no verification that the unlisted line pre-existed on the order.

**The gap:** create()'s staff-only unlisted-line guard has no counterpart in updateOrderItems; the buyer-portal PATCH route inherits the hole. Catalog-linked lines ARE correctly re-priced server-side, so the exposure is unlisted-only — but it is a buyer writing their own price onto their own order.

**Evidence:** apps/api/src/orders/orders.service.ts:2748-2775 (replace-all branch creates the unlisted MANUAL line from client fields), :2563-2572 (a {name,qty,unitPrice} payload passes the isDiffPayload check), :2806-2820 (catalog lines correctly re-priced — the contrast), :1550-1553 (create()'s CUSTOMER unlisted-line rejection, the missing parallel), :1696 (isStaffRole gates client unitPrice on create); apps/api/src/orders/orders.controller.ts:235-244 (@Roles includes CUSTOMER); apps/api/src/buyer/buyer.controller.ts:533-544 and :57-78 (makePseudoUser defaults role to CUSTOMER); apps/api/src/orders/dto/update-order-items.dto.ts:19-89 (no cross-field constraint tying missing productId to role).

**Suggested fix:** Before the replace-all loop, apply create()'s guard: reject any `!item.productId` entry when the caller is a CUSTOMER, unless it reproduces a pre-existing unlisted line matched by existing line id (never by client-supplied fields).

### B60 — Order-edit "add item" drops BUY_N_GET_M free units — bills full price and stores no snapshot

**Area:** apps/api/src/orders/orders.service.ts — updateOrderItems staff paths

**Meant to do:** Staff adding a promo-eligible product to an existing order (without typing a manual price) get the same BUY_N_GET_M discount a buyer would, with the line correctly billed and a snapshot stored for later edits/invoicing.

**Actually does:** Both operator-path add-item blocks call resolveBuyerLinePrice (which returns freeUnits) but destructure only unitPrice/originalPrice/priceType — freeUnits is dropped, never passed to computeLineSubtotal, and orderItem.create never sets promoFreeUnits.

**The gap:** The line is stored with priceType PROMO but bills every unit at full price, and promoFreeUnits stays null so downstream rescale/invoice logic (rescaleBogoFreeUnits, clampLineFreeUnits) has nothing to work from. The buyer/customer edit path does it correctly a few hundred lines earlier.

**Evidence:** apps/api/src/orders/orders.service.ts:2971-3028 and :3092-3149 (both operator add-item blocks, freeUnits dropped, no promoFreeUnits on create), :2879-2880 (isStaffEdit gate), :157-164 (resolveBuyerLinePrice returns freeUnits), :2806-2853 (correct buyer-path pattern); apps/web/app/(dashboard)/orders/[id]/page.tsx:929-976 and :1864-1875 (a plain add omits unitPrice, landing on this path); apps/api/src/orders/dto/update-order-items.dto.ts:64-68.

**Suggested fix:** Destructure `freeUnits` from `priced` in both operator add-item blocks (defaulting to 0 on the override branch), pass it into computeLineSubtotal, and set `promoFreeUnits: priced.freeUnits > 0 ? priced.freeUnits : null` on create.

### B62 — Order-edit prices newly added lines at list while the customer-tier fetch is still in flight

**Area:** apps/web/app/(dashboard)/orders/[id]/page.tsx

**Meant to do:** A newly added or substituted order line prices at the customer's contracted tier, never silently at full list.

**Actually does:** customerTier comes from a separate useCustomer query that is `enabled: !!id` and so can only start once `order` resolves; the page's loading gate covers only the order fetch. DRAFT orders auto-enter edit mode the instant `order` lands, so addProduct's tierPriceFor can run and bake unitPrice/basePrice while customerDetail is still in flight, with customerTier defaulting to 1.

**The gap:** A line added inside that window is baked at list price and is never re-priced once customerDetail arrives.

**Evidence:** apps/web/app/(dashboard)/orders/[id]/page.tsx:1513, :1517, :1529-1533 (tier defaults to 1), :929-970 (addProduct bakes the price synchronously), :1616-1664 (DRAFT auto-enters edit mode), :1669 (isLoading gates only useOrder), :2569; apps/web/lib/api/customers.ts:100-106 (sequential fetch).

**Suggested fix:** Gate the add/substitute UI on customerDetail having resolved, or pass a tierLoading flag through to addProduct and re-price any line added before it landed.

### B63 — Buyer can directly edit a dispatched or delivered order, bypassing the change-request approval flow

**Area:** apps/api/src/orders/orders.service.ts — updateOrderItems (buyer route)

**Meant to do:** Buyers fully self-edit only PENDING/DRAFT orders — as changeStatus already enforces for cancellation. Once dispatched, changes go through the approval-gated change-request flow; the post-dispatch direct-edit relaxation was scoped by its own comment to operator + driver.

**Actually does:** updateOrderItems' only status gate is `order.status !== CANCELLED`. A CUSTOMER hits no further check, so a buyer's full-replace PATCH on a DELIVERED / OUT_FOR_DELIVERY / PARTIALLY_DELIVERED order deletes and recreates the lines (new rows default deliveredQty=0, wiping the delivery record) and then resyncOrderInvoicesForEdit rebuilds the already-issued or paid invoice in place, recomputing status and balance against retained payments.

**The gap:** No CUSTOMER post-dispatch block parallel to changeStatus's PENDING/DRAFT-only gate, and the code does not enforce the operator+driver scope its own comment claims.

**Evidence:** apps/api/src/orders/orders.service.ts:2542-2551 (only CANCELLED blocked; comment scopes the relaxation to operator+driver), :2604-2609 and :3519-3540 (postDeliveryEdit -> resync runs for any role), :2748, :2821-2853 (full replace, create omits deliveredQty), :2145-2156 (changeStatus's CUSTOMER gate, the missing parallel); apps/api/prisma/schema.prisma:1438 (deliveredQty @default(0)); apps/api/src/invoices/invoices.service.ts:1826-1844, :1915-1933 (a paid invoice is rebuilt in place and simply shows the new balance); apps/api/src/change-requests/change-requests.service.ts:70-85 (the flow this is meant to be the only path to once dispatched); apps/api/src/buyer/buyer.controller.ts:533-544.

**Suggested fix:** Add a CUSTOMER status gate to updateOrderItems mirroring changeStatus (buyers edit PENDING/DRAFT only) and route post-dispatch buyer edits through the change-request flow.

### B78 — Buyer's Urgent flag, requested delivery date and notes are dropped when the cart merges

**Area:** apps/api/src/buyer/buyer.controller.ts + buyer portal cart

**Meant to do:** A buyer's urgent flag, requested delivery date and notes are recorded on the resulting order identically whether or not the cart happens to merge into a pre-existing active order.

**Actually does:** The merge branch calls updateOrderItems with items only. UpdateOrderItemsDto has no urgent or requestedDeliveryDate field, and orderNotes is never populated from dto.notes — while the fresh-create branch forwards all three into create(). The web cart always sends all three regardless of which branch will run.

**The gap:** Identical buyer input produces different persisted state depending only on whether an active order pre-existed: the Mark-as-urgent checkbox and the requested date silently do nothing on a merge.

**Evidence:** apps/api/src/buyer/buyer.controller.ts:491-495 (merge branch, items only) vs :509-523 (fresh-create forwards all three); apps/api/src/orders/dto/update-order-items.dto.ts:91-131 (no urgent/requestedDeliveryDate); apps/api/src/orders/orders.service.ts:1929-1938 (set only in create()) and :4616-4626 (separate toggleUrgent); apps/api/src/buyer/dto/buyer-create-order.dto.ts:28-41; apps/web/app/buyer/portal/[seller]/cart/page.tsx:159-171, :522-528.

**Suggested fix:** In the merge branch, pass orderNotes from dto.notes and apply urgent/requestedDeliveryDate to the merged order (via updateOrderItems fields or a follow-up order.update in the same flow).

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.

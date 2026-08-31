# Spec — what F06 (updateOrderItems authorization + line build) must do

**Status:** `APPROVED`
**Stage:** S2 — Spec (what) · **Author:** Fable 5 · **Date:** 2026-08-31
**Lives at:** `.claude/pipeline/2026-08-31-f06-update-order-items/spec.md`
**Prev:** [discovery.md](./discovery.md) · **Next:** [ux-spec.md](./ux-spec.md) then [test-plan.md](./test-plan.md)

> This file is the only context downstream agents receive about *what* to build.
> Fix targets, verified on master 26037bd4 (all line refs current):
> `apps/api/src/orders/orders.service.ts` `updateOrderItems` :2735-3856 —
> status gate :2744-2753 · isDiffPayload + CUSTOMER-diff rejection :2755-2774 ·
> postDeliveryEdit :2798-2811 · CUSTOMER branch :2891-3058 (deleteMany :2950, unlisted
> create :2956-2978, shouldSplit :2989-2999, catalog create :3025-3057) · operator branch
> :3059-3690 (replaceAll add :3141-3236, diff add :3306-3405, qty-edit :3529-3675) ·
> resync :3774-3798. `apps/api/src/buyer/buyer.controller.ts` `createOrder` :517-561
> (naive merge :523-543, fresh-create :565-577). `apps/api/src/orders/orders.controller.ts`
> `foldMergeItems` :113-250 (staff exemplar, not exported). Web:
> `apps/web/app/(dashboard)/orders/[id]/page.tsx` (tier default :1551, addProduct :940-989,
> substitute :1282-1314, DRAFT auto-edit :1637-1689, loading gate :1691).

---

## 1. Core capability, in one sentence

> A buyer's order edits and cart merges can no longer overcharge, self-price, or rewrite
> delivered orders — and an operator's order edit no longer destroys earned promo discounts
> or prices lines before the customer's contract is loaded.

## 2. Core use cases, in priority order

| # | Use case | Priority | Justifies shipping |
|---|---|---|---|
| U1 | As a buyer, I add a box of a product I already have on my active order and am billed the correct box-aware total | must | ★ |
| U2 | As a seller, I trust that buyers cannot write their own prices or rewrite delivered orders | must | |
| U3 | As an operator, my replace-all order edit keeps the customer's earned BUY_N_GET_M free units | must | |
| U4 | As an operator, lines I add in the web editor are priced at the customer's contracted tier, never transiently at list | must | |
| U5 | As a buyer, my urgent flag / requested date / notes are recorded whether or not my cart merges | must | |

## 3. Completeness sweep (scoped to the touched flows)

| Lifecycle step | Meaning here | Decision | Req IDs |
|---|---|---|---|
| Create (buyer cart → merge) | denomination-aware fold; header fields carried | keep | R1, R2, R10 |
| Create (buyer cart → fresh order) | unchanged (already correct) | n/a — untouched | R13 |
| Edit (buyer full-replace) | unlisted preserved server-side; post-dispatch refused | keep | R2, R3, R4, R5 |
| Edit (driver non-diff) | byte-identical to today | keep (pin) | R6 |
| Edit (operator replaceAll) | BOGO snapshot preserved+rescaled | keep | R7, R8, R9 |
| Edit (operator diff-add) | freeUnits plumbing only (no snapshot exists on a fresh add) | keep | R9 |
| Edit (web operator UI) | pricing gated until customer context loads | keep | R11 |
| Delete / undo | unchanged (out of the touched paths) | n/a | — |
| Permissions | CUSTOMER: no unlisted authoring, no post-dispatch edits | keep | R3, R4 |
| Audit trail | existing appendOrderRevision covers edits; refused edits leave no side effects | keep | R4 |
| Notification | unchanged | n/a | — |

## 4. States, per surface

API surfaces (no new endpoints; behavior changes on PATCH /orders/:id/items,
PATCH /buyer/orders/:id/items, POST /buyer/orders, POST /buyer/shelf/add-all-low):

| State | Required behavior | Req ID |
|---|---|---|
| CUSTOMER edit, order DRAFT/PENDING/CONFIRMED | works as today (CONFIRMED reverts to PENDING) | R5 |
| CUSTOMER edit, order OUT_FOR_DELIVERY/PARTIALLY_DELIVERED/DELIVERED | 403 ForbiddenException naming the change-request flow, thrown before ANY side effect (no invoice revert, no line change, no revision, no status event) | R4 |
| CUSTOMER edit, order CANCELLED | 400 as today (existing gate) | R5 |
| CUSTOMER payload contains productId-null items | ignored: not created, not repriced; stored unlisted lines survive in place with ids | R2, R3 |
| DRIVER non-diff edit, any status | byte-identical to today's behavior (incl. unlisted authoring, post-dispatch) | R6 |
| Staff replaceAll on order with promoFreeUnits>0 line, price echoed/omitted | snapshot preserved + rescaled to the new qty; subtotal accounts free units | R7 |
| Staff replaceAll, price genuinely changed | MANUAL flip, free units cleared (today's qty-edit rule, now uniform) | R8 |
| Buyer merge with mixed denominations | boxes fold with boxes, pieces with pieces; re-split server-side; subtotal box-aware | R1 |
| Buyer merge with urgent/date/notes | notes appended, urgent OR-merged, date set-if-provided on the merged order | R10 |

Web surface (order-edit page) — states detailed in [ux-spec.md](./ux-spec.md); requirement here:

| State | Required behavior | Req ID |
|---|---|---|
| Customer pricing context in flight | add-product and substitute controls unavailable/disabled with a visible reason | R11 |
| Customer pricing context resolved | controls enabled; added/substituted lines price at contracted tier | R11 |
| Order has no customerId | controls available immediately (nothing to wait for) | R11 |

## 5. Non-functional requirements

| Area | Requirement | Req ID |
|---|---|---|
| Money | every monetary write through `computeLineSubtotal`/`roundMoney`; no re-derived `qty*unitPrice` for boxed lines; partial-invoice fixtures assert against the F03-capped `buildInvoiceItemData` formula, never an independent re-derivation | R1, R7 |
| Authorization | CUSTOMER-role restrictions enforced in the service (not the controller), so every route into `updateOrderItems` inherits them | R3, R4 |
| Tenancy | no new queries without tenant scoping; reuse `forTenant()`/`tenantTransaction` exactly as the method does today | all |
| Behavior freeze | staff POST /orders merge byte-identical after the `foldMergeItems` extraction (existing REG-B199 suite green) | R12 |
| Observability | refused CUSTOMER edits surface as ForbiddenException (visible in API logs like every 403) | R4 |
| No pool regression | B60 preservation reuses the already-loaded `bogoPromos` (:2855-2857) — zero new queries | R7 |

## 6. Overlap and scope fence

- **Extends:** F30's `foldMergeItems` (extracted to a shared module, reused by the buyer merge).
- **In scope:** the five API fixes + the B62 web gate + spec/project 24 e2e.
- **Out of scope:** everything in discovery §10 (staff-promo widening, fold product-lookup,
  change-request UX, invoices.service.ts writes, DTO urgent/date fields, web unit runner).
- **Do-not-introduce check:** no new deps, no new runners, no schema change.

## 7. Deploy day

- **Existing users:** buyer merges immediately produce correct denominations; operators' edits
  stop destroying snapshots; blocked post-dispatch buyer edits get a 403 with guidance (web
  buyer UI already hides editing past PENDING, so the 403 is API-surface only). No client
  updates required (verified: buyer clients send `{productId, qty}` only).
- **Existing data:** rows damaged by B47/B60-class writes stay as they are at deploy; the D4
  read-only candidate report runs post-deploy (repair flight only with evidence + backup).
- **Backfill / migration:** none. No schema change.
- **Gate/entitlement:** none — behavior fixes on existing paths.

## 8. Rollback

- **Kill switch:** none (no flag); rollback = revert the squash commit — safe, no schema change.
- **Blast radius if wrong:** money math on order lines (over/under-billing), buyer-edit
  regressions. Mitigated by the pinned-suite no-regress list (§9 notes) + red-gated REG tests
  + mutation probes + Fable final pass (money batch).
- **Detection:** post-deploy-check + feature-smoke + deploy-triggered e2e; REG suite in CI.

## 9. Requirements table

| ID | Requirement (observable) | Priority | Verification | Test IDs |
|---|---|---|---|---|
| R1 | Buyer add-to-active-order merges denomination-aware: an existing box-split line (boxes=2, upb=12, qty=24) plus a cart add of 1 box (boxes=1, qty=12) yields one line boxes=3/qty=36 billed 3 x box price; a box-unaware existing line (boxes null, qty=2 meaning 2 boxes) plus 1 box add never bills box-price x (2+12) | must | unit (fold) + integration (service) | T1, T2, T3 |
| R2 | A stored unlisted (productId-null) line survives a CUSTOMER full-replace edit or merge verbatim: same row id, name, qty, unitPrice, notes, status | must | integration | T4 |
| R3 | A CUSTOMER payload cannot create a new unlisted line nor change a stored one's price/qty, whatever name/qty/unitPrice it supplies; DRIVER unlisted authoring unchanged | must | integration (negative) | T5, T6 |
| R4 | A CUSTOMER items-edit on an OUT_FOR_DELIVERY, PARTIALLY_DELIVERED or DELIVERED order is refused 403 before any side effect: no invoice revert, no line mutation, no revision append, no status event | must | integration (negative) | T7 |
| R5 | CUSTOMER edits on DRAFT/PENDING/CONFIRMED behave as today; CONFIRMED edit still reverts the order to PENDING (existing pinned behavior) | must | integration (existing pin + new) | T8 + existing F10-002 |
| R6 | DRIVER non-diff edits behave byte-identically to today at every order status, including post-dispatch | must | integration | T9 |
| R7 | A staff replaceAll edit of an order holding a line with promoFreeUnits>0 preserves and rescales the snapshot to the new quantity when the line's price is omitted or echoes the stored price; the new subtotal accounts the free units | must | integration | T10, T11 |
| R8 | A staff replaceAll line whose supplied price differs from the stored price flips to MANUAL with free units cleared (uniform with the qty-edit rule) | must | integration (negative) | T12 |
| R9 | Both operator add blocks pass freeUnits into computeLineSubtotal and persist promoFreeUnits on create (behavior-neutral today: staff promos are `[]` by design — the P5-04 invariant stands) | should | integration + type | T13 |
| R10 | A merging buyer cart's notes are appended to the order's notes, urgent=true is applied (never cleared by urgent=false), and requestedDeliveryDate is set when provided — on the same order the merge returns | must | integration | T14 |
| R11 | Web order-edit add-product and substitute controls are unavailable until the customer pricing context (customer detail + customer prices) has resolved; once resolved, added lines price at the contracted tier; orders without a customerId are not gated | must | e2e (Playwright, spec 24) — campaign D1 | T15 |
| R12 | The staff POST /orders merge is byte-identical after the foldMergeItems extraction (existing REG-B199/scan-hardening suite green, zero edits to those tests) | must | existing suite | existing REG-B199 |
| R13 | The buyer fresh-create branch (no active order) is unchanged: same create() call, same fields | must | integration | T16 |

## 10. Assumptions (unverified) — MANDATORY

| # | Claim | Basis | Confirm | R#s | Status |
|---|---|---|---|---|---|
| D-A5 | Preserving unlisted rows in place keeps delivery/invoice FKs valid (no delete+recreate on those rows) | design choice avoids the question; schema read | REG-B51 test asserts row id stability (T4) | R2 | verified by design + T4 |
| A8 | `findActiveOrder` returns line rows sufficient for MergeLineSnapshot (qty, boxes, pieces, unitPrice, priceType, productId, notes) | Plan-agent read of orders.service.ts:535-551 | TP2's fixture compiles against the real call shape | R1 | confirmed 2026-08-31 |
| A9 | `toggleUrgent(orderId, user, true)` has CUSTOMER ownership check + explicit-set semantics | Plan-agent read of orders.service.ts:4873-4884 | T14 exercises it via the merge path | R10 | confirmed 2026-08-31 |
| A10 | No existing test pins the naive buyer merge payload (free to change) | buyer.controller.spec.ts read: addAllLow tests spy on createOrder only | red gate + full suite green | R1 | confirmed 2026-08-31 |

---

## STOP GATE — S2 → S3/S4 · **PASS**

| Stop condition | Evaluated? | Answer | Verdict |
|---|---|---|---|
| Completeness sweep decided on every row | yes | §3 | pass |
| Surfaces cover states or n/a with reason | yes | §4 (API state matrix; web states in ux-spec) | pass |
| Gate-key match | n/a — ungated | §7 | pass |
| Rollback, blast radius, detection written | yes | §8 | pass |
| Every R# has priority + verification; negative R#s present (R3, R4, R8) | yes | §9 | pass |

**Gate outcome:** PASS. **Assumptions carried into S4:** A7 (campaign runs artifact production — close-out concern only).
**Approved by:** session (owner-delegated) · 2026-08-31

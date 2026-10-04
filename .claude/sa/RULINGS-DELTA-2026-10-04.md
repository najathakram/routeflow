# SA rulings delta — Mac mini SA seat, SA-650 … SA-659 (2026-10-04)

Full register lives on the Mac (2.2 MB, over the repo's 1 MB file guard); this is the delta since SA-649.

## SA-650: counter sales round 2 (owner rulings). No naming conflict. FOUR semantic flags to settle BEFORE the PRs (one is schema)

**F-A (SCHEMA): a per-order pickup marker has nowhere to live.** `FulfillPath` is `{ROUTE, SHIP}` (`sales.prisma:57`), on both `Order` and `Customer`. "Pickup labels are per order", plus the order-ahead flow, needs the order to KNOW it is a pickup.

- (i) `FulfillPath` gains `PICKUP`. That is an `ALTER TYPE … ADD VALUE`, so an owner-run migration (sitting rules: fingerprint, drift, backup); it can't ride an ordinary deploy.
- (ii) No schema: the marker is derived (tenant mode `pickup` + the order's origin/path). That's fragile for the "unless explicitly marked shipped" case, and for a tenant that later changes mode (history would relabel).
- **Recommended: (i).** Data must say what happened. Plan the migration as its own small sitting; until then, ship nothing that depends on per-order pickup.

**F-B (STOCK, money): "stock at pickup" vs today's decrement at order time.** Today a non-draft order decrements stock at CREATE (`decrementStockForSale`), and a portal order is non-draft.

- If pickup-complete ALSO decrements, every order-ahead pickup double-counts. If the portal order instead becomes a no-stock draft until pickup, oversell and reservation semantics change (WS9 policy).
- **Rule:** exactly ONE SALE decrement per unit across create → pickup-complete. Recommended: KEEP the decrement at order creation (the goods are set aside for the customer); pickup-complete moves NO stock.
- Pin: Σ SALE movements for an order == its pieces, whether or not it went through pickup-complete.

**F-C (INVOICE + PAYMENT): pickup-complete must reuse the existing delivered path.**

- `POST /orders/:id/pickup-complete` = the transition to DELIVERED through the same `changeStatus` code, which already auto-creates and reconciles the invoice. Plus an optional payment in the SAME tx: idempotency key, the B83 over-collection rule, on-account = no payment.
- No second invoice writer.
- "Ready for pickup" / "Picked up" are DISPLAY labels over the existing enum, exactly like "Shipped" (no enum change): CONFIRMED → "Ready for pickup", DELIVERED → "Picked up", keyed on the order's pickup marker (F-A), never on the tenant mode alone (R3's principle).
- Pins:
  - pickup-complete twice → one invoice, one payment;
  - payment > due → the existing over-collection behaviour;
  - a cancelled or already-delivered order → 409.

**F-D (precedence): two rows, one answer.**

- `fulfilment_model = pickup` → every STAFF order goes through the counter path (`createSale`-style: delivered at once) UNLESS explicitly marked shipped. `counter_sales = on` only ADDS the counter option for a non-pickup tenant.
- The capability answer computes ONE `counter: "always" | "optional" | "off"` (pickup → always; `counter_sales on` → optional; else off), so no client combines the two rows itself.
- R1 still holds: fleet = modules only. `pickup` + fleet ON is allowed, like `ship`.
- "Unless explicitly marked shipped" means a per-order SHIP choice, which then follows the existing SHIP path. Shipping semantics still key on SHIP / mode `ship` (R3).

**Naming: no conflict.**

- "In-store retailer" with mode key `pickup` and label "In store" is fine.
- Replace `pickup_counter` NOW, while no tenant has it applied. Pin: the registry has no `pickup_counter` reference and no stored config row uses it (a read-only count on prod before the rename lands).
- For before==after, every new value is opt-in; UNSET is today.

**Ordering:**

- F-A's decision first (if (i), a sitting).
- Then the capability `counter` answer + the mode (`ga` "pickup").
- Then pickup-complete (tier 1: invoice + payment), reusing the delivered path.
- The counter path for staff orders reuses `createSale` (tier 1).
- Posted: #2554 comment 5977294636.

## SA-651: #3161 (B1031) DRAFT @d3ead9477d2eaeb7818036a060fc1c3281fb87a7 (stacked on #3135). The two MEDs are RULED; there's one shared change for #3135, plus follow-ups

The totals pins (h)–(k) are as specified (14 specs, 9 red on master). The Opus verdict is SHIP WITH NOTES.

**MED 1: up-front, unlocked judging of the bulk batch. ACCEPTED, with 2 additions.**

- Each invoice's tx re-judges under its own locks, so EVERY invoice stays sane. The residual risk is a PARTIAL batch: N changed between the pre-flight and its tx, after 1..N-1 committed. That is an operational inconsistency, not money corruption.
- Holding locks across a whole bulk batch isn't worth its lock footprint.
- **Additions (fold them):**
  - (a) YES to the "Invoice X:" prefix on the tx-side refusal;
  - (b) a mid-batch refusal returns a STRUCTURED partial result `{applied: [invoiceIds], refused: {invoiceId, code, message}}` with fixed copy ("N of M invoices were updated; invoice X changed while saving — review it"), never a bare error that hides what committed.
- Pin: a race injected on invoice 2 of 3 gives 1 applied, 2 refused with its prefix, 3 per the chosen semantics (stop or continue; state it), and the response lists them.
- Document in the code: "all-or-nothing is judged at pre-flight; the tx re-judges per invoice".

**MED 2: the totals guard re-judging untouched stored data. NOT intended as built. Rule: NOT-WORSE.** `assertInvoiceTotalsSane` is document-level, so it necessarily sees every line, including legacy lines and a legacy discount. Refusing ANY edit of an invoice that was already insane traps it forever, and blocks a whole customer batch because of old data.

- **Refuse only when the edit makes the totals insane from sane, or makes an already-insane invoice WORSE.** "Worse" = the total decreases, or the excess `discount − subtotal` increases.
- An edit that leaves a legacy-insane invoice no worse, or improves it (e.g. a price raise), SAVES.
- **Mechanism:** one change, in the shared guard (it belongs to #3135's base, so FOLD IT INTO #3135, which B1031 already stacks on): `assertInvoiceTotalsSane(after, before?)`.
  - With `before` given and already insane, it applies the not-worse test. create() passes no `before` (strict, as today).
  - update() (both paths) and the B1031 re-price pass the stored totals as `before`.
- **Pins:**
  - a legacy −45 line + a re-priced line that RAISES the subtotal → saves; the same line LOWERED → refused;
  - a legacy discount > subtotal + a raise → saves; + a cut → refused;
  - a bulk batch containing a legacy-insane invoice that the re-price makes no worse → the batch saves;
  - one it makes worse → the whole batch is refused with that invoice named;
  - a sane → insane edit → refused (regression).
- The line guard (SA-640, edited lines only) is unchanged.

**Report-only items: follow-ups (MEDIUM, file them).**

- `reconcileOrderDraftInvoice`, `rebuildSiblingDrafts` and the order→invoice resync paths still write invoice totals unguarded. Route every invoice-totals writer through the same `assertInvoiceTotalsSane(after, before)`, so not-worse holds everywhere (the SA-640b MED folds into this).
- **Separate read, flagged: "reconcileOrderDraftInvoice incl. ISSUED deposit mirrors".** An ISSUED invoice's totals being rewritten by a background reconcile must be checked against the house rule that issued documents change only through the audited edit path. File it as its own SA read, not part of B1031.

**Gates:** the not-worse fold lands in #3135 first (tier 1; F2 runs the full invoices DB lane); B1031 re-runs on top; real CI on both; my delta read of the fold.

- Posted: #2554 comment 5977359624.

## SA-652: B1049 (#3163). Is a background reconcile allowed to rewrite an ISSUED deposit-mirror invoice's totals? YES, by design (WP-D1), but ONLY with 4 conditions. Two are REQUIRED fixes (regulated ledger, audit)

**What master does** (`invoices.service.ts` `reconcileOrderDraftInvoice` :1387-1575, the WP-D1 widening):

- **When.** There is no open draft, AND the order isn't DELIVERED/CANCELLED, AND the order's SOLE non-void invoice has `depositPercent != null`, no `deliveryBatchId`, and status SENT/VIEWED/PARTIAL/OVERDUE. That is a deposit-collect-at-order mirror issued at placement.
- **What happens.** The reconcile rewrites its items, subtotal, tax, fee and total from the order:
  - payments are untouched;
  - status is recomputed from confirmed payments vs the new total;
  - `pdfUrl` is cleared;
  - commission is re-synced;
  - `invoice.updated` is emitted.
- A plain operator-issued SENT invoice (no deposit) is NEVER touched. `update()` refuses hand-edits of a non-DRAFT invoice, so the ORDER is this document's only edit surface.

**Ruling: allowed in principle.** A deposit-collect mirror is the ORDER's priced shadow until delivery. Freezing it would leave the deposit invoice billing an order that no longer exists. The gate is narrow (sole invoice, deposit, pre-delivery), and money that was received (payments) is never rewritten.

It is allowed ONLY with these conditions:

**C1 (REQUIRED, regulated ledger).** The function deliberately skips the ledger re-sync ("legacy single-draft rebuild … would double-count a folded regulated line against its live sibling SALE"). That reason CANNOT apply to this branch: the deposit mirror is by construction the order's SOLE non-void invoice, so there is no sibling.

- If the issued mirror carries regulated lines, its SALE rows (written at issue) go STALE after an order edit, and the regulated report mismatches the invoice.
- Fix: in the `isDepositMirror` branch only, call the existing `resyncInvoiceLedger(draft.id, orderId, itemsData, db)` (reverse `{preserveReturns:true}` + rewrite, current period per the never-backdate rule), in the same tx.
- Pins: an issued deposit mirror with a regulated line, qty edited on the order → ledger SALE == the new qty; a non-regulated mirror → no-op; a plain DRAFT mirror → unchanged (no ledger write).

**C2 (REQUIRED, traceability).** An ISSUED, customer-visible document's money changes with no invoice-level record.

- Write an audit row in the same tx: `invoice.mirror_reconciled` with before → after `{subtotal, taxAmount, shippingFee, total, status}` and the triggering order id.
- The UI's `invoice.updated` handling should prompt "re-send the updated invoice" (LOW, UI).

**C3 (REQUIRED, money visibility).** When the new total drops BELOW confirmed payments, the status lands PAID and `balanceDue` floors at 0. The overpayment "is surfaced by the existing credit-note workflow", i.e. nobody is told.

- Raise a visible needs-review signal (the same platform/tenant follow-up channel used for money follow-ups; fixed copy: "Invoice X is now overpaid by $Y after the order changed — issue a credit"). Never a silent overpayment.
- Pin: an edit that drops the total below paid → the signal fires once, with Y = paid − total.

**C4.** The B1048 not-worse totals guard (SA-651) applies to this writer too. It is already covered by B1048's scope.

**Not found / noted.** There is no bookkeeping period-close lock on master (grep clean), so there is no closed-period conflict today. If a period lock is added later, this rewrite must respect it (issue-date period).

**Fix scope:** C1 + C2 + C3 in ONE tier-1 PR (invoices + regulated ledger). F2 runs the full invoices + regulated ledger DB lanes by import graph; the lead's Opus; my delta read. It is not in this release's critical path unless a deposit tenant onboards.

- Posted: #2554 comment 5977371228.

## SA-651a: #3135 (B1030) head 1ad2d73b069a402ee7064fea5c550586934005d3. CONFORMS to SA-651 MED2 (NOT-WORSE)

- **Guard.** `assertInvoiceTotalsSane(after, before?)`: a sane `after` → pass. An insane `after` passes ONLY if `before` was already insane AND it is not worse:
  - the total did not go down;
  - `discount − subtotal` did not go up (epsilon 1e-9, so no float false-refusals).
- Otherwise it refuses, with create()'s exact messages (discount first, then negative total).
- **Callers.**
  - `create()` passes no `before`, so it stays strict.
  - The items path passes `storedInvoiceTotals(cur)`, where `cur` is read in the tx under the Invoice lock.
  - The recalc path passes `storedInvoiceTotals(inv)`.
  - `storedInvoiceTotals` normalises Prisma Decimals.
- **Pins.**
  - Unit (1)–(7): sane→insane refused; worse by total / by excess refused; unchanged saves; improved saves; create strict; a negative total not worse saves.
  - Service (b)/(b2)/(b3)/(f)/(f2): legacy shipping-only saves; a bigger discount is refused; a lowered discount saves; sane lines-down is refused; legacy lines-up saves.
- The SA-640 line guard (edited lines only) is unchanged.
- **LOW (no block).** The recalc path's `before` comes from the update's initial read, not a locked re-read (the items path re-reads under the lock). A concurrent edit can only make the comparison stale, never let a sane invoice go insane, because a sane `after` passes on its own merits and an insane `after` still needs an insane `before`. Fold a locked re-read into B1048 when it routes all writers.

Gates: F2 runs the FULL invoices DB lane at the landing sha; real CI; then B1031 (#3161) re-runs on top.

- Posted: #2554 comment 5979178458.
- #3188 @c432215a pre-read notes (final read at the NEW head):
  - R1 fleet = recurring_routes||order_delivery (matches the client hooks; developer_mode excluded per the owner 08-28 decision);
  - the 409 is delivery/both only;
  - unset correction present;
  - F-D counter derivation OK;
  - PICKUP is a capability method but NOT a FulfillPath value (F-A), so clients must route pickup to the counter path and never send fulfillPath PICKUP;
  - nit: the 409 uses this.can() while the capability uses heldAddonKeys: use ONE resolver.

- LEAD RULINGS (2026-10-04, the lead handing over at 98%):
  1. Customer `notes` = STAFF-INTERNAL; exclude it from the buyer self-service allowlist (and the buyer-portal profile body).
  2. #3190: narrow DTO via PickType(UpdateCustomerDto, [...]); one list = the single source.
  3. F-A: the FulfillPath PICKUP migration is OWNER-APPROVED (17:30Z sitting; its own migration, never used in the same tx; owner yes per run). It ships with or before the counter-sale/pickup-complete API, and updates #3188's F-A pin in that same PR.
  4. #3188: lead delta PASS at 10ba87f2; SA final read is the last gate.

## SA-653: #3190 (B1055) @d1c32a5cc2b72c5037eb912662efb577cc2b91cf: customer self-service profile write. CONFORMS on tenancy and money, with 2 conditions

**Tenancy and money: conforms.**

- The self-service profile endpoint stays CUSTOMER-only and resolves the caller's OWN customer (unchanged).
- The write now passes TWO filters: the narrow buyer-profile body type, and an explicit server-side allowlist (`self-service-fields.ts`, 13 contact and preference fields) applied before `update()`, whatever the body carries.
- None of the seller-controlled commercial fields (tax status, price tier, credit limit, payment terms, deposit default, currency, tax id, customer type, fulfilment path) is writable from self-service.
- The staff edit endpoint (OPERATOR) is unchanged.
- The B956 name guard still runs in `update()`.
- The self-service email is CONTACT data only: `update()` does not touch the login identity.
- The allowlist == the buyer-profile body field set (13 = 13). The specs (13, 11 red on master) cover the body type, all-commercial-fields-at-once, own fields still work, and unknown keys dropped.

**Conditions:**

1. **Validation parity (fold it).** Moving this endpoint to the buyer-profile body type WEAKENED validation versus the staff body type: no email format, no length bounds (the staff type caps businessName 200, contactName 120, phone 40, email 254, notes 2000).
   - Derive the narrow type from the staff type (`PickType(UpdateCustomerDto, SELF_SERVICE_FIELDS)`, or the same decorators), so each shared field keeps one validator set.
   - Pin it: an over-length field and a malformed email are refused on self-service, the same as on the staff edit.
2. **One list.** Keep the allowlist and the narrow type the SAME list. Pin that the body type's keys == `SELF_SERVICE_FIELDS`, so neither drifts.

**Question for the owner/lead (no block on this PR):** `notes` is self-service-writable. That was ALREADY true via the buyer portal profile, so it isn't new here. Confirm the customer `notes` field is the buyer's own note, not a staff-internal one. If it's staff-internal, remove it from BOTH paths.

Tier 1 (security). Real CI. F2 runs the customers lane.

- Posted: #2554 comment 5980405617. Lead answered the notes question: STAFF-INTERNAL, so exclude it.

## SA-654: #3188 (minimal fulfilment-model PR) FINAL READ @10ba87f2e0fcfb761dc2275475fa8c878b38caeb. CONFORMS (the last gate), with one small fold

**Verified on read:**

- **R1.** ONE fleet resolver, `isFleetHeld` (add-on rows, overrides absolute, the same as `/tenants/me/addons` and the client hooks; `recurring_routes` || `order_delivery`; `driver_payments` deliberately excluded, as accepted by the lead). It is shared by the capability answer, `FeatureConfigService.set()`'s 409 and `getState()`'s `blocked`. The 4-case agreement test pins that they can't disagree.
- **409.** `FULFILMENT_MODE_NEEDS_FLEET` applies ONLY to `delivery`/`both` without fleet. `unset`/`ship`/`pickup`/`pickup_ship` are allowed (pinned), and `getState` shows delivery/both as blocked (M2).
- **R3 / unset == today.** `deriveFulfilmentCapability`: unset → methods ROUTE+SHIP, staffDefault ROUTE, portalMethods `[]`, portalDefault `null`, counter off, consistent true. SHIP semantics come only from the ship-family modes.
- **F-D.** `counter` = always (pickup / pickup_ship) | optional (`counter_sales` on) | off.
- **F-A.** PICKUP is a capability method only: the enum has no PICKUP and the order DTO rejects it (pinned, and the type is commented). Per the lead, the owner-approved PICKUP migration (17:30Z sitting) must update this pin in the same PR that adds it.
- **M1.** A failed fleet read is the existing 503 `FEATURES_UNAVAILABLE`, never a bare 500 and never a guessed `fleet:false`.

**Fold (small; before landing, or as an immediate follow-up if it would miss the window).** The two MODE reads still `.catch(() => "unset")`. A transient read failure for a `ship` tenant would then answer "today" (ROUTE default, ROUTE+SHIP offered): a guess, which is exactly what M1 forbids for fleet.

- Make the mode-read failure the same 503. A genuinely absent row still resolves to `unset` normally, through `getEffectiveMode`, not via the catch.
- Pin: a failed `fulfilment_model` read → 503.

Gates: real CI at the landing sha. F2 runs the billing + tenants lanes by import graph.

- Posted: #2554 comment 5980903016.

## SA-655: Counter sale reuses createSale (lead design). CONFIRM WITH AMENDMENTS (Mac mini SA, 2026-10-04, @ master ab3828fa)

createSale is four separate commits (create os.ts:2265, DELIVERED :2290, invoice :2301, send :2323), not one tx.

1. Idempotency: use existing `Order.idempotencyKey` (sales.prisma:645, @@unique([tenantId, idempotencyKey]) :670). create() already replays (orders.service.ts:1529-1560, P2002 branch :2105-2130). Add idempotencyKey to CreateSaleDto and pass it to create(). No clientRequestId column; isWalkIn migration carries only the walk-in flag.
2. createSale replay branch: on a replayed order, look up its invoices and resume from the first undone step (no invoice → create; DRAFT → send). Never mint a second invoice (today a replay 500s at :2310).
3. A failed invoice step leaves DELIVERED + stock decremented + no AR; the same-key retry finishes it via (2). Client keeps the key until a 2xx.
4. recordPayment (invoices.service.ts:4541) has no key. On replay, record a payment only if the invoice has no non-VOID payment; 201 reports paymentRecorded from stored state.
5. send() = markSent auto-applies the customer's oldest credits (:3525). For isWalkIn: 409 up front if any open credit; validate the amount against the post-send balance; change-giving is client-side; never sendEmail.
6. skipAutoMerge bypasses every merge path (:1568, :2072, :636, :705/:724). Take no withAdvisoryLock; a second lock is forbidden.
7. Stock decremented once at create (:2044). Do not stamp deliveredQty (would enter B1050). Corrections via return/credit note until B1050 lands (B1063).
8. PICKUP reader sweep: trips.service.ts:184/:104; mobile CustomerForm.tsx:83; FULFILL_PATH_VALUES in packages/types enums + parity (L-072); pass fulfillPath PICKUP explicitly in createSale.
9. Migration order: emails 20261003120000/120100 → PICKUP alone (ADD VALUE, unused in that migration) → Customer.isWalkIn; each after 20261003120100.
   Confirmed: createInvoiceFromOrder rounds via @routeflow/pricing and prorates boxed lines (SA-145 shape). Post-commit payment failure → 201 {paymentRecorded:false}, invoice open on account, acceptable with a staff list of open walk-in invoices.

## SA-655a: #3191 (B1056) @a6563c90b826d20f72983dec4067d99176aa4b2b. CONFORMS-WITH-NITS (Mac mini SA)

MED: guard compared emails normalized but `emailChanged` compared raw (users.service.ts ~L236) → a no-op save on a mixed-case stored admin email ran email side effects. Folded at 8f26dc027fc2272c0f220715a4c7a9e2204a9ee9 (one normalized comparison drives guard, write and side effects; username trimmed too). INFO: platform-admin resetTenantAdminPassword (:1785) is an audited SUPER_ADMIN carve-out, held for the owner. DELETE /drivers/:id → B1061.

## SA-654a: #3188 @10ba87f2 final read. CONFORMS-WITH-NITS. catch→503 NOT required before landing; required in/before the first PR reading capabilities.fulfilment (B1062). Profiles apply must write modules before fulfilment_model or validate post-apply state (FeatureConfigService.set :192).

## SA-656: Fulfilment resolver (R1). AMEND (Mac mini SA draft; PC SA lane owns from here)

1. One pure resolveFulfillPath({requested, stored, capability, surface}) called at orders.service.ts:1605; no caller computes a path.
2. Mode read fails closed (503 FEATURES_UNAVAILABLE); this PR carries the tenants.controller.ts:106-107 fold (B1062). Absent row → unset.
3. Order: explicit request → stored if in methods/portalMethods → default. Explicit outside methods → coded 400 (API_ERROR_CODES + packages/types).
4. Only explicit requests 400; buyer createOrder never sends a path (buyer.controller.ts:721-734).
5. Templates gap: order-templates.service.ts:848-860 creates with no fulfillPath (schema default ROUTE) — must call the resolver (staff), never 400. Recurring/import N/A.
6. PATCH fulfil-path (order-lifecycle.ts:106-116) = explicit request → same check.
7. Merges ignore fulfillPath (orders.service.ts:628-640, :715-725, :1219-1227): add fulfillPath equality inside the existing withAdvisoryLock. Pin ROUTE pending + new SHIP → 2 orders.
8. "delivery unchanged" is false: delivery methods = ["ROUTE"] (fulfilment-capability.ts:15). Accept (no tenant has a mode); state it in the PR body. unset/both byte-identical; consistent===false → unset rule.
9. PICKUP writable only after #3195; order #3188 → #3195 → resolver PR. Resolve at create only.

## SA-657: Invoice at shipment (R2). CONFIRM (a) with amendments, REJECT (b) (Mac mini SA draft; emails branch 4e403918 was NOT on origin — re-read at its pushed sha)

1. "Pending mirror" is derived in 3 places (api invoices.service.ts:3424-3441; web lib/invoice-pending-mirror.ts:6-20; mobile lib/invoices-logic.ts:87,:103) → one server predicate, `invoice.pendingMirror` on the wire.
2. Unlocked when fulfillPath===SHIP && shippedAt!=null && mode ∈ {ship, both, pickup_ship}; unset/delivery byte-identical.
3. Failed mode read keeps it locked (503 on send).
4. Shipment unlocks SEND/sendEmail only; EDIT stays locked (allowPreDelivery precedent :708-717).
5. Reconcile at shipment via reconcileOrderDraftInvoice (:1387), basis "order"; any figure via computeLineSubtotal/roundMoney.
6. No partial shipments (order-level tracking); per-line shipped qty needs its own ruling.
7. Shipment writes no stock and no deliveredQty (B1050).
8. No double invoice at DELIVERED (:1624-1627 DRAFT-only; :540-548 remaining ≤ 0). Pin ship → send → DELIVERED = 0 new invoices, total unchanged.
9. Hazard: rebuildIssuedDepositMirrorOnDelivery (:1716) would restate a shipment-sent deposit invoice toward $0 — exclude shipment-finalized invoices; red case.
10. Post-shipment line edit must take resyncOrderInvoicesForEdit (preserveStatus).
11. Reject auto-send: master has no tenant-level invoice auto-send setting (only recurring :76/:488).

## SA-659: #3195 FulfillPath PICKUP @108ddc7d4a640258a9101bdc072b803f76a70c5c. BLOCK (2 fixes, then CONFORMS) (Mac mini SA)

Conforms: migration 20261004150000_fulfil_path_pickup is ADD VALUE only (lock_timeout 5s), newest, no rows touched; split --check OK; Squawk exit 0; FULFILL_PATH_VALUES + ENUM_TABLE; one WRITABLE_FULFILL_PATHS list; #3188 pin plan stated.

1. HIGH: trips.service.ts:184 (`not: SHIP`) and :104 (`=== SHIP`) unchanged → PICKUP orders pass trip eligibility, then routes.service.ts:981 drops them. Fix: `=== ROUTE` / `!== ROUTE`; spec PICKUP ineligible.
2. MED: mobile CustomerForm.tsx:83, web CustomerFormModal.tsx:156, mobile drafts-payload.ts:381, NewOrderScreen.tsx:599 coerce non-SHIP → ROUTE. Pick: (a) preserve unknown values / omit unless changed, or (b) rule Customer.fulfillPath never holds PICKUP and pin it.
3. LOW: hand-typed "ROUTE"|"SHIP" at web lib/api/orders.ts:39, mobile lib/api/admin.ts:136; web orders/[id]/page.tsx:3397 select lacks PICKUP.
4. LOW: CI red until #3194 lands (hard order). 5. LOW: local:drift must run on the stack host before F2 PASS.

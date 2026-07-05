# Guardrails & Edge Flows — Implementation Spec

> Wiring spec for the failure-mode and friction guardrails. Design: `unified/guardrails.html`.
> Principle everywhere: **warn, offer a legal path, log — never dead-end** either party.

## 1. Offline mode & sync queue
- Operator sale builder, driver run view (stops, POD, payments) and inventory scanning work
  offline: actions append to a local queue (IndexedDB) with client timestamps + device id.
- Persistent "offline" bar with queued count; auto-retry with backoff; manual "Retry now".
- Sync rules: append-only events (scans, POD, payments) replay in order; stateful writes
  (stock counts, price edits) that conflict with newer server state land in a **review list**
  (accept mine / keep server) instead of overwriting.
- Queued payments post to AR with their *collection* timestamp, not sync time.

## 2. Credit limits
- Per-customer: `credit_limit`, `behavior` (`WARN` | `HOLD`), counts open AR incl. unpaid siblings.
- Operator guard at order create when limit would be exceeded — three exits:
  **Collect payment first** (opens Record Payment, order proceeds if under), **Proceed over limit**
  (audit-logged, flags account), **Cancel**. Buyer portal: checkout shows "needs seller
  confirmation" state instead of a block; order lands as `PENDING_APPROVAL`.

## 3. Short picks / partial fulfillment
- Loading check per run: picked qty vs ordered. Short line → deliver-short (invoice auto-adjusts
  to delivered qty, no credit note needed), **substitute** (picker, price-memory applies), or
  backorder (auto-adds to customer's next delivery draft).
- Buyer notified with reason + adjusted total; order timeline records the short.

## 4. Failed deliveries
- Driver marks a failed stop: reason (Store closed / Refused / No access / Can't pay COD) +
  required photo (timestamped, geotagged). Actions: retry later this run, move to next route day
  (creates stop on that draft run), or return-to-warehouse (restocks inventory, voids/credits the
  draft invoice). Buyer gets reason + new ETA push/email. Refusals open a Returns task.

## 5. Order cutoffs & delivery windows (buyer)
- Seller config: cutoff time per route day. Cart banner shows current target window + countdown;
  past cutoff it re-targets the next window — never blocks placing.
- Cutoff moves an in-cart target only; placed orders keep their promised window.

## 6. Minimum order value (buyer)
- Seller config: MOV per customer tier. Cart shows progress bar + "from your usuals" quick-adds.
- Below-minimum carts submit as a **request** (`PENDING_APPROVAL`): seller approves, or merges
  into the customer's next scheduled delivery.

## 7. Reorder price review (buyer)
- Any reorder (one-tap, template, standing order) diffs current vs last-paid prices.
  Changed lines shown old→new before placing; accept all or remove changed lines.
- Scheduled standing orders auto-place unless total delta > threshold (default 5%, seller
  config) → pauses for buyer approval + notification.

## 8. Disputes / report-an-issue (buyer → seller)
- From a delivered order line: type (Damaged / Missing / Wrong item / Price wrong), qty, photo.
- Creates a Returns-queue task on the seller side with the POD + photo attached; approval issues
  a credit note that auto-applies to the buyer's next invoice; buyer sees status inline.
- Price-wrong disputes route to the invoice, not returns; resolving updates price memory.

## 9. Failed payments (NSF / reversed)
- "Mark payment failed" on a receipt: reverses application (invoice reopens with full balance),
  optional returned-check fee line, starts dunning schedule (day 0/3/7 reminders), flags the
  account (e.g. "cash only"). Original receipt kept, marked `REVERSED` — audit trail intact.

## 10. Duplicate prevention
- On customer/product create and on import: fuzzy match (name + phone + address / SKU + barcode).
  Inline "possible duplicate" card with **Open existing / Create anyway**.
- Import matches land in a review list with one-click **merge** (keeps both histories, remaps
  orders/invoices/price memory to the surviving record).

## 11. Run settlement (driver cash reconciliation)
- End of run: expected COD total vs counted cash + checks. Difference ≠ 0 creates a variance
  record tied to run + driver, surfaced in Reports. Payments post to AR at driver-record time.

## Acceptance
- [ ] All queues/guards work offline-first where marked; sync conflicts never overwrite silently.
- [ ] Every guard has ≥1 legal forward path; overrides/variances are audit-logged.
- [ ] Buyer-side guards (cutoff, MOV, price review, disputes) never hard-block checkout.
- [ ] Money invariants hold through adjustments: invoice totals re-derive from delivered lines.

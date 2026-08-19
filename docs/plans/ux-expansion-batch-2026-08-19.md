# UX Expansion Batch — 2026-08-19

**Status:** PLANNED, not started — the owner directs next steps (who implements, and when)
from their next session. This plan is self-contained for any implementer: recon anchors
(file:line), locked decisions, edge cases and error handling are all inline. Read
`CLAUDE.md` + `CLAUDE_SESSION_PREAMBLE.md` before starting; migrations follow the manual
backup-first prod flow, and the test-tenant policy is absolute.
**Owner input (locked 2026-08-19, do not re-ask):**

1. **Sequencing = quick wins first**: PR-A fixes/links → PR-B order-search-by-product →
   PR-C stock-count mode → PR-D variants → PR-E payment allocation → PR-F AI statements.
2. **Count mode = single counter, multi-ready**: one active device per session now, but the
   data model carries per-line attribution so simultaneous multi-person counting can be added
   without a migration later.
3. **Overpayment = on-account credit**: a payment above everything owed leaves the remainder
   as supplier/customer credit that auto-applies to the next invoice. Never blocked, never lost.
4. **AI statement matching = one review screen**: every proposed match lands on a single
   review surface — exact invoice-number matches pre-checked, fuzzy ones flagged — and one
   explicit Apply commits it all. Bulk-marking old bills paid ALWAYS gets its own second
   confirmation listing every affected bill.

**Design stance (intent framing).** The user is a wholesaler-operator on a phone in a truck,
a warehouse aisle, or at a counter with a customer waiting — distracted, gloved, on 4G. Every
flow below is judged against: (a) no dead ends — every screen always has at least one usable
action; (b) reversibility — counts, allocations and assignments can be edited or amended, and
anything irreversible gets a proportionate confirmation; (c) visible intent — previews show
exactly what a commit will do to money or stock _before_ it does it; (d) the system never
silently guesses about money — AI and auto-allocation propose, the operator disposes.

---

## PR-A — Fixes, full-flexibility inventory, cross-links (ship first)

### A1. Mobile invoice send must never dead-end (owner-reported)

Recon found **no hard contact-info block in the current tree** — `canSendInvoiceNow`
(apps/mobile/lib/invoices-logic.ts:92-94) gates on status/mirror-lock only, and the Share-PDF
row in `SendInvoiceSheet` renders unconditionally (components/SendInvoiceSheet.tsx:99-104).
What CAN produce the owner's experience: on a desktop/handset browser where the OS share API
is unavailable or the share fails, the sheet's only contact-free row silently degrades — and
the sheet has **no "Mark as Sent"** and **no explicit "Download/Open PDF"** row, so the
operator who shares manually (from their own phone contacts) has no path to completion.

Build, regardless of exact repro:

- Add a **"Mark as Sent"** row to `SendInvoiceSheet` (parity with web's `SendInvoiceModal`,
  apps/web/.../orders/[id]/page.tsx:189-206). Always visible. Copy: "Mark as sent — I'll
  deliver it myself." Calls the same mutation the invoice-detail dialog uses.
- Add an explicit **"Open PDF"** row (window.open path already in lib/share-pdf.ts) shown
  when `canShareFilesHere()` is false OR after a share failure — never rely on the share API
  alone. Every failure path keeps its toast (#360 rule).
- Keep phone/email rows hidden when absent (correct), but the sheet must always render at
  least: Share PDF · Open PDF · Mark as Sent. Update the "No phone or email on file" note to
  point at these: "…share or download the PDF, then mark it sent."
- **Ask the owner for the exact screen + tap sequence** they hit; if it reproduces somewhere
  else (e.g. an API-side guard), fix that too. Sentinel emails (`*@placeholder.local`,
  `*@imported.local`) stay unmailable and unsurfaced — that guard is correct and untouched.

### A2. Web inventory: search-and-open gets the full toolset (owner-reported)

Root cause (recon): the inventory search box's Enter/click handlers hard-code
`AdjustStockModal` (apps/web/app/(dashboard)/inventory/page.tsx:2499-2506, 2557-2563), while
the table row already offers Set cost / Adjust / Movements (:638-663). The searched item isn't
"missing fields" — the pick-handler only ever wires one destination.

- Selecting a suggestion **scrolls to and highlights the row** in the already-filtered
  StockTable (full action set), instead of force-opening Adjust.
- Each suggestion row gains inline actions: **Adjust · Set cost · Movements · Open product** —
  same set as the table row, plus the product link.
- Add an **"Open product"** link to StockTable rows (currently only Movements links out).
- Product detail page gains a **"Set cost"** action opening the same `SetCostModal`
  (products/[id]/page.tsx "Stock & Cost" card, :1292-1349, currently read-only). Cost stays
  modal-driven on purpose: every cost change writes an auditable COST_BASIS movement — a raw
  editable field would bypass the audit trail. The modal, not the discipline, becomes
  reachable from everywhere.

### A3. Cross-links (owner-reported, both surfaces)

| Link                                                                | State                                                                                                                                       | Fix                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Web movement row → product                                          | MISSING (inventory/movements/page.tsx:188-197, plain text)                                                                                  | Product cell → `/products/[id]`; supplier cell → supplier page                            |
| Web customer page order rows → order                                | MISSING (customers/[id]/page.tsx:136-160)                                                                                                   | Order # becomes a Link + `onRowClick` (packages/ui Table already supports it)             |
| Mobile customer "View orders"                                       | BROKEN scoping — pushes `customerId` param but orders index drops it ((tabs)/orders/index.tsx:69-81; hook accepts it, lib/api/admin.ts:226) | Read the param, forward to `useAdminOrders`, show a dismissible "Customer: X" filter chip |
| Mobile movement → product, order→customer (both), product→movements | EXIST (#360)                                                                                                                                | —                                                                                         |

### A4. NEW CRITICAL (found during D1 verification, pre-existing): driver edits wipe orders

`apps/mobile/app/(driver)/route/stop/[stopId]/edit-items.tsx` mounts the shared editor, which
sends an incremental diff (`{id, action}` entries, `replaceAll:false`) — but the server routes
DRIVER to the always-replace branch (orders.service.ts:2136), which `deleteMany`s all lines
and re-creates only entries carrying `productId`. **A driver saving any item edit deletes
every untouched line on the order.** Fix server-side: route incremental-diff payloads through
the diff branch regardless of role (keeping the driver re-pricing + no-price-control posture),
or reject diff-shaped payloads on the replace path with a 400 instead of destroying lines.
Spec-pin both. This ships in PR-A because it is live data loss.

---

## PR-B — Find orders by product, and see what we sold it for

**API:** `ListOrdersDto` gains `productId?` (orders.service.ts findAll adds
`where.lineItems = { some: { productId } }` — `OrderItem.productId` is already indexed,
schema.prisma:1330/1386). Response rows gain nothing — the existing shape already renders.

**Product sales history:** extend the existing per-product readers (analytics
price-history/cost-history read INVOICED sales via common/invoiced-sales.ts — StockMovement
SALE is dead, never read it) with a `GET /analytics/product-sales/:productId` list: per-line
{date, order #, orderId, customer, qty (boxes+pcs formatted), unit price, line total,
overridden?}. Query through `Invoice.findMany`, never `invoiceItem` directly (nested-created
lines can carry tenantId=null and would be silently dropped).

**Web UX:** orders list gains a product filter (same `SearchableProductPicker` used
everywhere) rendered as a removable chip; product detail gains a **"Sales" tab**: the
price-per-buyer table (sortable by date/price), each row linking to the order and the
customer. Answer the owner's actual question at a glance: "who bought this, when, at what
price" — with min/max/avg summary chips above the table.

**Mobile UX:** product detail gains the same Sales card (card layout, not a wide table);
orders tab accepts `productId` param (chip pattern from A3).

**Edge cases:** products merged into variants still resolve (search by parent shows children's
sales aggregated with a variant column); deleted/renamed customers render their stored name;
zero-sales state links to "Create order with this product".

---

## PR-C — Stock-count (audit) mode

**Model (migration #1):**

```
StockCountSession { id, tenantId, name?, status: OPEN|REVIEW|COMMITTED|DISCARDED,
                    startedById, startedAt, committedAt?, committedById?, notes?,
                    movementReference?  // "STOCK_COUNT-<id>" once committed }
StockCountLine    { id, sessionId, productId, countedQty Decimal(10,3),
                    boxes?, pieces?,           // entered denomination, for display
                    expectedQty Decimal(10,3), // snapshot at first count of this line
                    unitCostOverride? Decimal(10,4),  // optional, 4dp COST_DP
                    countedById, updatedAt,
                    @@unique([sessionId, productId]) }
```

Single-counter-now/multi-ready-later = `countedById` on every line + optimistic-concurrency
on `updatedAt`; the OPEN-session guard is "warn when another OPEN session exists", not a lock.

**Counting flow (mobile-primary, web parity):** Warehouse tab gains **"Stock count"**.
Start (or resume — one tap from a "Continue count" strip, DraftStrip pattern) → full-screen
scan mode reusing the shared scan ladder + `BarcodeScanner`: each scan increments the line
with a haptic tick + a 1.5s toast showing name and running count (never silent); unit toggle
via the existing boxes/pieces affordances (`scan-line-units.ts` — never fractional cases).
Manual add via the quiet catalogue button (PR-2 pattern). Unknown barcode → sheet: "Not in
catalogue — create product / attach code to existing / skip (noted)".

Every line change **autosaves to the server** (900 ms debounce, the drafts pattern) — pause
is therefore free: leave the screen, resume from any device, it picks up where it stopped.
"Undo last scan" button always visible in scan mode.

**Review screen (the money moment):** table/cards of counted lines: expected → counted →
**variance** (qty and $ at current avg cost), inline qty edit, per-line remove, per-line
"unit cost" edit (pre-filled with current averageCost, 4dp) for the owner's "update the
average cost if they want" — clearly labelled "Sets cost basis, not just count".
Zero-variance lines collapse under a "n lines match" group so attention goes to differences.

**Commit:** extends the existing `commitStockCount` (inventory.service.ts:299-408 — keep its
sessionId idempotency): one ADJUSTMENT StockMovement per changed product referencing the
session; lines with `unitCostOverride` also write the COST_BASIS path (same semantics as
SetCostModal). Uncounted products are NEVER touched — a count session only asserts what it
saw. Confirmation states exactly that: "Adjust 37 products (+$412.18 / −$96.40 at avg cost);
1,706 uncounted products unchanged."

**History & corrections:** "Stock counts" list (status, date, who, #lines, net variance $) →
read-only session detail with per-line variance and links to the movements it wrote.
**Corrections never rewrite history:** an "Amend" action on a committed session opens a new
pre-filled session; committing it writes fresh adjustments referencing both sessions.

**Failure modes handled:** double-scan (undo + editable qty); wrong denomination (boxes/pieces
toggle per line); connectivity drop mid-count (autosave retries + "n unsaved" badge, same as
drafts); duplicate concurrent session (warning with "open it instead"); commit twice
(idempotent sessionId short-circuit, already in the service).

---

## PR-D — Generic → variant assignment (scan-time and later)

Foundation (recon): variants are `parentProductId` + `variantName` (flat, one level,
schema.prisma:900-945); the scan matcher is already variant-aware via composed
"Parent - Variant" names; `create()` inherits parent defaults when `parentProductId` is set.

**One mechanism, two entry points.** Build a single **variant-split flow** and invoke it from
both places, so behaviour is identical and receiving stays untouched:

- **Server:** `POST /inventory/variant-assign` `{parentProductId, assignments: [{productId? |
newVariant: {name}, qty, unitCostOverride?}], reference?}` — atomic: validates
  Σqty ≤ parent's current stock (400 `INSUFFICIENT_UNASSIGNED` otherwise), writes a negative
  ADJUSTMENT on the parent and a positive one per variant (unit cost = parent's avg cost
  unless overridden — the owner's "rare different cost per variant" case), AVCO via the
  existing costing helpers (COST_DP=4), `reference: "VARIANT_ASSIGN-<uuid>"`. `newVariant`
  creates the child inheriting parent fields (price tiers, category, unitsPerBox, regulated
  flags) exactly as `products.create()` already does.
- **Entry 1 — after invoice scan:** on the bill detail, any line resolved to a product that
  HAS variants shows a badge "Generic — split into variants?" After receive, tapping it opens
  the split sheet pre-loaded with that line's received qty as the pool. **Skippable forever**
  — unsplit units simply live on the generic, exactly as the owner described.
- **Entry 2 — from the product/inventory record:** parent products show "Unassigned stock: N"
  with an **"Assign to variants"** action opening the same sheet against current parent stock.

**The split sheet (both surfaces):** header shows the shrinking **"Remaining: N"** pool;
variant rows (search-filterable) each take a qty (boxes/pieces aware); "New variant" inline
row (name only — everything else inherited, editable later); per-row cost field collapsed
under "Different cost?" so the common all-same-cost case is zero extra taps. Partial
assignment is first-class: assign 12 of 20, leave 8 on the generic, done. Over-assignment is
blocked live (row inputs clamp to remaining). Every apply toasts the movement summary and
links to the movements written.

**Edge cases:** variant of a variant is impossible (model is one level — hide the affordance
on children); the parent itself sellable (yes — generic keeps its own stock/price; nothing
forces full assignment); concurrent assignments (server re-validates pool inside the
transaction); costing method STANDARD products skip the cost field (B11 backlog fix keeps
STANDARD costs stable).

---

## PR-E — Payment allocation: running balances for suppliers and customers

**Model (migration #2):** `BillPayment.paymentGroupId String?` (mirrors
`InvoicePayment.paymentGroupId`, which already exists) + new `SupplierCredit` mirroring
`AdvancePayment` `{supplierId, amount, balance, method, reference?, notes?, tenantId, …}`.
NOTE: `VendorBillStatus.PARTIAL` is overloaded (short-received vs part-paid,
schema.prisma:797-798) — allocation eligibility must be computed from
`totalOwed - totalPaid > 0.001`, never from status.

**AP flow:** supplier page (and vendor-bills list) gains **"Record payment"** at the supplier
level: amount + method + date + reference → **allocation preview**: open bills oldest-first
(billDate, then created), each row showing owed → applied → after; rows are **editable before
confirm** (autonomy: oldest-first is the default, not a cage); remainder line shows
"→ $X stays on account" (SupplierCredit). Confirm writes one `BillPayment` per touched bill
in a single transaction, all sharing a `paymentGroupId`, statuses recomputed
(`PAID`/`PARTIAL`). New bills auto-apply available SupplierCredit the same way AdvancePayment
does for invoices, with a visible "Paid $X from account credit" note.

**Supplier statement view:** supplier page gains a running-balance timeline (bills up,
payments/credits down, balance column) with the open-balance headline — the owner's "$5,000
running balance" made visible. Pure read over existing rows.

**AR mirror:** customer page gains the same customer-level "Record payment" — allocation
across open invoices oldest-first via `InvoicePayment` rows sharing a `paymentGroupId`
(exists), remainder → `AdvancePayment` (exists). Always exclude `status: VOID` payments from
open-balance math (the bounced-check rule). The existing per-invoice payment recording stays
untouched — this is an additional, customer-level entry point.

**Bulk mark-paid:** vendor-bills (and expenses) lists gain checkbox multi-select + action bar
→ "Mark paid" with one shared date/method and a preview total ("Mark 14 bills paid —
$12,480.20"). Implemented as full-remaining payments per bill (same ledger, no special
status jump). Expense rows linked 1:1 to a VendorBill (Expense.vendorBillId) mark their bill,
not just themselves — one source of truth.

---

## PR-F — AI supplier-statement reconciliation (last; builds on PR-E)

**Pipeline (reuse the invoice-scan architecture wholesale):** upload (pdf/images, same
RENDERABLE*INLINE_MIMES rules) → durable `SupplierStatementScan` row (migration #3; the
InvoiceScan pattern: fileHash dedup, extractedPayload Json, status SCANNED|APPLIED|DISCARDED)
→ Claude parse (tenant-scoped anthropic key via SystemConfig, same typed error contract:
AI_KEY_INVALID / AI_SCAN_REJECTED / AI_UNAVAILABLE / AI_PARSE_FAILED) to normalized JSON:
`{supplier, periodStart, periodEnd, openingBalance?, closingBalance?, lines: [{date,
kind: INVOICE|PAYMENT|CREDIT|ADJUSTMENT, refNumber?, amount, runningBalance?}]}`. Statements
vary wildly per supplier — that's exactly why parsing is a model call, not a template. Use
the scan model for OCR; run the \_matching* deterministically in code (auditable, testable):
exact `supplierInvoiceNumber` match (it's normalized uppercase/no-whitespace already) →
amount+date-window fuzzy (borrow `duplicate-match.service.ts` layering) → unmatched.

**The one review screen (owner decision):**

- **Matched** (exact ref + amount): pre-checked rows — statement line ↔ local bill,
  side-by-side amounts.
- **Needs a look** (fuzzy): flagged rows with a candidate picker per line.
- **Unmatched statement lines** (we have no bill — offers "create bill from line").
- **Unmatched local bills** (statement doesn't mention them).
- **Implied-paid proposal:** when the statement's opening balance accounts for the recent
  bills and older local bills predate the period still unpaid, a SEPARATE, clearly-worded
  panel lists every older bill with a summed total: "This statement implies these 23 older
  bills (Jan–Jun, $18,240.90) were settled. Mark them paid?" — its own checkbox, its own
  second confirmation, never bundled into the main Apply.
- **Apply:** one transaction: payments per matched line (PR-E mechanics, grouped, reference =
  statement scan id), on-account credit for surplus, bill statuses recomputed. Everything the
  apply did is listed on the scan's detail page afterward — full audit trail, undo by voiding
  the payment group.

**Guardrails:** money amounts from the model are re-validated against the statement total
(Σlines vs closingBalance sanity check — mismatch demotes everything to "needs a look");
duplicate statement upload short-circuits on fileHash; a statement can never _create_
payments above its own stated amounts; the review screen is web-first (mobile reads the
result — a dense reconciliation table earns a desktop).

---

## Cross-cutting

- **Migrations:** three (PR-C, PR-E, PR-F). Each ships via the standing prod flow — fresh
  backup → `railway run --service postgres node apps/api/scripts/prod-migrate.mjs` BEFORE the
  app deploy. Never auto-migrate. (The 2026-08-17 incident rules in
  `project_prod_data_loss_2026-08-17` apply to every step.)
- **Tenancy:** every new model gets `tenantId` + `forTenant()` scoping; new readers that touch
  nested-created children query through the parent (the invoiced-sales lesson).
- **Money discipline:** allocations and variances through `roundMoney`; unit costs 4dp
  (`COST_DP`); never derive from floats; VOID payments excluded everywhere.
- **Testing:** every new pure module gets specs (allocation order, remainder math, variance
  math, split-pool clamping, statement matcher tiers); e2e for the two owner-reported fixes.
- **Interleave:** the remaining deep-dive backlog (B7–B14: regulated-tax drop on price
  adjustment, estimate/recurring/returns races, STANDARD-cost clobber, uploads cross-tenant
  prefixes, driver price, DRAFT-payment trap, ActionTile double-tap, finance-list debounce)
  rides as small PRs between the feature PRs — they are unrelated to these surfaces and
  should not wait for PR-F.

## Open questions for the owner (answers improve the build, none block PR-A)

1. **Mobile send repro:** which exact screen/button, and what did you see (greyed rows, a
   toast, nothing)? A screenshot pins it in seconds.
2. **Count exports:** is pushing counts into inventory (movements + history in-app) enough,
   or do you also want a CSV/PDF export of a committed count for records?
3. **Statement senders:** do statements arrive as PDFs by email/WhatsApp (upload is fine) or
   on paper (camera capture path gets priority)?
4. **AR allocation entry point:** is customer-level payment recording mainly a web/back-office
   task, or do drivers also collect lump-sum payments in the field (mobile parity needed
   sooner)?

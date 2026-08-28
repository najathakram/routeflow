# RouteFlow — Product Documentation

_Current-state documentation of RouteFlow, verified against the codebase on 2026-08-19._
_Written in business language for marketing, sales, onboarding, and support. Every capability
below is shipped and working unless explicitly flagged. Section 15 lists what is **not** ready._

---

## 1. What RouteFlow is

RouteFlow is a multi-tenant SaaS platform for **wholesale distributors and jobbers** — the
businesses that buy in bulk and supply independent retail: convenience stores, bodegas, markets,
restaurants, salons, and other small businesses.

It runs the whole order-to-cash loop in one system: a customer order (taken by the office, a rep
in the field, or the retailer themselves through a self-service portal) becomes a delivery,
becomes an invoice for **what was actually delivered**, becomes a recorded payment — with
inventory, costs, expenses, regulated-product compliance, and the books updated along the way.

**Positioning line (existing site):** _"RouteFlow — Move stock. Move money. Move forward."_
**Category:** the operating system for wholesale distribution.

### Who it replaces

A typical customer today runs on some combination of: paper order pads, phone/text orders, Excel,
QuickBooks or Zoho for invoicing, a filing cabinet of supplier invoices, and a spreadsheet (or a
painful weekend) for excise-tax filings. RouteFlow replaces that stack with one tenant-branded
system plus a free ordering portal for their retail customers.

---

## 2. The platform at a glance

| Surface            | What it is                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web dashboard**  | The operator/back-office app (Next.js). Orders, invoicing, inventory, finance, compliance, analytics, settings.                                             |
| **Buyer portal**   | A separate, seller-branded B2B storefront where retail customers shop, reorder, and see their money. PWA-installable.                                       |
| **Mobile app**     | One Expo/React Native app with role-based experiences: operator, driver, customer/buyer, tenant admin. iOS + Android builds exist; also runs as mobile web. |
| **Platform admin** | Internal console: tenants, plans, billing/MRR, impersonation, buyer directory, audit logs, AI configuration.                                                |

Everything is **tenant-scoped**: each distributor's data is isolated by a per-request tenant
context enforced in the data layer, backed by Postgres row-level security. Suspended tenants are
blocked globally.

---

## 3. Orders & order intake

The order module is built around how distributors actually sell: fast, repetitive, negotiated,
and often standing in front of the customer.

- **Every intake channel lands in one queue.** Office-created orders, rep/driver orders from the
  field, and buyer-portal orders all flow into the same list with the same pricing rules.
- **Scan-to-order.** Barcode scanning adds products to an order — via phone camera, in-browser
  camera, or a hardware wedge scanner. Mobile has a **continuous split-screen scan mode**: camera
  on top, live order tray below; re-scanning an item bumps its quantity; haptic confirmation.
- **Forgiving barcode matching.** A scanned code is matched across UPC-A/UPC-E/EAN-13/GTIN-14
  variants, leading zeros, and check digits — because iPhones and wedge scanners report the same
  label differently. Both the **case code and the unit (piece) code** resolve; a unit-code scan
  adds one loose piece, not a case. Ambiguous scans ask, never guess.
- **Remembered pricing.** Scanning a product pre-fills the last price given to that customer.
  Tier pricing (up to 5 tiers) and per-customer negotiated prices apply automatically.
- **Margin guardrails at the point of sale.** Every line shows live cost and margin, flags a
  price below the configured margin floor, and offers "Set to floor" or an explicit "Sell
  anyway" — with a cost-history popover for the negotiation. (Advisory: the floor warns, it does
  not block.)
- **Boxed/case math that is always right.** Products sold by the box prorate partial-box
  quantities correctly; the pricing engine structurally prevents the classic
  `quantity × unit price` over-charge on boxed lines. Every monetary write is rounded to cents.
  The same engine runs on server, web, and mobile, so totals agree everywhere to the cent.
- **Park and resume.** An in-progress order can be minimized to a draft dock (web) or saved as a
  draft (mobile), autosaved, and resumed later — even on another device. Escape/cancel parks the
  order instead of destroying the work.
- **Merge instead of duplicate.** If a customer already has an open order, RouteFlow asks
  "merge or separate?" — and also sweeps stray pending orders together automatically.
- **Standing orders.** Recurring order templates on a day-of-week schedule auto-generate each
  morning; buyers see and can reorder or pause the same templates.
- **Sell from the van.** One call creates the order **and** its invoice: a cash-and-carry sale is
  done in a single save (order delivered + invoice issued), or a pending order with a draft
  invoice.
- **Editable at every stage, with history.** Items can be edited while confirmed, dispatched,
  out for delivery, and even after delivery. Every edit appends an immutable revision with exact
  money snapshots ("Edited 3×" timeline).
- **Change requests after dispatch.** Once a truck is out, the buyer (or the office, or the
  driver) can request add/change/remove. The operator resolves: apply at the stop, roll into the
  next delivery, or decline with a reason. Concurrency-safe; both sides get notified.
- **Guards on every write.** Stock-availability checks (hard-block for buyers/drivers, warn for
  operators) and a **credit-limit guard** that counts open invoices plus open orders. Regulated
  license checks re-run on every order path (see §6).
- **Backdating for real-world bookkeeping.** Staff can record an order on its true business date
  (up to 2 years back); invoice dates, due dates, and compliance filing periods follow it.
- **Cancel with a preview.** Before cancelling, the operator sees exactly which invoices will be
  voided and which credits/advances will be restored. Money already taken in cash/check/card
  blocks the cancel instead of silently vanishing.
- **Promotions.** Percent, fixed-amount, and quantity-break promotions, scoped to everything, a
  category, or a product list, with a scheduling window. The best applicable promo wins; buyers
  see strikethrough savings. (Promotions apply to customer/buyer pricing, not staff-entered
  prices.)

---

## 4. Invoicing, payments & getting paid

The deepest module in the product. Built for distributors whose invoices change at the door and
whose money arrives as cash, checks, and partial payments.

### Invoice lifecycle

- Create by hand or **generate from an order** — full, or partial ("bill part of this order
  now"). Split one order into multiple invoices.
- Send, email, remind, duplicate, void, un-void, revert to draft, reopen, and **write off** bad
  debt with a reason (the record is kept, not deleted).
- **Draft vs Final PDFs.** Pre-delivery proformas print a diagonal DRAFT watermark; issued
  invoices print a FINAL badge. Tenant logo and branding on every PDF.
- **Retail-ready line barcodes.** Each line prints a scannable Code128 barcode of the **unit
  code** — the code the retailer actually scans at their register.
- **Honest email.** If the tenant's email isn't configured or a send fails, the invoice stays a
  draft and the operator sees a typed error — it is never falsely marked "sent."

### Two-way order ↔ invoice sync (signature capability)

- Order changes rebuild the draft invoice; invoice edits rebuild the order. Nothing drifts.
- **Delivered-quantity billing:** when a driver completes a stop, the invoice is rebuilt from
  what was **actually delivered** — short-picks and refusals never over-bill.
- Post-delivery edits rebuild the existing invoice in place, keeping payments and recomputing
  balance, status, and the compliance ledger.
- A conservative safety rule: if billing provenance is ambiguous (a line billed twice, or on a
  finalized invoice), the sync bails rather than risk a double-bill.

### Payments

- Record payments by cash, check, ACH, card, other — plus store credit and customer advances.
- **Lump-sum payments allocate across invoices** oldest-first; overpayment becomes a customer
  advance (wallet).
- **Full check lifecycle:** recorded → deposited → cleared — or **bounced**, which voids the
  payment, reopens the invoice, and can auto-add a non-taxable NSF fee line.
- **Payment photos.** Attach a photo of the check/cash/receipt to any payment — including at the
  door by the driver. Grouped allocations share one photo.
- **Two dates, done right:** when the instrument was received vs. when the money actually landed
  (bank date, supports post-dated checks). Cash-flow reporting uses the bank date.
- Bounced/voided payments are excluded from every receivable, statement, aging, and dashboard
  figure — systematically.

### Credits, advances & adjustments

- **Credit notes:** issue with optional expiry, apply/un-apply, auto-apply oldest-first the
  moment an invoice is sent, editable reason, cumulative caps against over-crediting.
- Credits can be **selected on the order before invoicing** — an intent that re-settles
  idempotently every time the invoice changes.
- **Advance payments (deposits):** record, apply to invoices, auto-restored if a payment is
  voided.
- **Retroactive price adjustment:** fix a mispriced customer across **every unpaid invoice since
  a date** in one action ("I had the wrong price all month" — solved).

### Recurring & quotes

- **Recurring invoices:** weekly/biweekly/monthly templates with pause/resume, "run now," a
  nightly generator, and optional auto-send (real email; leaves a draft on failure).
- **Estimates/quotes:** create, accept/decline, convert to invoice. _(Maturity note: estimate
  "send" changes status but does not email yet — position quotes as a secondary feature.)_

### Statements

- Customer statements that **reconcile by construction**: opening + charges − payments − credits
  ± adjustments = closing, to the cent. Monthly statement PDFs available to the operator and to
  the buyer in the portal.

---

## 5. Inventory, products & purchasing

- **A catalog built for wholesale:** variants under a parent (family inherits pricing tiers,
  pack size, costing, regulated flags), up to 5 price tiers, per-customer overrides, product
  images with focal-point cropping, merchandising flags (Featured / New / Deal), reorder points.
- **Dual SKU:** every product can carry a **case code and a unit code**. Lookup resolves either;
  invoices print the unit code; a unit scan means one piece, a case scan means one case.
- **Stock tracking:** movement ledger, manual purchases/adjustments, **scan-driven physical
  counts** (scan shelf after shelf, review variance, commit — idempotent, safe against
  double-submits), valuation with a missing-cost filter.
- **Purchase orders:** create, send, receive (partial supported), close. Receiving converts cases
  to pieces via pack size, updates weighted-average cost, and stamps cost snapshots.
- **Costing:** weighted-average costing with per-movement cost snapshots, so any report can
  answer "what did this cost on that date." Cost tools: set basis, bulk-set, and a full
  **cost recompute** that replays history (dry-run first). _(Honesty note: FIFO/LIFO/standard
  labels exist, but valuation and COGS run on weighted average — market "accurate average
  costing," not FIFO/LIFO.)_
- **Forecasting:** per-product 30-day demand from real invoiced sales, days-of-stock remaining,
  needs-reorder flags. **Dead stock** and **margin alert** reports.
- **Restock alerts close the loop with buyers:** a buyer taps "notify me" on an out-of-stock
  item; alerts fire automatically when stock comes back via purchase, adjustment, count, or PO
  receipt. Operators see "N customers waiting" per product.

---

## 6. Regulated products & compliance (the wedge)

RouteFlow treats regulated goods — tobacco, vape, and other licensed or levied categories — as a
first-class, general capability. This is the feature set almost nothing else in the SMB price
class has.

- **Tracked categories:** define each regulated type with its tax type, rate, licence
  requirement, invoice treatment, report template, and filing cadence; organize products into
  categories/subcategories in bulk.
- **Four levy types:** per-unit **excise**, **per-volume**, **container deposit**, and
  **percent-of-sale** — computed at order time, snapshotted per line, prorated onto invoices,
  and folded into totals everywhere. Tax-exempt customers owe $0 of both regular and category
  tax, recorded as $0 in the ledger. Reversals are sign-preserving.
- **Licence enforcement at the moment of sale.** Orders containing a licence-requiring category
  are blocked unless the customer holds a verified, unexpired licence — re-checked on edit, on
  draft promotion, on change-request approval, and again at invoicing (catches a licence that
  expired between order and invoice).
- **"Sold under responsibility" overrides:** a seller can consciously override a block — as an
  append-only, auditable record, scoped to one order or a date, optionally city-scoped.
- **Buyer self-serve licences.** Retailers submit and renew licences in the portal (with
  explicit consent capture); operators approve/reject/renew; a **daily expiry sweep** flags
  lapsed licences and warns both sides at 30/7/1 days.
- **Catalog gating that never leaks.** Unlicensed buyers don't see locked categories at all —
  tiles, deep links, favourites, and even category counts are filtered.
- **Delivery-time gates.** Regulated stops can require age check and ID check before the stop
  can close; safe-drop is forbidden; verification is server-timestamped.
- **An immutable regulated sales ledger** — one row per regulated invoice line, with net-aware
  reversal rows for voids, returns, and credits, bucketed by filing period. Return-then-void
  can't over-report; balances floor at zero.
- **Filing-ready reports.** Prepare a filing for any closed period (monthly/quarterly/annual);
  download CSV or PDF. Templates include **Texas Comptroller** (full 12-column per-invoice
  wholesaler format with permit numbers and retailer taxpayer IDs, filing-ready), CA CDTFA,
  CA ABC, CalRecycle, and a generic format. A daily job auto-prepares the latest closed period.
  Custom column layouts are saved separately so the official layout is never accidentally
  altered. The report engine surfaces warnings (missing licence numbers, invalid taxpayer IDs,
  fractional quantities…) before you file.
- **Tobacco add-on:** a dedicated tobacco-dealer module (KPIs, monthly reports CSV+PDF,
  flagged inventory, supplier/customer licence views), plus a toggle to exclude tobacco from
  headline analytics.

_Maturity notes: per-volume levies approximate using piece counts; "separate section on one
invoice" rendering is not built — regulated lines split into **separate sibling invoices**
(numbered base/-R1/-R2, totals summing exactly to the order), which is the treatment to demo._

---

## 7. Expenses & bookkeeping

- **Expenses:** full CRUD with itemized lines, billable-to-customer attribution, receipts
  (compressed and stored), soft delete, filters, and **21 IRS Schedule-C categories pre-seeded**
  plus tenant-defined ones.
- **Receipt OCR:** photograph a receipt and AI extracts vendor, date, total, and line items into
  the expense.
- **Mileage:** a mileage-rate table with effective dates; a mileage expense auto-applies the
  rate in effect on that date.
- **Vendor bills (accounts payable) with AI scanning — the "wow" demo:**
  - Photograph a supplier invoice (up to 10 pages) → AI extracts supplier, invoice number,
    dates, totals, tax, and line items **including item codes and pack sizes**.
  - Lines auto-match to your catalog ("Parent - Variant" aware, rare-token weighted);
    mid-confidence matches ask a human with "Did you mean…" chips; **the scanner learns from
    every correction** and remembered supplier mappings are authoritative next time.
  - **Duplicate protection:** exact invoice-number matches block with "resume the draft / open
    existing"; fuzzy matches (supplier + date + total) warn without blocking. Re-uploading the
    same photo replays the stored extraction instead of paying for a second scan.
  - **Receiving a bill updates the business:** cases convert to pieces, weighted-average cost
    updates, stock lots and movements are stamped at the bill date, and it's idempotent against
    double-receives. Pack size from OCR is a verify-first prefill, never auto-applied — because
    it drives money math.
  - **Batch mode:** drop a whole stack of invoices; they're scanned, classified (clean / needs
    review / duplicate / failed), reviewed line-by-line, and posted in bulk.
- **Reports (~20, all CSV-exportable):** P&L (with real invoice-sourced COGS at point-in-time
  cost), cash flow (bank-date aware), AR aging (summary/detail/invoice-level), sales by
  customer/item/driver, customer balance summary, invoice details, bad debts, payments received,
  time-to-get-paid, expense details/by category/by customer, estimate details, refund history,
  receivable summary, and a transaction ledger.

---

## 8. The buyer portal (the moat)

A separate, emerald-branded, seller-branded B2B storefront — free for retailers — with its own
login, so a store owner's portal never collides with staff logins.

- **Multi-seller by design.** One buyer account connects to many wholesalers; a seller picker
  switches catalog, pricing, orders, invoices, and credit together. Self-serve "connect a
  seller" requests, seller-issued invites, and account merge (with email verification) are all
  built in. **Every buyer a distributor invites becomes a user who can then find other
  RouteFlow sellers — the network loop.**
- **A real shop, at their prices:** category rail with counts, smart collections (**Your
  usuals**, Favorites, New, Deals), multi-image tiles with promo strikethrough and savings,
  stock-state labels, "Best for you" sort ranked by the buyer's own replenishment cadence,
  search across name/SKU/barcode, notify-me stock alerts, and locked-category handling for
  regulated goods.
- **Your Shelf — replenishment intelligence.** From 180 days of order history RouteFlow infers
  each product's reorder cadence, shows Running low / Due soon / Snoozed with days-left bars and
  suggested quantities (rounded to the buyer's usual pack), and offers **"Add all low to
  cart"** in one tap. The same payload drives the shelf page, the shop strip, and the dashboard
  chips — they can never disagree.
- **Cart & checkout:** promo-aware line pricing that reconciles to the total, requested delivery
  date, order notes, merge-into-open-order choice.
- **Orders:** status timelines, self-service editing during the edit window, **post-dispatch
  change requests** with PENDING/APPROVED/DECLINED chips, one-tap reorder, and delivery tracking
  (driver, stops ahead, ETA window — textual; live map is roadmap).
- **Money, transparent:** invoices with PDF download and live check-status badges (a bounced
  check visibly reopens the balance), payment history, store-credit tile with expiries, monthly
  **statement PDFs**, the seller's "how to pay" remittance card, and spend analytics.
- **Standing orders, favorites, licences, profile** — plus a PWA install prompt ("RouteFlow
  Buyer Portal" with a Shop shortcut).

---

## 9. Customers & relationships (operator side)

- Rich customer records: multiple typed addresses, contact people, tags, internal comments,
  documents and tax documents (inline PDF viewing), credit limits, tax-exempt flag.
- Per-customer special prices and tier assignment; income chart; advance-payment wallet.
- **Statements** (on-screen + monthly PDFs) that reconcile to the cent.
- **Merge duplicate customers** — with regulated licences re-pointed correctly (the stronger
  authorization per category survives). Duplicate suggestions built in.
- Reversible soft-delete with an 8-second Undo. Portal invites, approvals, and disconnects.
- Customers without email get placeholder identities and the system refuses to "send" to them —
  no fake sent-mail.

---

## 10. Returns & refunds

- Full lifecycle: create (operator or customer) → approve/reject → in transit → receive →
  refund, plus cancel — each step guarded and concurrency-safe (a double-click can't
  double-restock).
- Receiving restocks at current average cost with snapshots — or explicitly doesn't ("we're not
  keeping these goods"), and cancellation stays symmetric with whatever actually happened.
- Refunds mint **store credit** (a linked credit note) computed boxed-safely from the original
  line's stored subtotal; compliance ledger reversals are prorated exactly.

---

## 11. Delivery day (supporting story — market carefully)

The delivery loop works end-to-end and closes the order-to-cash cycle; market it as execution,
not as fleet telematics.

- Routes with stops, route templates, run creation, a **packing list / loading manifest** per
  run, dispatch calendar, and a stop map (stops colour-coded by status).
- **Driver flow (mobile):** ordered stop list, call/text/directions per stop, per-line
  full/short/refuse capture, **POD photos and on-screen signature**, skip-with-reason, regulated
  age/ID gates, returns pickup, add-on sales at the door, and **at-door payment collection**
  (cash/check/card/on-account) with a required amount for physical money and a **payment photo**
  — allocated to the right invoices server-side.
- **Run settlement:** cash tally per run with variance notes; completing a route with collected
  cash is gated on the tally.
- Route optimization via OpenRouteService (with fallback) plus an AI route-analysis assist.
- Delivered quantities drive the invoice (see §4) — the single most distributor-shaped behavior
  in the product.

**Do not market:** live vehicle/GPS tracking on the web dashboard (driver pins exist on the
mobile fleet screen only; no web subscriber), vehicle/fleet management (no vehicle entity), or a
buyer-facing live map (placeholder).

---

## 12. Analytics & reporting

- Four-tab analytics: **Revenue** (revenue, AOV, DSO, gross margin trend, sales by category),
  **Products & Inventory** (top products, turnover, dead stock, margin alerts),
  **Customers**, **Operations** (route/driver performance).
- Per-product demand series (30d/6m/1y/5y, zero-filled), price history, cost history.
- COGS and margins are estimated from real invoiced sales at point-in-time average cost — an
  honest, defensible number.

---

## 13. Mobile apps

One app, four roles (operator / driver / customer / tenant admin), ~190 screens; iOS + Android
builds plus a mobile-web build. Highlights beyond what's covered above:

- Operator can run essentially the whole business from a phone: orders (with the split-screen
  continuous scanner), invoices (create/edit/send/void/payments/PDF share via WhatsApp/SMS/
  email deep links), vendor-bill scanning, POs, expenses, customers (with camera document
  upload), products (with camera photos, HEIC auto-converted), stock counts, regulated filings
  with CSV share, returns, and five finance reports.
- **Offline resilience:** failed writes queue on-device and replay when connectivity returns
  (idempotency keys prevent double-apply); a persistent offline banner; parked drafts; secure
  keychain token storage; automatic token refresh.
- Push notifications (Expo/Firebase), realtime socket updates, `routeflow://` deep links with
  anti-session-fixation protection on Google sign-in.
- _Maturity: estimates are view/act-only on mobile; reports are tables (no charts); the app
  stores listing status should be verified before "download on the App Store" claims — the
  current site says "coming soon."_

---

## 14. Platform, security & onboarding

**Security posture (a real selling point for owner-operators who fear cloud software):**

- Tenant isolation enforced in the data layer on every query + Postgres row-level security as
  defense in depth. Buyer and staff identities live in separate realms with tokens that can't
  cross. Account lockout (10 fails → 15-min lock), enumeration-safe auth, Redis-backed rate
  limiting, AES-256-GCM encryption at rest for stored credentials, HMAC-signed file URLs with a
  strict inline-render allowlist, global input validation, audited platform-admin impersonation.
- **Nightly production database backups** to offsite object storage with restore verification
  and a documented restore runbook.
- Google sign-in for staff and buyers; per-tenant SMTP ("send invoices from your own mailbox")
  with real connection tests, or verified sending domains; bilingual UI (English/Spanish).

**Onboarding & migration (the "switching is easy" story):**

- CSV importers for contacts, invoices, payments, expenses, products, inventory — with batches,
  rollback, Zoho column recognition, orphan diagnosis, and idempotent re-runs.
- **Document numbering continuity:** seed your invoice sequence from your last real number
  (e.g. "INV-08841") so history doesn't reset. _(Wired for imports; live minting integration
  pending.)_
- **Batch invoice scanning as migration:** photograph the filing cabinet — the stack is scanned,
  classified, reviewed, and posted, building your catalog, costs, and stock as it goes.
- Migration staging with duplicate flags and a **24-hour undo**.

**Packaging (as built in the platform):** four plans (Starter / Team / Business / Enterprise)
with server-enforced feature flags, plus add-ons: **buyer portal, regulated items, OCR scan
pack, forecasting, extra seats/routes, message bundle**. Metered usage never blocks mid-action.
Trials, proration, scheduled downgrades, and an append-only MRR ledger are built. _(The public
pricing page currently shows Starter/Growth/Scale — align naming before launch; see strategy
doc §7.)_

---

## 15. NOT ready — do not market (verified 2026-08-19)

| Claim to avoid                                             | Reality in code                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Live vehicle/GPS tracking (web), "fleet management"        | No web subscriber to driver locations; no vehicle entity. Mobile fleet map shows driver pins only. |
| Buyer live delivery map                                    | Literal "Live map coming soon" placeholder; textual ETA tracking is real.                          |
| Voice ordering (EN/ES)                                     | Claimed on the current site; not found in the product. Remove until verified.                      |
| WhatsApp / SMS notifications                               | Full engine exists but the only provider is a logging stub. Email + push are real.                 |
| QuickBooks / Xero / Stripe / Shopify / Twilio integrations | "Coming soon" stubs; migration connectors are CSV-only.                                            |
| FIFO / LIFO costing                                        | Labels only — everything values and costs at weighted average.                                     |
| ACH payment links on invoices                              | Remittance ("how to pay") instructions are real; no pay-link rail.                                 |
| Warehouse pick & load scan verification                    | "Coming soon" stub screen.                                                                         |
| Driver end-of-day cash-up screen                           | Stub (run-settlement tally **is** real — market that instead).                                     |
| Dispatcher ↔ driver chat as a feature                      | Run-scoped chat exists in the API; the general messaging inbox is stubbed.                         |
| Dark mode                                                  | No user-facing toggle.                                                                             |
| Regulated "section on one invoice"                         | Only separate-sibling-invoice treatment renders; section headings unbuilt.                         |
| The site's stat band (3 min / 28% / $0 / 12 hrs)           | Marked in source as design targets, not measurements. Label as targets or replace with real data.  |
| Mobile apps "on the App Store / Google Play"               | Site says coming soon; verify store listing status before claiming availability.                   |

---

## 16. Feature → benefit quick reference (for copywriters)

| Feature (proof)                                          | Benefit (say this)                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| AI vendor-bill scan → stock + costs update               | "Photograph the supplier invoice. Your stock and costs update themselves."     |
| Delivered-quantity billing                               | "The invoice matches what came off the truck. Every time."                     |
| Check lifecycle + NSF handling                           | "A bounced check reopens the invoice by itself — nothing slips."               |
| Boxed proration + one pricing engine everywhere          | "Case-and-piece math that's right to the cent, on every screen."               |
| Licence enforcement + filing-ready reports               | "Sell regulated products without the fear. File in minutes, not weekends."     |
| Buyer portal + Your Shelf                                | "Your customers reorder themselves — before they run out."                     |
| Scan-to-order + remembered last price                    | "Build an order in the aisle in under a minute, at the right price."           |
| Statements that reconcile by construction                | "Month-end statements that always balance."                                    |
| Retroactive price adjustment                             | "Fix a month of mispricing in one click."                                      |
| Park & resume drafts                                     | "The phone rings, you minimize the order, you pick it up later. Nothing lost." |
| CSV import + batch scan migration + numbering continuity | "Switch without losing your history — or your invoice numbers."                |
| Bilingual EN/ES                                          | "Your whole crew can use it — in English or Spanish."                          |

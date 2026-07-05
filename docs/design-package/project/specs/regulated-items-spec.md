# Regulated Items — Implementation Spec

> Handoff spec for wiring the **separately-handled categories** (regulated items) system into the
> RouteFlow app. Tobacco is one *instance* of a tracked category, never a special case in code.
> Designs: `unified/compliance.html`, `unified/tracked-categories.html`, `unified/order-builder.html`
> (split summary), `unified/invoice-detail.html` (paired invoice), `unified/product-detail.html`
> (category picker), `unified/products.html` (scope filter).

---

## 1. Goals

1. Any wholesaler can define **N categories** of items that must be handled separately for sales,
   tax and reporting purposes (tobacco, alcohol, CRV deposits, city sugar taxes, …).
2. **Preferred invoicing = separate invoice per regulated category.** Mixed orders (regulated +
   standard in one cart) are normal and must "just work" — the split happens at invoice
   generation, never in the ordering flow.
3. **Simple for both sides.** The wholesaler builds one order; the retail customer places one
   order and sees one delivery. All splitting, tax math and ledger routing is backend-automatic.
4. **All regulated sales are computed and stored separately** — their own subtotals, tax amounts,
   ledger entries and report aggregates, per category, per period.
5. The wholesaler controls **visibility scope** everywhere: all products / standard only /
   regulated only / any subset of categories.

---

## 2. Data model

### `tracked_categories` (tenant-scoped)
| field | type | notes |
|---|---|---|
| `id`, `tenant_id` | uuid | |
| `name` | text | e.g. "Tobacco", "CRV Beverage Deposits" |
| `tax_type` | enum | `EXCISE_PER_UNIT` \| `PERCENT_OF_SALE` \| `PER_VOLUME` \| `DEPOSIT_PER_CONTAINER` \| `NONE` |
| `rate` | numeric | interpreted by `tax_type` (e.g. 2.87/pack, 0.01/oz, 5% of sale) |
| `unit_basis` | text | pack, oz, container… what `rate` multiplies |
| `price_includes_tax` | bool | excise shown as "incl." vs added as a line |
| `invoice_treatment` | enum | `SEPARATE_INVOICE` (default) \| `SEPARATE_SECTION` \| `LINE_TAX` |
| `applies_scope` | jsonb | optional geo/customer scoping, e.g. `{cities:["Oakland","Berkeley"]}` |
| `requires_license` | bool | customer must hold a license for this category |
| `report_template` | text | e.g. `CA_CDTFA`, `CA_ABC`, `CALRECYCLE`, `GENERIC` |
| `report_cadence` | enum | `MONTHLY` \| `QUARTERLY` \| `ANNUAL` |
| `active` | bool | deactivation keeps historic data intact |

### Product flag
- `products.tracked_category_id` — nullable FK. **One category max per product** (constraint).
- Settable **at creation and on any existing product**: the full product form and the
  quick-create modal (sale builder "New product" / inline-create picker) both expose the
  **"Separately handled"** select; the Tracked Categories manager supports bulk product
  assignment. Changing it affects new sales only (lines snapshot their category).
- Snapshot on sale: `order_items.tracked_category_id` + `order_items.category_tax_amount` are
  copied at sale time so later category edits never rewrite history.

### Customer authorizations (per category, per seller relationship)
- `customer_authorizations`: `customer_id`, `tracked_category_id`, `status`
  (`NONE` | `PENDING_REVIEW` | `VERIFIED` | `EXPIRED` | `REJECTED`), `source`
  (`RETAILER_SUBMITTED` | `WHOLESALER_ADDED`), `license_number`, `expires_at`, `document_key`,
  `verified_by`, `verified_at`.
- `authorization_overrides`: `customer_id`, `tracked_category_id`, `scope`
  (`ORDER:<id>` | `UNTIL:<date>`), `reason`, `accepted_by`, `accepted_at` — the seller-side
  responsibility record (§8).
- **Two paths to VERIFIED, one source of truth:**
  1. **Retailer-submitted** — buyer adds the license in *Account → Licenses & Authorizations*
     (number, expiry, document, share-consent). Every connected seller gets a notification +
     a **Pending** row on the customer detail; one-tap **Approve/Reject** (verification is per
     seller relationship — each seller carries their own compliance responsibility).
  2. **Wholesaler-added** — operator adds the license on the customer record (or via the
     license-capture modal mid-sale); it's VERIFIED for that seller immediately, and the buyer
     sees it appear in their own Licenses page (no double entry, ever).
- Guard: adding an item whose category `requires_license` to a sale for a customer without a
  VERIFIED authorization → **one modal, three exits**: capture license now / responsibility
  override (§8) / remove item. Never a dead end.

---

## 3. Ordering flow (unchanged UX)

- One builder, one cart, one order. Regulated lines are visually tagged
  (`Tobacco · regulated` chip + amber inset) but behave like any line: scan-to-add, qty increments,
  price memory (price memory applies to the *net* price; computed category tax is never overridden
  by a price override).
- The builder summary previews the split live: **"Invoice 1 — standard (n)"** and
  **"Invoice 2 — {Category} (m)"** blocks with per-block subtotal + tax, then **Order total**.
- Order record: single `orders` row; `orders.has_regulated = bool`, per-line categories snapshotted.

## 4. Invoice generation (the split)

On invoicing an order (manual, on-delivery, or from the sale builder):

1. Group order lines by `tracked_category_id` (null = standard group).
2. For each group whose category has `invoice_treatment = SEPARATE_INVOICE` → emit its own invoice.
   - Numbering: base + suffix — `INV-1919` (standard), `INV-1919-R1`, `-R2`… (one per category).
   - All invoices share `invoice_group_id` and the order reference; UI shows a **"Paired"** chip
     linking siblings (see `invoice-detail.html`).
   - Due dates/terms inherit from the customer; each invoice is independently payable, sendable,
     voidable, and creditable.
3. `SEPARATE_SECTION` categories stay on the main invoice as a **sectioned block** with its own
   subtotal + category tax line. `LINE_TAX` adds a per-line tax (e.g. CRV deposit per item).
4. Money invariants hold **per invoice**: `total = subtotal + tax` (±$0.01), `$X.XX`, ≤2 decimals,
   tabular figures.
5. Buyer portal: sibling invoices are listed individually but visually **grouped by delivery**
   ("2 invoices · same delivery"); the paired chip navigates between them.
6. Payments: recorded per invoice (AR). A payment cannot span siblings; the receipt's
   "Applied to" always names exactly one invoice.
7. Returns/credit notes: a return line carries its snapshotted category → the credit note is
   raised against the correct sibling invoice and **reverses the category tax + ledger entries**.

## 5. Separate calculation & ledger

- Every regulated line writes a `regulated_sales_ledger` entry:
  `(tenant, category, order_item, qty, unit_basis_qty, net_sales, category_tax, period_bucket)`.
- Filings (Regulated Items hub) aggregate the ledger per category + period; **Prepare** builds the
  category's `report_template` export (CSV/PDF). Filed reports store a confirmation reference.
- Analytics, P&L and exports get a **category dimension**; standard revenue and each category's
  revenue are always separable. Dashboard/analytics KPIs may include or exclude categories per
  the visibility scope (below).

## 6. Visibility scope (wholesaler control)

A persistent, per-user **scope selector** available on: products list, analytics, finance reports,
exports, and the dashboard revenue cards.

- Options: **All products** (default) · **Standard only** · **All regulated** · **Custom** —
  multi-select of specific categories (e.g. only Tobacco + Alcohol).
- Surfaced as a **"Regulation" scope select** in the products-list filter bar (next to the
  merchandising-category select), and as an **"Item type" filter** in the buyer-portal shop —
  the retailer can view all items, standard only, or one regulated category at a time.
- Persisted (`localStorage` + user prefs) and URL-backed on list pages (shareable).
- Scope affects *display and exports only* — never the underlying ledger or filings.

## 7. Edge cases

- **Category deactivated**: products revert to standard for *new* sales; history untouched.
- **Rate change**: effective-dated; new sales use the rate at sale time (snapshot).
- **Geo-scoped categories** (`applies_scope`): tax applies only when the delivery address matches;
  the builder shows/hides the category tax per the selected customer's address.
- **Overpayment / partial payment**: per invoice, unchanged from standard AR behavior.
- **Voiding one sibling** does not void the others; the order keeps links to all.
- **PDF/print**: standard invoice template + a category header block (license #s, category name)
  on regulated invoices.

## 8. Authorization, visibility & responsibility override

**Buyer-portal visibility rule.** Regulated products are **hidden** from a buyer's catalog,
search, favorites and suggestions unless that buyer's authorization for the category is VERIFIED
with the active seller. In their place the shop shows a single dashed **"{Category} products
hidden — unlocks after your license is verified"** tile linking to *Account → Licenses* (so
authorized-in-reality retailers can self-serve, and everyone else never sees noise). PENDING shows
the same tile with "awaiting {seller} review". Buyers with no regulated business see nothing.

**Operator-side visibility.** Operators always see all products; the guard fires at add-to-sale
time only (capture / override / remove). Order editing, returns and credit notes on already-sold
regulated lines are never blocked retroactively.

**Responsibility override (seller-side only).** When the wholesaler sells without a verified
license on file they explicitly **accept responsibility**: reason (select), scope (this order
only / until date), and an acknowledgment checkbox naming the tenant. Effects:
- audit-log entry (who, when, customer, category, reason, scope) — immutable;
- invoice footnote: *"sold under seller responsibility — {date}"*;
- follow-up task + reminder to capture the real license;
- override never unlocks the buyer portal — self-serve still requires a verified license.

**Expiry lifecycle.**
- Notifications to **both** parties at 30/7/1 days (bell + email); renewal is one field + doc
  update on either side and re-verifies with one tap.
- On expiry: status → EXPIRED; portal hides the category again (tile returns); operator guard
  fires again; **standing orders** skip regulated lines and notify both sides ("2 tobacco lines
  skipped — license expired"); scheduled deliveries already invoiced are unaffected.

**Multi-seller.** The license lives once on the buyer account and is shared (with consent) to
every connected seller; each seller verifies independently. A renewal propagates to all sellers
as a new PENDING review — one update, N approvals, zero re-typing.

**Delivery.** Regulated deliveries force **signature POD** (no leave-at-door); the driver app
labels the stop "regulated — signature required". Age/ID checks, when a category demands them,
are a per-category flag surfaced on the stop card.

**Anti-block principles.** Guards appear only at the moment of relevance; every guard has a
legal path forward; nothing is hidden from the wholesaler; the buyer never sees products they
cannot buy.

## 9. API sketch

- `GET/POST/PATCH /tracked-categories` (+ `/:id/products` bulk assign)
- `GET/POST/PATCH /customers/:id/authorizations` · `POST /:id/authorizations/:aid/approve|reject`
- `POST /customers/:id/authorization-overrides` (reason, scope, acknowledgment)
- Buyer: `GET/POST /buyer/authorizations` (account-level, propagates to sellers)
- `POST /orders/:id/invoices` → returns `invoice_group` array (split applied server-side)
- `GET /regulated/ledger?category=&from=&to=` · `POST /regulated/filings/:category/prepare`
- `GET /products?scope=standard|regulated|cat:<id>,<id>` (same param on analytics/report endpoints)

## 10. Acceptance checklist

- [ ] Category CRUD with all fields above; tobacco exists only as seed data.
- [ ] "Separately handled" picker present on product **create** (full form + quick-create modal)
      and **edit**; bulk assignment from the category manager.
- [ ] Products list "Regulation" scope select + buyer shop "Item type" filter work and persist.
- [ ] Mixed order → N+1 invoices with correct grouped math, pairing chips both directions.
- [ ] Regulated ledger rows written on sale, reversed on credit; filings match ledger sums.
- [ ] License guard blocks unlicensed regulated sales on web + buyer portal + mobile — with all
      three exits (capture / override / remove); override writes audit log + invoice footnote +
      follow-up task.
- [ ] Buyer portal hides unverified categories and shows the unlock tile; retailer-submitted
      licenses reach every connected seller for one-tap approval; expiry re-locks and notifies
      both sides at 30/7/1 days; standing orders skip expired regulated lines with notice.
- [ ] Scope selector filters products/analytics/reports/exports and survives refresh via URL.
- [ ] All money renders `$X.XX`; per-invoice `total = subtotal + tax ± $0.01`.

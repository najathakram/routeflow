# Buyer Experience (Amazon-grade) — Implementation Spec

> The buyer portal upgrades: catalogue, replenishment, open-order editing, change requests, and
> money management. Designs: `buyer-shop.html` (v2 catalogue), `buyer-shelf.html`,
> `buyer-order-edit.html`, `buyer-payments.html`; tenant side: change-request approval on
> `live-dispatch.html`, credits/checks already in Finance. Mobile: `mobile-new-features.md` §G.

## 1. Catalogue (shop v2)
- **Category rail** (counts per merch category + smart collections: Your usuals · Favorites ·
  New · Deals; regulated categories show locked until authorized).
- **Rich tiles**: multi-image (focal 4:5, dot pager), pack info, negotiated price + struck list,
  live stock state (`In stock / Only N left / Out — back ~date`), behavioral chips
  ("You order weekly", "Bought 31×"), deal/new flags, inline qty stepper.
- **Out-of-stock → Notify me**: `stock_alerts` (customer, product) → push/WA when restocked.
- **Seller promos**: `promotions` (banner, rule e.g. "8% off cases of 8+", window) — priced at
  cart time, shown on tile + checkout savings line. Tenant manages promos from Products (flag
  fields: featured/new/deal + promo rules).
- Search across name/SKU/barcode with suggestion dropdown; sort incl. "Best for you"
  (frequency-weighted).

## 2. Replenishment — "Your Shelf" (`buyer-shelf.html`)
- Per product: cadence (qty/interval from order history), last ordered, **est. days left**
  (cadence ± seasonality), suggested qty (rounded to their usual). States: low (<cutoff), OK,
  snoozed (one cycle).
- Actions: Add / Add-all-low / Snooze / convert selection to standing order.
- **Delivery calendar**: seller route days for this customer + per-day order cutoffs + the open
  order riding the next window. Data: routes config + `orders.open`.
- Same engine powers the shop "Running low" strip and dashboard chips — one service
  (`replenishment.estimates(customer)`), three surfaces.

## 3. Open-order lifecycle (add/change until delivered)
- **States**: `PLACED/CONFIRMED` → **freely editable** by the buyer (add/remove/qty; autosaves,
  versioned `order.revisions`; seller sees live). Edit window closes at **loading start**
  (cutoff shown with countdown). Invoice is always issued from delivered lines.
- **After dispatch** → edits become **change requests**: (item, qty±, note) → driver sees it on
  the stop (approve/decline, "on the truck ✓" hint from manifest); office can also act from
  Orders/Messages. Approved-at-door merges into the delivery + invoice; not-on-truck items roll
  to next delivery draft. Declines notify with reason.
- Everything lands on the order timeline + thread context chips. Guards (credit limit, regulated
  license, stock) apply to edits exactly as to new orders.

## 4. Payments & credits (`buyer-payments.html`)
- **Checks in flight**: every recorded check gets a status chain `Recorded → Deposited → Cleared`
  (seller updates deposit/clear from Payments; NSF flips to `Bounced` + fee + guidance). Buyer
  sees the chain live — no "did you get my check?" calls.
- **Credits wallet**: available balance (sum of open credit notes) + per-credit status
  (applies-next-invoice / applied / expired-never). Auto-apply order: oldest first at invoice
  issue. Disputes (from Messages/order lines) become credits on approval.
- **Statements**: monthly PDF (opening/closing balance, invoices, payments, credits) —
  `GET /buyer/statements/:month`.
- **How-to-pay card** = tenant-configured remittance info (Settings → Invoicing).

## 5. Tenant-side facilitation
- Change-request queue: badge on Orders + stop-level approve on Live Dispatch/driver app.
- Check lifecycle actions on payment records (mark deposited / cleared / bounced-NSF).
- Promo/merchandising fields on products; "Notify me" waitlist counts visible on product detail.
- Replenishment estimates reuse the operator forecasting engine (per-customer slice).

## Acceptance
- [ ] Tile stock states + notify-me waitlist fire on restock; promos price correctly at cart.
- [ ] Shelf estimates match cadence math; snooze suppresses one cycle; add-all builds one cart.
- [ ] Buyer edits before loading need no approval and version the order; after loading they
      create change requests resolvable by driver at the stop; invoice = delivered lines.
- [ ] Check chains update from seller actions incl. NSF fee path; credits auto-apply oldest-first.
- [ ] All new buyer actions respect existing guards (credit limit, regulated, cutoffs) inline.

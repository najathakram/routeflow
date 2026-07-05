# Mobile UI Spec — New Features

> Mobile counterparts for the features added to the unified web design. Follow the existing
> RouteFlow mobile design system (see `RouteFlow Mobile v2.html` / `m3-*.jsx`): same tokens as the
> web "Ledger" system, 44px minimum hit targets, bottom-sheet pattern for actions, bottom-tab
> navigation per role. Accent per surface: operator teal, buyer emerald, driver teal.

---

## A. Operator mobile

### A1. Regulated Items hub (`More → Regulated Items`)
- **Category switcher**: horizontal chip row under the header (Tobacco · Alcohol · CRV · **+**).
  Selected chip = ink-900 fill. Swipe or tap to switch; chips show SKU counts.
- **KPI cards**: 2×2 grid (Category sales · Units · Tax collected · Filing status). Same stat-card
  style as mobile dashboard, money in mono.
- **Filings list**: rows = period, sales, tax, status pill; open row → filing detail sheet with
  **Prepare/Export** actions. Overdue filing = danger pill + row inset.
- **Tabs** (segmented, sticky under KPIs): Filings · Inventory · Purchases · Sales.

### A2. Tracked Categories manager (`Regulated Items → Manage`)
- List rows: name, product count, tax rule summary, active toggle (44px).
- **New/Edit category = full-height bottom sheet**: name → tax type (select) → rate (numeric pad,
  unit suffix) → invoice treatment (radio: Separate invoice / Section / Line tax) → cadence →
  applies-scope → product assignment (search + scan-to-add). Sticky **Create** button.
- Deactivate = confirm dialog noting history is preserved.

### A3. Product form — category picker
- New field under Compliance: **"Separately handled"** select (None / category list /
  "Manage categories…"). Helper text mirrors web copy.
- Present on **create and edit**; the **quick-create bottom sheet** (sale builder "New product",
  inline-create from pickers) includes the same field, so an item can be born regulated.
- **License capture sheet**: selling a `requires_license` category to an unlicensed customer
  opens a sheet (license #, expiry, camera photo) with three exits: "Save license & add item",
  "Override…", "Remove item".
- **Responsibility-override sheet**: reason select, scope (this order / until date), and the
  named acknowledgment checkbox; confirm button in warning color. Writes audit log + creates a
  follow-up task; a snackbar confirms "Override recorded — reminder set".
- **Approve/Reject authorizations**: retailer-submitted licenses surface as a notification and a
  Pending row on mobile customer detail — one-tap Approve/Reject with doc preview sheet.

### A4. Sale builder — regulated handling
- Regulated line: amber left inset + `Tobacco · regulated` chip under the product name.
- Scanning a regulated item for an **unlicensed customer** → blocking toast ("License required")
  with **Capture license** action → small sheet (license #, expiry, photo).
- **Summary sheet** (before Create Order): grouped blocks — "Invoice 1 — standard (4)" /
  "Invoice 2 — Tobacco (1)", each subtotal + tax, then Order total, then the shield note
  *"One order, two invoices"*. No extra steps for the user.

### A5. Invoice detail — pairing
- Paired chip row under the status pill: `INV-1919-R (tobacco)` → horizontal swipe or tap to jump
  between siblings. Record Payment stays per-invoice.

### A6. Products list — scope filter
- Filter sheet gains a **Scope** group: All / Standard only / All regulated / pick categories
  (checkboxes) — mirrors the web "Regulation" scope select. Applied scope shows as a dismissible
  chip above the list and persists per user.

---

## B. Buyer mobile (portal PWA)

### B1. Your Sellers directory
- Card list: logo, seller name, "as {businessName}", status pill (Active / Pending / Suspended);
  active seller outlined in emerald. Tap = switch + go to that seller's dashboard.
- **Connect Seller**: primary button → bottom sheet (company code + email + explainer). Success
  state: "Request sent — the seller will review."
- Invite-link hint card at the bottom; empty state = dashed card + Connect CTA.

### B2. Regulated items in the buyer flow
- **Visibility is authorization-gated**: regulated products are hidden unless the buyer's
  category authorization is VERIFIED with the active seller; the catalog shows one dashed
  "{Category} hidden — unlocks after your license is verified" tile linking to Account.
- **Licenses & Authorizations screen** (Account): per-category cards (Verified-per-seller /
  Pending review / Expiring soon with Renew) + add-authorization sheet (category, license #,
  expiry, camera doc capture, share-consent). Renewal propagates to all connected sellers.
- Expiry pushes at 30/7/1 days to both sides; expired → category re-locks, standing orders skip
  regulated lines with a notice.
- **Shop filter**: an **"Item type"** select in the shop's filter sheet — All items / Standard
  only / one regulated category — mirroring the web shop filter.
- Catalog/product page: regulated products show a small neutral chip (e.g. `Tobacco`) and, if the
  buyer lacks a license, an inline "Not available for your account — contact seller" state
  (item not addable).
- **Cart**: regulated lines grouped under a labeled divider ("Tobacco — invoiced separately");
  checkout summary shows the same two-block split as the operator builder. One Place Order button.
- **Orders/Invoices**: sibling invoices grouped by delivery with a "2 invoices · same delivery"
  caption; each opens its own detail with PDF download.

### B3. Order tracking (mobile)
- Vertical status timeline (Placed → Confirmed → Out for delivery → Delivered) with timestamps;
  live section = driver avatar, "3 stops away", ETA, map placeholder; sticky **Reorder** at bottom.

### B4. Standing orders
- Template cards: name, day chips, item count, per-order total, **Reorder** (primary) +
  **Add to cart**; "next delivery" label. Request-a-template card at the end.

### B5. Finances
- KPI stack (30d / 12mo / outstanding / avg invoice), 12-mo spend bar chart (scrollable),
  invoice-status breakdown bar, recent payments list — same data as web, single column.

---

## C. Shared mobile rules

- All money `$X.XX`, mono, tabular; per-invoice `total = subtotal + tax ± $0.01`.
- Category tax lines/labels always name the category ("Tobacco excise", "CRV deposit").
- Toasts bottom-anchored above the tab bar; notification bell in the header on all three shells.
- Every new list keeps: skeleton rows, illustrated empty state, pull-to-refresh, URL/state-backed
  filters where applicable.
- Barcode scanning available wherever the web offers it (sale builder, product search, category
  product assignment) via the camera overlay.
- **Driver app**: regulated stops are labeled "regulated — signature required"; leave-at-door is
  disabled and the POD flow forces a signature (plus ID-check prompt when the category demands it).

---

## D. Guardrails on mobile (see `guardrails-spec.md`)

- **Offline-first**: driver run view + operator scanning queue actions locally; persistent
  offline bar with queued count; sync-review sheet for conflicts.
- **Failed delivery sheet** (driver): reason chips + required camera photo → retry / move to
  next route day / return &amp; restock.
- **Run settlement sheet** (driver, end of run): expected vs counted cash + checks, variance
  highlighted; one-tap close when reconciled.
- **Credit-limit guard** (operator sale sheet): warning card with Collect-payment-first /
  Proceed-over-limit (logged) / Cancel.
- **Short-pick check** (loading): per-line picked vs ordered stepper; deliver-short auto-adjusts
  invoice; substitute opens the product picker.
- **Buyer cart**: cutoff countdown banner + MOV progress bar + quick-add usuals; below-minimum
  submits as a request.
- **Reorder price review sheet**: old→new diffs before placing; standing orders pause for
  approval past the delta threshold (push notification).
- **Report an issue** (buyer order line): type chips + photo → seller Returns queue; credit
  status shown inline on the order.
- **Duplicate hint** on create forms: "possible duplicate" card with Open existing / Create anyway.

---

## E. POS, cost & roles on mobile (see `pos-cost-roles-spec.md`)

- **Live cost/margin** under every price field in the mobile sale builder; below-floor turns the
  field red with "Set to floor" one-tap chip; tapping cost opens lot/bill history sheet.
- **Minimize**: builder header gets a minimize control → collapsed draft bar docks above the tab
  bar; tap to resume with state intact; scanning while docked prompts "Add to draft?".
- **At-the-door sheet** (driver/admin on an arrived stop): qty steppers, swipe-delete,
  scan-to-add, live total, then **Save & capture POD** — one screen, ≤2 taps. Secondary actions:
  New order at door · Collect payment (prefilled).
- **Drive mode**: one-tap toggle in the avatar menu — field-first layout (today's run, big
  targets, scanner FAB) with the full app reachable behind it; drafts and login persist across
  toggles. Driver-role users get the full work surface minus admin-only areas.
- **Owner-operator home**: when the signed-in user is admin + driver, the mobile dashboard
  stacks "Your run today" above office KPIs.

---

## F. Messaging on mobile (see `messaging-spec.md`)

- **Operator Messages tab**: thread list (channel chips WA/SMS/portal, unread badges) → thread
  view with context chips (order updated, credit note) and quick-reply chips (Add to order… ·
  Invoice PDF · Payment reminder · ETA). Acting from chat opens the relevant sheet prefilled.
- **Buyer Messages**: single thread with the active seller; camera attach for issue photos;
  replies mirror to WhatsApp when the buyer is outside the portal.
- **Notifications matrix** is web/settings-managed; mobile shows a read-only summary + per-device
  push toggles. Quiet hours respected for auto-sends.
- **Meter**: WA/SMS send count visible in the send sheet; cap → inline pack prompt (same pattern
  as AI scans).

---

## G. Amazon-grade buyer commerce (see `buyer-experience-spec.md`)

- **Catalogue v2**: category rail becomes a horizontally-scrolling chip row; rich tiles with
  image pager (swipe), stock states, behavioral chips, deal/new flags, inline stepper;
  out-of-stock → Notify-me push.
- **Your Shelf**: running-low list with days-left bars, Add-all-low, snooze swipe action,
  delivery-calendar card (route days + cutoff countdown); low-stock push at ~2 days left.
- **Open-order editing**: pre-loading orders open in edit mode (steppers, search-to-add,
  autosave); post-dispatch edits become change requests — status chip on the order card;
  driver approves from the stop sheet ("on the truck ✓" hint).
- **Payments & credits**: check status chains (Recorded→Deposited→Cleared / Bounced),
  credit wallet with auto-apply, monthly statement PDFs, dispute-a-line → Messages.
- **Driver app**: change-request card on the stop (approve/decline, qty & price shown);
  approved lines merge into POD + invoice flow automatically.

---

## H. Migration, batch import, onboarding & UX standards (see `migration-import-spec.md`)

- **Onboarding**: first-run checklist as swipeable cards (workspace → products → customers →
  first order → first route); "Start migration" card; progress syncs with web.
- **Batch invoice import**: camera multi-capture (shoot a stack of paper invoices in one
  session) or file picker; queue processes server-side; push when done ("48 processed, 4 need
  review"); review sheet = scan preview + flagged lines only; variant resolution uses the same
  three-choice sheet (new variant / new product / match existing) with SKU auto-suggest.
- **Numbering continuity + dedupe** are backend behaviors; mobile surfaces the same skip
  notices and duplicate links.
- **Undo standard**: 8 s Undo snackbar on all reversible actions; confirm sheets only for
  irreversible ones.
- **Session expiry**: PIN/biometric unlock sheet, drafts intact (drivers already have PIN in
  Drive mode).
- **Language**: en/es toggle in profile; driver app and buyer portal fully localized first.

# RouteFlow Web — Claude Design master prompt

This is the single prompt to give Claude Design to redesign the entire RouteFlow web app into one
consistent system. It is written so **nothing is missed**: the complete screen list and the
non-negotiable feature list are inlined below, and the detailed per-screen behavior lives in the
dependency files.

---

## How to use this

1. **Create/open** a Claude Design project for RouteFlow web (e.g. "RouteFlow Web — Unified").
2. **Attach the dependencies** (below) so Claude Design can read the detailed spec. Easiest path:
   copy the whole `docs/web-inventory/` folder into the Claude Design project (or upload/paste the
   files). If you can only paste text, this prompt alone still enumerates every screen + feature.
3. **Paste "THE PROMPT"** section (everything under that heading) as your instruction.
4. Claude Design will first return a **visual-system proposal + 3 hero screens** — review the
   _look_, then tell it to build the rest.

---

## Dependencies (the source of truth — attach all)

| File                         | What it gives Claude Design                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `README.md`                  | Personas, app-wide model (multi-tenancy, RBAC, realtime, money discipline, impersonation, branding), full route map, and the **redirect-stub/consolidation table** |
| `00-design-system.md`        | The functional brief: brand teal, context accents, density, inconsistency→resolution, archetypes, division of labor                                                |
| `01-auth-and-entry.md`       | Every auth/entry surface                                                                                                                                           |
| `02-marketing-site.md`       | Public marketing pages + side-theming                                                                                                                              |
| `03-operator-shell.md`       | Operator app shell: nav trees per role, header, Cmd+K, shortcuts, impersonation, dashboard                                                                         |
| `04-op-orders.md`            | Orders, order detail (inline price edit), returns, the sale/order builder                                                                                          |
| `05-op-dispatch-routes.md`   | Dispatch, routes, route builder wizard, live dispatch, templates, my-runs                                                                                          |
| `06-op-people.md`            | Customers + drivers (lists, details, forms)                                                                                                                        |
| `07-op-warehouse.md`         | Inventory, products, suppliers, vendor bills / bills-&-purchasing                                                                                                  |
| `08-op-finance.md`           | Invoices, recurring, payments, credit notes, estimates, expenses, reports, bookkeeping                                                                             |
| `09-op-analytics-tobacco.md` | Analytics (4 tabs) + tobacco compliance (addon-gated)                                                                                                              |
| `10-op-settings.md`          | Settings (8 tabs) + import wizard                                                                                                                                  |
| `11-buyer-portal.md`         | Buyer B2B portal (shell + all per-seller pages)                                                                                                                    |
| `12-platform-admin.md`       | Super-admin platform panel                                                                                                                                         |
| `13-shared-patterns.md`      | **The non-negotiable UX kit + component inventory + realtime map + money invariants**                                                                              |

> Do **not** copy the app's current CSS/token files (`globals.css`, `marketing.css`, the buyer
> palette, per-screen inline auth styles) as visual input — those are the _fragmented_ systems this
> redesign replaces. Use them only to understand behavior, never to inherit look.

---

# THE PROMPT

You are redesigning the **RouteFlow web app** — a multi-tenant wholesale delivery/route-management
SaaS — into **one consistent visual system**. Today its surfaces "look like pieces from different
apps" (three unrelated auth screens, four+ token systems). Your job is to make every surface
unmistakably the same product, while preserving every feature and flow.

## Division of labor (important)

- **The attached `docs/web-inventory/` files define WHAT each screen does** — data, actions,
  states, flows, business rules. Treat them as the source of truth. **Read all of them before
  designing.** Do not invent flows or drop features; if something's ambiguous, ask.
- **You own the APPEARANCE** — typography, corner/shape language, elevation, spacing rhythm,
  iconography, visual detailing. Choose a distinctive, professional system that avoids generic
  AI-template aesthetics.
- **Consistency is the acceptance bar.** Define your visual system **once** and apply it to **every**
  screen. Surfaces may differ only by an **accent color** and a **density setting** — never by being
  a different-looking app.

## Brand + functional inputs (fixed)

- **Brand hue: teal** is the default accent. It must be driven by a `--primary` CSS variable so a
  tenant's custom brand color can override it at runtime (keep a static `brand` vs tenant `primary`
  distinction). Logo is tenant-supplied.
- **Context accents (accent-only deltas on the same system):** Operator/Tenant-Admin = brand teal;
  **Buyer portal = emerald**; **Platform admin = indigo on a slate-tinted chrome**; Marketing =
  teal, with a **retailer sub-theme = rust**.
- **Status colors (one set everywhere):** success green, warning amber, danger red, info blue. All
  domain status pills (order/invoice/route/return/etc.) map onto these.
- **Density:** Operator + Platform-admin = **compact** (data-dense tables); Buyer portal =
  **comfortable**; Marketing = **spacious**.
- **Money:** always display `$X.XX`, use tabular figures, `total = subtotal + tax` (±$0.01), ≤2
  decimals. Never re-derive boxed-line prices.

## Consolidation (design the cleaned-up target, not today's sprawl)

Many current "routes" are redirect stubs — **do not design them as separate screens.** Instead:

- **One auth screen** (accent-themed variants for operator / admin / buyer) — not three.
- **One "Bills & Purchasing" hub** merging `/purchases`, `/vendor-bills` list, and the Finance
  Expenses "Inventory" tab (keep the vendor-bill **detail** with its unlinked-items mapping).
- **One Receivables/Finance overview** (merge `/finance`, `/finance/dashboard`, `/finance/customers`).
- **One sale/order builder** (merge today's `/invoices/new` sale flow with the order create modal;
  "bill from an existing order" is a mode of the invoice flow, not a separate UI).
- **Shipments** = a "Shipped" filter on the invoices list (keep its **Carrier / Tracking# columns +
  external tracking link**), not its own screen.
- **No AP "payments-out" screen** — supplier/vendor payment is the vendor-bill **Record Payment**
  modal inside Bills & Purchasing; `/finance/payments` is \*payments **received\*** (AR), not outflow.
- Drop dead redirects: `/distributors` (→ use `/wholesalers`), `/admin/login`, `/callback`, `/buyer`.

## Workflow (do this in order)

1. **Visual-system proposal**: a single page showing your chosen type scale, color tokens (with the
   teal brand + the context accents + status set), shape/elevation language, and the core component
   kit (buttons, inputs, table row, tabs, badge/pill, card, modal, toast). State the system in words.
2. **3 hero screens** applying it: **operator dashboard**, **orders list** (with saved-view chips +
   filters + bulk bar), **order detail** (with inline per-line price editing + strikethrough
   override). Pause for review here.
3. After approval, **build the full set** below by archetype. Screens sharing an archetype reuse the
   same template; design each genuinely-distinct screen. **Run your verify loop** (render → gate on
   console/network/mount errors → fresh-eyes check → fix) on every rendered file.

## COMPLETE SCREEN CHECKLIST (design every item; ✅ each when done)

**Shared kit (design first, reuse everywhere):** buttons · inputs/select/combobox · **data table
(sortable header with hover/active chevron cycle; skeleton rows + empty state baked in)** · cards ·
tabs · badges/status pills · modals/drawers · **confirm dialog** · **toasts (bottom-right, swipe,
4s)** · **command palette (⌘K)** · empty states · **bulk-select action bar** · barcode-scan UI
(USB + webcam overlay) · searchable product picker · unit combobox (boxes+pieces) · address
autocomplete · page header · avatar/menu · **notification bell + dropdown panel**.

**Nav shells (3, same structure, differ by accent + density):** operator collapsible sidebar (role
nav trees + accordion) **+ sticky header (⌘K search pill, notification bell, avatar menu)** · buyer sidebar (emerald + "Your Sellers" switcher + floating cart) · admin
sidebar (slate + indigo + Shield) · marketing top nav (side-switch).

**Auth (1 template, variants):** unified login (operator / admin / buyer accent variants) · operator
signup + check-email · buyer register · buyer invite (token) · buyer verify-merge · change-password
(forced + self-serve) · verify-email · OAuth callback (transitional spinner).

**Marketing (spacious, side-themed):** home · product · pricing · company · retailers (rust) ·
wholesalers (teal) · contact (bring into the system — it's a third language today).

**Operator — Orders:** orders list · order detail (inline price edit, timeline, multi-channel
send: WhatsApp/SMS/email/PDF) · sale/order builder (scan-to-add + auto-scroll + price memory) ·
returns list · return detail.

**Operator — Dispatch & Routes:** dispatch overview · routes list · route builder wizard (numbered
steps) · route/run detail · live dispatch (read-only POD + loading manifest) · route template
detail · my-runs (driver-self).

**Operator — People:** customers list · customer detail (tabbed) · customer form (create/edit
modal, optional email) · drivers list · driver detail · driver form (add/edit modal).

**Operator — Warehouse:** inventory hub (tabs: stock · stock-count · suppliers · purchase-orders · forecasting) + cost modals
(set/bulk-set/recompute dry-run, quick-restock, adjust) · inventory movements · products list ·
product create/detail (image focal-point 4:5 crop, variants, pricing tiers, cost history, tobacco
flag) · suppliers list · supplier detail · **Bills & Purchasing hub** · vendor-bill detail
(unlinked-items mapping) · scan-invoice (OCR) modal.

**Operator — Finance:** Receivables/finance overview (AR aging + KPIs) · invoices list · invoice
detail · invoice edit (draft) · invoice creation flow (incl. "from order" mode) · recurring
invoices list · recurring invoice new · payments-received (AR) list · credit notes list · credit
note detail · estimates list · estimate detail · expenses (tabbed) · expense new (expense / mileage
/ bulk) · payment receipt detail (`/finance/payments/[id]` — printable receipt: Payment # + status ·
Received From / Date / Mode / Reference · Applied-to-Invoice link · Amount Received − Bank Charges =
Total Applied · Void Payment) · reports (AR aging / P&L / cash flow / expense
breakdown) · bookkeeping ledger · transaction detail.

**Operator — Analytics & Tobacco:** analytics (tabs: Revenue / Products & Inventory / Customers /
Operations) · tobacco compliance (KPIs + monthly chart; tabs: Reports / Inventory / Purchases /
Sales; addon-disabled upsell state).

**Operator — Settings:** settings (8 tabs: Business Profile · Notifications · User Management ·
Import · Email · Invoicing · Integrations · My Account) · import wizard (Products→Customers→
Inventory→Invoices→Payments→Expenses).

**Buyer portal (emerald, comfortable):** portal shell · seller directory/landing (+ "no sellers"
empty state) · global buyer settings · per-seller dashboard · shop (catalog, focal-point images,
cart badge) · favorites · cart/checkout · orders list · order detail (status timeline, track) ·
invoices list · invoice detail (auth-aware PDF download + read-only payment history/balance; **no
in-app pay** — pay off-app) · finances (spend KPIs · 12-mo spend chart · invoice-status/AR breakdown ·
recent payments) · standing orders
(templates) · account.

**Platform admin (slate + indigo):** admin dashboard (total/active/trial tenants + total users ·
tenant-growth chart · plan mix · trials-expiring · at-risk) · tenants list · tenant new · tenant
detail (5 tabs: Overview / Billing & Subscription / Addons & Features / Configuration / Audit Log;
impersonate) · buyers list · buyer detail · merge-requests list · merge-request detail · plans ·
billing (**Est. MRR** + subscriptions) · audit logs · admin profile · admin settings (**AI config
only**: API-key status · Anthropic key · default model · max output tokens).

## NON-NEGOTIABLE features (must survive the redesign — verbatim)

- Barcode scanning **both ways** (USB fast-keystroke auto-submit + webcam @zxing overlay) on every
  scan surface; **just-scanned line auto-scrolls into view**; re-scanning a line increments qty.
- **Per-customer price memory** (negotiated unit price auto-fills; list price shown struck through;
  price carries forward).
- **Inline per-line editing** (boxes+pieces qty, unit price, discount) with rounded money math and
  the override convention (net price + struck-through original + `discount: 0`).
- **Saved views** (filter-preset chips with active-highlight) + **URL-backed filter state**
  (shareable/refresh-safe; resets pagination on change).
- **Command palette (⌘K/Ctrl+K)** with role-filtered nav/actions + live search; **g-sequence
  shortcuts** (gh/go/gr/gd/gc/gi/gf/gs) + **`?`** help modal.
- **Toasts** bottom-right, swipe-to-dismiss, 4s, 4 variants.
- **Skeleton loaders** on tables; **illustrated empty states on every list/detail** (apply
  everywhere, not just some pages); **sortable headers** with the chevron cycle.
- **Realtime updates** — live data refresh + toasts for urgent orders / low stock / driver status /
  new returns / connection loss.
- **Notification center** — header **bell** with unread-count badge (caps at "9+"), opening a
  socket-fed + localStorage-persisted (`rf_notifications`, cap 50, newest-first) dropdown of
  type-colored items (urgent / route / driver / stock) with **Clear-all**, mark-all-read on open, and
  an illustrated empty state; **distinct from the toast system** (operator, buyer & admin shells each
  have one).
- **Bulk selection** with contextual/sticky action bar + destructive confirm reporting partial
  success.
- **Inline-create-and-auto-select** for products & suppliers; **searchable pickers**; **unit
  combobox**; **debounced address autocomplete** — all keyboard-navigable.
- **Multi-channel _order_ send** (WhatsApp / SMS / Email, per available contact info); **invoice**
  send is Email + Mark-as-Sent (no-email fallback: Print / Download / Mark-as-Sent) + Print/PDF —
  **no WhatsApp/SMS on invoices**; **CSV export** + **auth-aware PDF download**.
- **Tenant branding** — runtime `--primary` injection drives accent/logo, non-fatal if absent.
- **PWA install** prompts. **All money `$X.XX`**, `total = subtotal + tax`, ≤2 decimals.

## Acceptance criteria

- One coherent visual system applied to **every** screen above (no surface looks like a different
  app); differences are accent + density only.
- Every checklist item designed; every non-negotiable visibly present where it applies.
- Consolidations reflected (one auth screen, one bills hub, one finance overview, one sale builder).
- Every rendered file passes your verify loop (no console errors, no blank mounts, legible type &
  contrast, money as `$X.XX`).

If anything here conflicts with a dependency file, the dependency file wins on **behavior/data**;
you win on **appearance**. Ask before adding pages, flows, or content not listed here.

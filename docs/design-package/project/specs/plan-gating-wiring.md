# Plan Gating — Wiring & Promise Traceability

> How pricing (see `pricing-plans.md`) is enforced, and proof that **every promised feature maps
> to a built design**. Gate UX: `unified/plan-gates.html`. Rule of the house: a gate is either a
> page that sells itself, a one-tap resolution inside the flow, or a grace period — never a wall.

## 1. Enforcement architecture

- **Server is the authority.** JWT carries `plan`, `flags[]`, `addons[]`, `seats`, `trial_ends`.
  Every gated endpoint checks its flag; client state can never unlock server behavior.
- **Client renders one of three gate states:**
  1. `LOCKED_PAGE` — nav item stays visible with a plan chip; the page renders ghost content +
     an upsell card (pattern: Analytics card on the plan-gates sheet; same pattern already used
     by Regulated Items). One CTA upgrades, one adds the à-la-carte add-on where it exists.
  2. `INLINE_RESOLVE` — caps resolved inside the flow (seat limit inside the invite modal,
     route cap inside run start, add-on enable with proration). One tap, flow continues.
  3. `GRACE` — soft caps (routes/seats after a downgrade) warn, start a 7-day grace, and only
     then queue *new* work; **a run in progress is never interrupted**.
- **Billing events**: `plan.changed`, `addon.enabled/disabled`, `seat.added/freed`,
  `grace.started/expired`, `trial.converted/expired` — all audit-logged and drive the platform
  admin Billing screen (Est. MRR = base + addon SKUs).
- **Trial**: full Business flags for 14 days; expiry flips tenant to `READ_ONLY` (exports and
  sign-in still work). Subscribing restores flags in place.
- **Downgrade**: scheduled at period end; preview modal enumerates exactly what locks / goes
  read-only / needs choosing (the 5-active-users picker). Nothing is deleted.

## 2. Promise → flag → surface traceability

Every line sold on `pricing.html`, its flag, and the design that fulfills it:

| Promise (pricing page) | Flag / cap | Fulfilled by (designed surface) |
|---|---|---|
| Unlimited orders, invoices, customers | core | orders-list, order-detail, order-builder, invoice-detail, customers, customer-detail |
| Barcode scanning USB + camera | core | order-builder scanbar, overlays (webcam), products scan-to-find |
| Price memory | core | order-builder (struck list + Special tags), customer-detail → Negotiated Prices |
| Live cost & margin (WAC/FIFO/last) | core | order-builder cost hints, pos-flow (negotiation + costing method), product-detail cost history |
| Inventory + quick restock | core | inventory-hub (+ restock/adjust/dry-run modals in action-modals) |
| 1 route/day, POD, at-door edits | core / `routes_concurrent` | route-builder, my-runs, live-dispatch, pos-flow at-door card |
| Payments (AR) + receipts | core | payment-receipt, finance-overview, record-payment modal |
| Offline PWA | core | guardrails offline bar + sync queue |
| Dispatch overview + live tracking | `flag.dispatch_live` | dispatch, live-dispatch |
| Returns & credit notes | `flag.returns` | returns list, credit-notes list (`credit-notes.html`), report-an-issue flow |
| Bills & Purchasing (AP) | `flag.ap_bills` | bills-purchasing hub, vendor-bill-detail, AP payment modal |
| Reports (AR aging / P&L / cash flow) | `flag.reports` | reports (4 tabs) |
| Credit limits | `flag.credit_limits` | guardrails credit-limit modal + limit/behavior fields on the customer form (action-modals) |
| Run settlement | `flag.settlement` | guardrails settlement modal |
| Pricing tiers & margin floors | `flag.pricing_tiers` | product-detail tiers table, pos-flow floor warning |
| Analytics + forecasting | `flag.analytics` / `flag.forecasting` | analytics (4 tabs); demand forecasting (`forecasting.html` — inventory Forecasting tab: velocity, days-of-stock, suggested POs) |
| Buyer portal | `addon.buyer_portal` | full buyer set: sellers, dashboard, shop, product, cart, orders, tracking, invoices, finances, standing, licenses |
| Standing orders & disputes | `addon.buyer_portal` | buyer-standing, guardrails report-an-issue |
| Regulated-Items Compliance | `addon.regulated_items` | compliance hub, tracked-categories, invoice split (order-builder + invoice-detail), license flows, buyer gating |
| OCR / AI bill scanning | `metered.ocr_scans` (20/100/300/∞ + packs) | bills hub "Scan invoice (AI)" with usage meter, vendor-bill-detail auto-mapping, plan-gates metered-scan card |
| Import wizard & integrations | `flag.import_integrations` | full import wizard (`import-wizard.html` — mapping, dry-run, undo) + Integrations tab (`settings-integrations.html` — accounting sync, webhooks) |
| Messaging (WhatsApp/SMS) | `MSG_BUNDLE` metering | multi-channel send modal (action-modals) |
| Extra seats / routes | `seats`, `routes_concurrent` | plan-gates seat + route cards |
| API & SSO (Enterprise) | `flag.api_sso` | `settings-integrations.html` — scoped API keys + SAML SSO cards (Enterprise-chipped) |
| Priority/dedicated support | n/a | support channel config, out of app scope |

**Audit result:** every sold line now traces to a drawn interface — including credit notes,
demand forecasting, the full import wizard, integrations/API/SSO, and the customer-level credit
limit fields. No promise ships on an archetype-only basis anymore.

## 3. Gate placement map (what each plan hides/locks)

- **Starter**: nav shows Dispatch/Returns/Bills/Reports/Analytics with plan chips → LOCKED_PAGE.
  Run start beyond 1/day → INLINE_RESOLVE (add route / upgrade). Invite → INLINE_RESOLVE.
- **Team**: Analytics → LOCKED_PAGE (or Forecasting add-on). Buyer-portal settings → LOCKED_PAGE
  with $49 add-on CTA. 4th route → GRACE then queue.
- **Business**: only the regulated add-on gate remains; it uses the upsell-page pattern. AI
  scanning is included everywhere — only the *meter* differs by plan.
- **Metered AI scans**: quota shown next to the scan button (e.g. `184/300 this mo`). Hitting the
  cap never interrupts an in-progress scan — it completes, then an INLINE_RESOLVE prompt offers
  +250 pack ($19/mo, prorated) or manual entry. Meter resets each billing cycle; Enterprise is
  unlimited (fair use).
- **All plans**: disabling an add-on → its data read-only, nav hidden, tags dormant (regulated
  rule reused for buyer portal: buyers see read-only history, no new carts).

## 4. Plan-lifecycle interface map (all designed)

| Stage | Surface | File |
|---|---|---|
| Create workspace (trial starts) | Tenant signup | `signup.html` |
| Trial countdown / expiry | banner + read-only state | `plan-gates.html` |
| Pick / change plan | in-app chooser w/ usage-fit recommendation + checkout | `choose-plan.html` |
| Manage subscription | Settings → Plan & Billing (meters, add-ons, payment method, RF invoices, cancel) | `settings-billing.html` |
| Hit a gate / cap | upsell pages, inline resolves, grace, metered scans | `plan-gates.html` |
| Platform: define plans | Plans & Features editor (versioned publish, SKUs) | `admin-plans.html` |
| Platform: per-tenant | Tenant detail (plan, addons, payment method, last invoice) + Billing (Est. MRR) | `admin-tenant-detail.html`, `admin-billing.html` |

Flow: signup → 14-day Business trial → `choose-plan` (recommended = cheapest plan fitting actual
trial usage; over-cap consequences shown per card before picking) → manage in Settings → gates
resolve inline forever after. Downgrade/cancel both route through the preview modal.

## 5. Acceptance

- [ ] Server rejects gated calls regardless of client state; flags come only from the JWT/refresh.
- [ ] Every locked nav item lands on an upsell page (no dead clicks, no 404s, no hidden features
      that were promised as visible).
- [ ] Caps resolve inline: seat add ≤2 taps, route add ≤2 taps, proration shown before charge.
- [ ] Grace: new-work queue only after 7 days; active runs never interrupted (test mid-run cap).
- [ ] Trial expiry → read-only with working exports; subscribe restores state losslessly.
- [ ] Downgrade preview lists every consequence; scheduled, cancelable, nothing deleted.
- [ ] MRR math on admin Billing = Σ(base + addons − discounts) and matches billing events.
- [ ] Scan meter counts per cycle, resets on renewal; cap completes the in-flight scan, then
      prompts a pack inline; packs stack and prorate; Enterprise unmetered.

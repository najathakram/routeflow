# Pricing Plans — Canonical Spec

> The plan/add-on matrix for wiring: plan gates, addon SKUs, billing rules. Designs:
> `unified/pricing.html` (full page), `unified/marketing-home.html` (teaser), platform-admin
> Plans & Billing screens. Philosophy: **start small, add things** — a $59 solo plan that
> already runs a whole business day, with modules and seats bolted on as needed.

## Plans

| | **Starter $59/mo** | **Team $149/mo** | **Business $349/mo** | **Enterprise custom** |
|---|---|---|---|---|
| Who | Owner-operator, one van | Crew + dispatch morning | Portal-driven operation | Multi-depot, custom terms |
| Users included | 1 | 5 | 15 | Unlimited |
| Concurrent routes | 1/day | 3 | Unlimited | Unlimited |
| Orders / invoices / customers | ✓ unlimited | ✓ | ✓ | ✓ |
| Scanning + price memory | ✓ | ✓ | ✓ | ✓ |
| Cost accounting (WAC/FIFO/last) + live margin | ✓ | ✓ | ✓ | ✓ |
| Routes, POD, at-door edits, offline PWA | ✓ | ✓ | ✓ | ✓ |
| Payments (AR) + receipts | ✓ | ✓ | ✓ | ✓ |
| Dispatch overview + live tracking | — | ✓ | ✓ | ✓ |
| Returns & credit notes | — | ✓ | ✓ | ✓ |
| Bills & Purchasing (AP) | — | ✓ | ✓ | ✓ |
| Reports (AR aging / P&L / cash flow) | — | ✓ | ✓ | ✓ |
| Credit limits + run settlement | — | ✓ | ✓ | ✓ |
| Pricing tiers + margin floors | — | — | ✓ | ✓ |
| Analytics + forecasting | — | add-on $19 | ✓ | ✓ |
| Buyer portal | add-on $49 | add-on $49 | ✓ included | ✓ |
| Regulated-Items Compliance | add-on $39 | add-on $39 | add-on $39 | ✓ included |
| OCR / AI invoice scanning | **included**: 20/mo | **included**: 100/mo | **included**: 300/mo | ✓ unlimited |
| Import wizard + integrations | — | — | ✓ | ✓ |
| API + SSO | — | — | — | ✓ |
| Support | Standard | Standard | Priority | Dedicated + SLA |

## Add-on SKUs (any plan, prorated daily)

| SKU | Price | Notes |
|---|---|---|
| `SEAT_EXTRA` | $12/user/mo | Beyond included users; role-agnostic |
| `BUYER_PORTAL` | $49/mo | Included at Business+ |
| `REGULATED_ITEMS` | $39/mo | Unlimited tracked categories, filings, licenses, invoice splits |
| `OCR_PACK_250` | $19/mo per +250 scans | Stackable; scans are metered but **never blocked mid-flow** — quota-exceeded prompts a pack inline |
| `FORECASTING` | $19/mo | Starter/Team only (in Business core) |
| `ROUTE_EXTRA` | $15/route/mo | Team plan only |
| `MSG_BUNDLE_500` | $10/mo | WhatsApp/SMS beyond included 200/mo |

## Billing rules

- **Trial**: 14 days, Business-level features, no card; converts by picking any plan. Expiry →
  read-only (data intact, exports allowed) until subscribed.
- **Cycle**: monthly or annual (annual = 2 months free, i.e. ×10). Plan changes prorate daily;
  upgrades apply instantly, downgrades at period end.
- **Seats**: an active (non-deactivated) user occupies a seat; deactivating frees it immediately.
- **Soft caps, never blocked deliveries**: exceeding routes/seats warns and grants a 7-day grace
  with upgrade prompt — a run in progress is never interrupted.
- **Downgrade with excess data**: over-cap entities (extra routes, portal, categories) go
  read-only, never deleted.
- **Addon off-switch**: disabling Regulated-Items keeps all history/filings read-only; nav item
  hides; products keep their category tags dormant.
- Platform admin: plans/addons managed per tenant on the Tenant Detail → Addons & Features tab;
  MRR = base + addon SKUs (drives the Billing screen's Est. MRR).

## Feature-flag keys (enforcement points)

`plan.users_included` · `plan.routes_concurrent` · `flag.dispatch_live` · `flag.returns` ·
`flag.ap_bills` · `flag.reports` · `flag.credit_limits` · `flag.settlement` ·
`flag.pricing_tiers` · `flag.analytics` · `flag.forecasting` · `addon.buyer_portal` ·
`addon.regulated_items` · `addon.ocr` · `flag.import_integrations` · `flag.api_sso` ·
`flag.estimates` · `flag.recurring_invoices` · `flag.credit_notes` · `flag.suppliers` ·
`flag.messaging`

Server-side enforced; client hides or upsells gated surfaces (upsell state = the same page with
a feature summary + enable CTA, per the Regulated Items pattern).

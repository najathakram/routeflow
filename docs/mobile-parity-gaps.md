# Mobile ⇄ Web feature-parity gaps (roadmap)

> **Status:** analysis / roadmap (Issue 7). Nothing here is built yet — it scopes what the
> mobile app is missing vs the web **golden reference** and proposes a prioritized order.
> Web is authoritative for flows/DTOs; mobile reuses the **same API endpoints** (per
> `CLAUDE.md`), so most gaps are **UI-only** — the backend already exists.

Method: compared `apps/web/app/(dashboard)/*` and `apps/web/app/buyer/portal/[seller]/*` against
`apps/mobile/app/(operator)/*` and `apps/mobile/app/(customer)/*` (verified by directory listing,
2026-06-21, HEAD `e85935d`).

Legend — **Status:** ❌ missing · ⚠️ thinner/partial · ✅ present.
**Effort:** S (reuse existing API + list/detail screens) · M · L (new sub-flows).

---

## Operator (wholesaler) — web `(dashboard)` vs mobile `(operator)`

| Feature                | Web path                             | Mobile                                       | Status | Pri  | Effort | Notes                                                                                                                                          |
| ---------------------- | ------------------------------------ | -------------------------------------------- | ------ | ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Estimates / quotes** | `estimates/`                         | —                                            | ❌     | High | M      | Full CRUD + send + convert-to-invoice exists in API (`estimates` module). No mobile screen.                                                    |
| **Credit notes**       | `credit-notes/`                      | —                                            | ❌     | High | M      | API `credit-notes` (issue/apply/void). Operators need this on the road for returns/adjustments.                                                |
| **Recurring invoices** | `invoices/recurring/`                | —                                            | ❌     | Med  | M      | API `recurring-invoices`. Mobile `invoices/` has create/list/detail only.                                                                      |
| **Finance reports**    | `finance/reports/`                   | `(tabs)/finance.tsx` (KPIs only)             | ⚠️     | High | M      | AR aging / P&L / cash flow / expense breakdown exist in API `analytics`/`finance`. Mobile finance tab shows headline KPIs but no report views. |
| **Payments ledger**    | `finance/payments/`                  | folded into finance tab                      | ⚠️     | Med  | S      | Dedicated payments list + detail on web; mobile lacks a standalone view.                                                                       |
| **Bookkeeping**        | `bookkeeping/`                       | —                                            | ❌     | Low  | L      | Transaction-level ledger. Lower priority for a phone.                                                                                          |
| **Settings → import**  | `settings/import/`                   | `settings/` (no import)                      | ❌     | Low  | M      | Bulk CSV import — desktop-first; low value on mobile.                                                                                          |
| **Route templates**    | `routes/templates/`                  | `routes/` (no templates)                     | ⚠️     | Med  | M      | API `order-templates`/route templates exist. Mobile creates ad-hoc routes only.                                                                |
| **Inventory**          | `inventory/`, `inventory/movements/` | `warehouse.tsx`, `movements.tsx`, `pick.tsx` | ⚠️     | —    | —      | Mostly covered under different names; audit for stock-count/forecasting parity.                                                                |

**Mobile-only operator screens (keep — operational additions, no web equivalent):**
`warehouse`, `pick`, `exceptions`, `fleet`, `movements`, `messages`, `route-runs`, `new-order`.

---

## Customer / buyer — web `buyer/portal/[seller]` vs mobile `(customer)`

| Feature                                     | Web path                                      | Mobile                                    | Status | Pri  | Effort | Notes                                                                       |
| ------------------------------------------- | --------------------------------------------- | ----------------------------------------- | ------ | ---- | ------ | --------------------------------------------------------------------------- |
| **Favorites / quick-reorder**               | `favorites/`                                  | —                                         | ❌     | High | S      | API buyer favorites exist. High-value repeat-order shortcut for buyers.     |
| **Order templates (manage)**                | `templates/`                                  | `standing-orders.tsx` (view)              | ⚠️     | Med  | M      | Mobile shows the recurring calendar; web lets buyers create/edit templates. |
| **Finances overview**                       | `finances/`                                   | `invoices/` only                          | ⚠️     | Med  | S      | Web buyer has a statement/balance view; mobile shows invoices list only.    |
| **Account / settings**                      | `account/`, `portal/settings/`                | `profile.tsx` (thin)                      | ⚠️     | Low  | S      | Consolidate profile + notification/account settings.                        |
| Shop / cart / orders / invoices / dashboard | `shop` `cart` `orders` `invoices` `dashboard` | catalog / cart / orders / invoices / home | ✅     | —    | —      | At parity.                                                                  |

---

## Proposed phasing (future passes — one feature per session, mobile mirrors web)

**Phase A — finance on the road (highest operator value):**

1. Estimates (list → detail → send → convert). 2. Credit notes (list → issue/apply/void).
2. Finance **reports** (AR aging + P&L + cash flow as read-only mobile views).

**Phase B — buyer retention:** 4. Buyer **favorites / quick-reorder**. 5. Buyer **finances/statement** view. 6. Standing-order **template management** (promote the existing view to full CRUD).

**Phase C — completeness:** 7. Recurring invoices. 8. Route templates. 9. Payments ledger view. 10. Bookkeeping + settings/import (desktop-first; lowest mobile priority).

For each: follow the `new-feature` skill, reuse the existing API DTOs/endpoints, and add the
screen under the matching `(operator)`/`(customer)` route group. Update `.claude/code-map/mobile.md`
after each addition.

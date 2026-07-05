# Backend Wiring Index — All Features

> One map from every designed surface to its backend domain. Detailed rules live in the
> per-domain specs; this is the completeness checklist for wiring. **Status: every feature sold
> on the pricing page and shown on the canvas has a spec + interface — ready to wire.**

| Domain | Core entities | Key endpoints/events | Spec | Interfaces (unified/) |
|---|---|---|---|---|
| Orders & sale builder | orders, order_items (cost/category/price snapshots), drafts | CRUD, `POST /orders/:id/invoices` (split), scan lookup, draft sync | pos-cost-roles, regulated-items | order-builder, orders-list, order-detail, pos-flow |
| Invoicing & AR | invoices (invoice_group pairing), payments, credit_notes | send (email/mark-sent), record/void payment, apply credit | regulated-items §4, guardrails §9 | invoice-detail, payment-receipt, credit-notes, finance-overview |
| Dispatch & delivery | routes, runs, stops, POD, settlements | run lifecycle events, stop status, failed-delivery, settlement | guardrails §4/§11 | dispatch, route-builder, live-dispatch, my-runs |
| Inventory & costing | products, lots/WAC, vendor_bills, POs | receive→recost, dry-run, forecast, import | pos-cost-roles §1, guardrails §3/§10 | inventory-hub, product-detail, bills-purchasing, vendor-bill-detail, forecasting, import-wizard |
| Regulated items | tracked_categories, customer_authorizations, overrides, category ledger | category CRUD, approve/reject, override, filings | regulated-items | compliance, tracked-categories, buyer-licenses, action-modals |
| Buyer portal | seller links, carts, standing orders, disputes, **promotions, stock_alerts, replenishment estimates, order revisions + change requests, check chains, credit wallet, statements** | connect/approve, cart→order, open-order edit/version, change-request resolve, reorder diff, issue→credit, statement PDF | guardrails §5–8, regulated §8, **buyer-experience-spec** | buyer-* (16 screens) |
| Messaging | threads, messages, rules, templates, optouts, usage | provider webhooks, event fan-out, STOP, meter | messaging-spec | messages, buyer-messages, settings-notifications, send modal |
| Roles & modes | users (canActAsDriver), capability sets | drive-mode (client), server capability checks | pos-cost-roles §4 | pos-flow, my-runs, settings (users) |
| Offline sync | local queue, conflict review | replay, conflict list | guardrails §1 | guardrails sheet |
| Billing & plans | plans (versioned), subscriptions, addon SKUs, meters (seats/routes/scans/msgs) | subscribe/prorate, grace, trial, downgrade schedule | pricing-plans, plan-gating-wiring | pricing, choose-plan, settings-billing, plan-gates, admin-plans, admin-billing |
| Migration & batch import | numbering_sequences, external ids, staging area, import queue, product variants (parent_id), product_aliases | source OAuth fetch, upsert-by-external-id, batch queue + statuses, variant create-and-receive, alias learn, 24h undo | migration-import-spec | migration, batch-import, import-wizard, onboarding |
| UX standards | soft-delete undo windows, user locale | undo restore, re-auth, locale render | migration-import-spec §6 | ux-standards sheet |
| Platform admin | tenants, buyers, merges, audit | impersonate, lifecycle, MRR rollup | plan-gating §1/§4 | admin-* (7 screens) |
| Notifications (internal) | rf_notifications feed | socket events, bell feed | shared patterns (upload docs) | overlays sheet |

**Billing cycle note:** monthly AND annual are first-class on every plan; annual = ×10 (2 months
free) and is presented inside the Annual tab on `pricing.html` / `choose-plan.html` (live toggle).
All meters (scans, messages) reset per billing cycle regardless of cadence.

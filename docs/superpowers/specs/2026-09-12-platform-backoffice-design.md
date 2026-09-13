# Platform back office redesign: design spec (umbrella)

Status: approved by the owner on 2026-09-12 (sections 1-5 approved in conversation; remaining
recommendations auto-approved). Sub-project specs: `2026-09-12-backoffice-phase-0-truth-design.md`
(first), then one per phase.

## Context

RouteFlow's platform-admin panel works as a tenant switchboard but not as a back office. A
read-only walkthrough of production, three codebase inventories, a 252-capability benchmark
against HubSpot / Zoho / Chargebee / Intercom / ChartMogul-class operators (scored and
adversarially re-verified against `origin/master`), three independent designs judged by two
reviewers, and a completeness critic produced the review published as the "RouteFlow Back Office
Review" artifact. Findings that drive this spec:

- 252 capabilities: 2 have, 61 partial, 173 missing, 16 broken; 23 P0 of which 21 are billing.
- Two MRR engines disagree on screen (`getStats()` estimate vs `MrrService`); several ACTIVE
  tenants have no `TenantSubscription` row; manual (Enterprise) activation writes no plan key,
  price snapshot or `BillingEvent`, so the founder's real sales motion books zero revenue.
- The legacy `Tenant.plan` enum cannot hold GROWTH or SCALE; every list reads it, so the admin
  shows "Business" while the pricing card bills "Scale $499" and Growth cannot be sold.
- No invoice has ever been issued to a tenant (`RfInvoice` has no writer). Failed payments
  persist no state, so grace and suspension never fire (B327). Admin plan changes and priced
  add-ons never reach Stripe; add-on re-enable double-creates Stripe items (B342).
- An expired trial cannot self-serve subscribe (`POST /billing/quote` missing from the
  READ_ONLY allowlist) and receives no email. Every lifecycle transition is silent except an
  admin-path welcome and one payment-failed notice.
- The single SUPER_ADMIN account reaches all tenants with no MFA; impersonation end is never
  audited (B173); OAuth state is unsigned (B349).
- 18 of 26 tenants and 483 of 520 buyers are test residue inside every KPI.

The owner's rulings: revenue-first sequencing; operators are the founder plus 1-2 support
people; both self-serve (Starter, Growth) and sales-led (Scale, Enterprise) acquisition;
RouteFlow is itself a CRM, so the back office dogfoods the product's own customer, contact,
messaging and invoicing machinery through a house tenant (option A), with Stripe Billing kept
alongside for card subscriptions.

## Goals and non-goals

Goals: one true money number; every dollar owed is invoiced, collected and reconciled; every
lifecycle moment produces a message and a record; a tenant 360 an operator opens for every
call; the platform's own customer relationships managed inside RouteFlow; safe operation by a
tiny team (MFA, audited impersonation, high-signal audit, test-data separation).

Non-goals at this tenant count (named trigger for promotion in each phase spec): coupons,
multi-currency and tax, revenue recognition, cohort and LTV analytics, a visual journey
builder, full RBAC, announcements and broadcasts, status page, custom domains, partner and
reseller programs, an external CRM adapter.

## Section 1: Architecture (house tenant "RouteFlow HQ")

- HQ is an ordinary tenant (slug `routeflow-hq`, class INTERNAL), named once in
  `PlatformConfig.houseTenantId`. Every real tenant is mirrored as exactly one HQ `Customer`
  (`Customer.representsTenantId`, unique). Tenant admins and billing contacts are mirrored as
  `ContactPerson` rows with a new `role`. A `TenantMirrorService.upsert(tenantId)` runs on
  tenant create, rename and admin change, plus a nightly reconcile; the mirror is never
  hand-entered.
- Money flows through HQ's accounts-receivable stack: HQ `Invoice`s (numbering, PDF, send,
  reminders, overdue, statements, credit notes) are the record and the document. Stripe
  Billing keeps charging cards on its schedule for STRIPE-mode tenants; its webhooks create and
  settle the matching HQ invoice. MANUAL-mode tenants are invoiced by an HQ `RecurringInvoice`
  and pay by transfer, or by card through the portal using HQ's own Stripe Connect payment
  request. `RfInvoice` is dropped once HQ invoices exist.
- `TenantSubscription` remains the entitlement record (plan key, version pin, cycle, period,
  price snapshot, discount, trial dates, dunning state, billing mode). `BillingEvent` remains
  the MRR ledger; `MrrService.computeOverview()` is the only MRR engine.
- Tenant status is derived: trial expiry as today; overdue HQ invoices advance the dunning
  state, and a platform cron applies grace, READ_ONLY, SUSPENDED, and reactivation on payment.
- Lifecycle messages are HQ `MessageTemplate`s and `NotificationRule`s sent through the existing
  `MessagingService.notify(event, {customerId, vars})`, with new `NotificationEvent` members and
  a real email transport bound to the provider, so every tenant's messaging starts delivering.
- Each tenant admin gets a portal login (a `BuyerAccount` linked to the HQ customer) to see
  SaaS invoices and statements, pay, and update a card; the tenant's Settings, Billing page
  deep-links there.
- Admin pages compose two sources explicitly: the platform spine (subscription, entitlements,
  catalog, audit, impersonation) and the HQ customer record (contacts, comments, tags,
  invoices, messages), read by `houseTenantId` from SUPER_ADMIN routes only. Nobody impersonates
  HQ to work; HQ is invisible to every other tenant by ordinary tenant scoping.

## Section 2: Money model

- Billing modes on `TenantSubscription.billingMode`: STRIPE (Stripe subscription and card),
  MANUAL (HQ invoice paid by transfer or by portal card payment), NONE (trial or unbilled).
- One HQ invoice per billing period per tenant. STRIPE: created from Stripe `invoice.finalized`
  (amount, period, lines mirrored) and marked PAID or OVERDUE by `invoice.payment_succeeded` /
  `invoice.payment_failed`; never operator-generated. MANUAL: an HQ `RecurringInvoice`
  (monthly or annual; lines are the plan SKU and add-on SKUs from the catalog snapshot)
  generates the invoice at period start with a due date from the tenant's terms; existing send,
  PDF, reminder and overdue logic apply. Invoice lines are catalog-snapshot lines; if
  `InvoiceItem` requires a product, HQ carries one Product per plan and add-on SKU, synced from
  the catalog on publish (verify in the Phase 1 spec).
- Money truth by role. Entitlement and price: `TenantSubscription`. Cash and documents: HQ
  `Invoice`, `InvoicePayment`, `CreditNote`, statements. MRR: `BillingEvent`, emitted at plan
  change, activation, cancellation, add-on change and credit; every admin money action emits
  one. "Cash collected" from HQ payments is the reconciled view beside MRR.
- One dunning machine. `TenantSubscription.dunningState` (NONE, ATTEMPT_1, ATTEMPT_2,
  ATTEMPT_3, SUSPENDED) plus `dunningNextRetryAt` is the only writer of "how overdue"; the
  existing `failedPaymentCount`, `graceStartedAt`, `graceMeter` lose their writers and are
  dropped later. Stripe attempts and HQ overdue transitions both advance it; escalation emails
  are HQ payment-reminder templates with attempt-specific copy; after the configured grace a
  platform cron moves the tenant READ_ONLY then SUSPENDED and reactivates on payment. The
  machine ships dark for one full billing cycle, producing a named list, before it acts.
- Admin money actions route through one path: plan change through the prorated
  `SubscriptionMutationService` for both modes (Stripe proration or a prorated HQ invoice
  line); add-on enable as an idempotent claim; manual activation must pick a live catalog key,
  pins a version, sets a period and creates the first HQ invoice; MANUAL renewal is the next
  recurring invoice plus a T-14 operator alert.
- Migration: every real tenant gets a subscription row, mode, plan key, pin and price snapshot
  from a signed-off dry-run diff; the two Stripe-billed tenants keep their subscriptions; HQ
  invoices are created forward from cutover plus the current period only. All amounts pass
  through `@routeflow/pricing` rounding.

## Section 3: Lifecycle and messaging

- New `NotificationEvent` members (one migration): TENANT_WELCOME, TRIAL_ENDING, TRIAL_EXPIRED,
  SUBSCRIPTION_STARTED, PLAN_CHANGED, SUBSCRIPTION_CANCELLED, RENEWAL_UPCOMING, PAYMENT_FAILED,
  ACCOUNT_SUSPENDED, ACCOUNT_REACTIVATED, USAGE_NEAR_CAP, CREDIT_ISSUED. INVOICE_SENT and
  PAYMENT_REMINDER are reused for HQ invoices. Each fires from its existing state-change site;
  there is no event bus.
- Transport: an email provider implementing the messaging provider interface and delegating to
  the existing Resend/SMTP `EmailService` is bound for EMAIL. SMS and WhatsApp stay stubbed and
  are shown as "not connected".
- Idempotent, logged sends: `sendOnce(customerId, eventKey, occurrenceKey)` writes a
  `MessageDispatch` row (tenant, customer, event, occurrence, channel, template, recipient,
  status, error, provider id) before sending and on both success and failure. Occurrence keys:
  tenant id; tenant id + day; tenant id + attempt; tenant id + window.
- Recipients: billing-state events go to the tenant's billing contacts; day-7 and day-12 trial
  nudges only to new self-serve signups; admin-initiated plan or price changes send unless the
  admin ticks "do not notify". Templates use the existing editor and preview; HQ ships a seeded
  set.
- Operator alerts: `OperatorAlert` rows feed the admin bell and an email to the addresses in
  `PlatformConfig`: new signup, payment failed from attempt 2, suspension, cancellation, trial
  expiring within 3 days with no card, MANUAL renewal due in 14 days, mirror-sync failure.
  Alerts and tenant sends skip DEMO and TEST tenants.
- Sender and reply path: HQ's verified sending domain through the existing sending-domain card;
  reply-to a support inbox named in `PlatformConfig`. Quiet hours are enforced for
  non-time-critical events only. A per-customer "pause automated messages" switch (EMAIL entry
  in the existing opt-out model) blocks everything except invoices.
- History: the HQ customer's message thread is the send history; the tenant 360 timeline
  merges it with comments, ledger events and admin audit actions.

## Section 4: Admin surface

- Shell: nine nav items (Dashboard, Tenants, Billing, Plans & Catalog, Buyers with Merge
  Requests as a tab, Messaging, Audit & Security, Settings, My Account); a persistent top bar
  with global search (Ctrl/Cmd+K on the existing command palette: tenants, buyers, invoices,
  audit rows) and the alerts bell. Routes stay where they are. Ledger admin tokens (indigo on
  slate, compact).
- Dashboard: MRR (30-day delta), cash collected this month, paying tenants, trials with and
  without card, MRR at risk in dunning, "26 tenants, 18 test"; MRR movements chart from the
  ledger from cutover forward; Needs Attention feed with snooze and dismiss-with-reason
  (failed payments, trials expiring in 3 days without a card, MANUAL renewals due, overdue HQ
  invoices, tasks due today, mirror-sync failures); trials table; structured recent activity.
- Tenants: filters (search, all five statuses, live plans, billing mode, class with TEST hidden
  by default and DEMO badged, tags); columns (name and slug, class, status, plan, MRR, billing
  mode, dunning chip, last active, users, tags, created); row actions View, Suspend with 8s
  undo, Impersonate, more (Extend trial, Change plan); one bulk endpoint with preview drawer
  and per-item results, capped at 25. Create Tenant reads the live catalog, takes billing mode,
  trial override, source, billing contact and notes, offers inline manual activation, and
  creates the HQ mirror customer, contacts and (MANUAL) first invoice in one step.
- Tenant 360, eight tabs. Header: name, class, status with read-only reason in words, plan,
  MRR, billing mode, dunning chip, health chip ("based on N of M signals"), owner, last active;
  actions Impersonate, Suspend/Reactivate, more (Extend trial, Change plan, Reset admin
  password, Delete with typed slug). Tabs: Overview (KPIs with labelled windows, health and
  risk, onboarding milestones strip, usage vs caps, admin account); Timeline (ledger events,
  admin actions, messages with delivery status, comments and calls, tasks; composer Log note /
  Log call / Add task); Contacts (HQ contacts with roles, last active, portal access); Billing
  (subscription record and mode, plan / version / cycle / period / override, dunning state and
  next action, HQ invoices with View / Send reminder / Record payment / Void-to-credit,
  statements, credits, Stripe status; manual activation and plan change forms showing the
  exact dollar effect); Add-ons & Entitlements (toggle cards with history plus the entitlement
  inspector: flags, caps vs live meters, gate state); Tasks; Configuration (branding editable,
  address, terms, timezone); Audit (tenant-scoped, structured-only by default).
- Billing area tabs: Overview, Invoices (all HQ invoices), Dunning queue (Retry, Extend grace,
  Record payment, Contact), MRR movements with churn reasons, Renewals (MANUAL due in 30
  days), Credits & refunds.
- Plans & Catalog: plans table, add-on SKU table, right-rail draft editor (Discard / Publish
  vN, affected-tenants count, unpinned-tenants pre-flight, would-deny counts per gate). The
  in-place price patch leaves the UI; a documented break-glass script remains.
- Messaging: Templates, Rules matrix, Send log. Audit & Security: audit log (structured-only
  default, "all" toggle, billing chip, export), Sessions & Impersonation (parsed devices; start
  and end; "still active" in red), Admin accounts (MFA status, role). Settings: AI (plus
  per-tenant cost table), Billing (grace days, retry schedule, alert recipients, reply-to,
  default trial length), Integrations (Stripe Billing webhook health, HQ Stripe Connect,
  Resend domain, GoHighLevel usage), Maintenance (toggle and message; fails to reads-only),
  Jobs (last run of billing crons and the mirror sync). My Account: password, MFA and
  recovery codes, sessions, alert preferences.
- States: skeleton per section, inline retry per card, specific empty copy, 8-second undo for
  reversible acts, typed confirmation only for delete, void and merge execution.

## Section 5: Data, API, security, testing

Data model deltas (columns first; tables only where nothing fits; every new model in its
domain file and the `MODEL_DOMAIN` map):

| Model | Change |
| --- | --- |
| Tenant | `class` enum PRODUCTION / DEMO / TEST / INTERNAL; `signupSource`; legacy `plan` enum widened in Phase 0, no longer written, dropped in Phase 3 |
| TenantSubscription | `billingMode`, `dunningState`, `dunningNextRetryAt`, `cancellationReason`, `cancellationDetail`; `failedPaymentCount` / `graceStartedAt` / `graceMeter` lose writers, dropped later |
| Customer | `representsTenantId` (unique, nullable) |
| ContactPerson | `role` OWNER / BILLING / DISPATCH / OTHER |
| CustomerTask (new, tenant-side) | title, dueAt, status OPEN / DONE / SNOOZED, kind, assigneeId, customerId |
| MessageDispatch (new) | tenant, customer, eventKey, occurrenceKey (unique with tenant+customer+event), channel, template, recipient, status, error, providerMessageId |
| OperatorAlert (new) | kind, tenantId, detail, createdAt, readAt, snoozedUntil, dismissedReason |
| TenantAddonDenial (new) | tenantId, addonKey, count, lastAt (the would-deny counter) |
| JobRun (new) | jobKey, startedAt, finishedAt, outcome, summary |
| User | `platformRole` SUPER_ADMIN / SUPPORT (platform accounts only), `mfaSecret`, `mfaEnabled`, hashed recovery codes |
| NotificationEvent | twelve lifecycle members |
| PlatformConfig keys | houseTenantId, dunning.graceDays, dunning.retrySchedule, alerts.recipients, mail.replyTo, trial.defaultDays, maintenance.enabled, maintenance.message |
| RfInvoice | dropped once HQ invoices exist |

API deltas: richer tenant list (class, MRR, mode, dunning, last active, `includeTest`);
live-catalog create DTO with mode and inline activation; legal-transition guard on status; one
bulk endpoint with preview; merged timeline; contacts, comments and tasks proxied to the HQ
customer; invoices (list, detail, send reminder, record payment, void); dunning (list, retry,
extend grace); MRR movements; renewals; credits; catalog pre-flight (unpinned tenants,
would-deny report); `POST tenants/:id/impersonate/end`; `auth/admin/mfa/*`; admin accounts;
settings keys; jobs; maintenance. Stripe webhook handlers create and settle HQ invoices and
advance dunning. `POST /public/tenants/register` seeds a subscription and the HQ mirror.

Security: HQ scoped like any tenant; only SUPER_ADMIN routes read it by id. SUPPORT can view,
impersonate, note and task but cannot change billing, publish the catalog or delete. TOTP MFA
with recovery codes and a written break-glass script; impersonation always audits its end and
clears the cookie; OAuth state signed (B349); every money action writes a ledger event and an
audit row.

Testing: unit specs for the mutation service, dunning machine and `sendOnce` written to fail
on the wrong value first; DB-lane specs for mirror sync and the webhook bridge; the
super-admin Playwright suite updated plus new money-path cases (manual activation, plan
change, invoice, dunning); every PR passes the local compose gate (`npm run local:up`,
`local:validate`, `local:e2e` for UI); dunning and classification run dark with a reviewed
report before acting; every backfill ships as a dry-run diff the owner signs off;
post-deploy-check gains an HQ-invoice and one-MRR assertion.

## Roadmap (seven sub-projects, each its own spec and plan)

| Phase | Name | Closes (headline) | Bugs folded in |
| --- | --- | --- | --- |
| 0 | Truth, hygiene, HQ bootstrap | subscription set reconciled, one MRR, tenant classes, legacy plan enum, live catalog in pickers, expired-trial hotfix, one trial length, HQ tenant + mirror sync, device columns | none new |
| 1 | Money writers | HQ invoicing (webhook bridge + recurring), dunning dark then enforced, reminders, prorated admin plan change, add-on idempotency, MANUAL renewals, JobRun, mobile status banner | B327, B342, B107, B329, B58 admin twin |
| 2 | Security | MFA + recovery + break-glass, admin password change, second admin account, impersonation end, signed OAuth state | B173, B349 |
| 3 | Catalog and selling | draft/publish editor, add-on SKU table, pin pre-flight, would-deny counter and blast-radius report, GoHighLevel $9.99 SKU (v12) with 60-day grandfathering, public Starter/Growth prices, Enterprise quote fields, drop legacy plan column | none |
| 4 | Lifecycle messaging and alerts | event members, email transport, sendOnce + MessageDispatch, seeded templates, operator alerts and bell, sender identity, suppression, Messaging page | none |
| 5 | Tenant 360 and daily workflow | merged timeline, contact roles, tasks, tags, health, milestones, attention feed, entitlement inspector, editable branding, bulk with preview, maintenance mode, search and bell shell, structured audit view, SUPPORT role | none |
| 6 | Portal, self-service, governance | portal logins for tenant admins, card update and invoice download, credits and refunds record, export and dry-run erasure, per-tenant AI cost and quota, mobile billing screen | none |

## Owner decisions recorded

1. Trial length 14 days, admin override at creation; in-flight trials keep their end date.
2. Dunning flip: the dark cycle produces a named list; the owner contacts each account before
   enforcement; no account is suspended by an automated email first.
3. Invoices forward from cutover plus the current period; numbering `RF-YYYY-NNNN` from 0001
   unless off-book invoices already exist; no tax line until instructed. Legal entity, address
   and terms to be supplied by the owner before Phase 1 ships.
4. Manual activation must pick a live catalog key, always invoices, always sets a renewal.
5. Public prices for Starter and Growth; Scale and Enterprise quote-based.
6. `routeflow-demo` is class DEMO (visible, excluded from revenue and sends); only a super admin
   changes a class, audited.
7. Billing-state emails reach tenants; nurture only to new self-serve signups; the rest
   operator-only.
8. Admin-initiated plan or price changes email the tenant unless "do not notify" is ticked.
9. MFA in Phase 2. 10. One SUPPORT role in Phase 5; no full RBAC. 11. Credits in Phase 6;
   Stripe plus a note until then. 12. GoHighLevel SKU in Phase 3 with 60 days' notice to dark
   users; enforce after the blast-radius report. 13. No external CRM; HQ house tenant (option A)
   with Stripe Billing kept alongside.

## Risks and mitigations

- Subscription-set reconciliation could corrupt the number it fixes: dry-run diff per tenant,
  owner sign-off, fresh backup, apply against the local stack first.
- The first catalog publish reprices unpinned tenants: pin the whole book as a Phase 0 step and
  make the pre-flight report a hard gate in the editor.
- A repaired suspension cron could correctly cut off a long-unpaid real account: dark cycle,
  named list, owner contact before the flip.
- Twelve new emails to a small book: MessageDispatch dedupe, seeded templates reviewed on the
  local stack, per-customer pause switch, DEMO/TEST excluded.
- Two Stripe integrations (Billing for cards, Connect for portal payments): reconciliation is
  explicit at the HQ invoice (one PAID transition, whichever source pays it); the integrations
  Settings tab shows both healths.
- No staging: new surfaces ship behind existing routes with feature-flagged tabs where a
  half-built tab could mislead; every money writer has a documented reversal (void to credit,
  ledger reversal, break-glass catalog script).
- Bookkeeping: each PR updates the code map and, for folded-in bugs, the lessons register;
  `docs/product/billing-plans.md` is refreshed when Phase 0 lands.

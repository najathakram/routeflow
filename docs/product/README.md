# RouteFlow Product Capability Model

_The canonical map of the problems RouteFlow solves for a wholesale distributor, each one
expanded into must-have, nice-to-have and advanced capabilities with the criteria that would
prove them._

## What this document is

This directory is the product's problem model, not its feature list. Fifteen sibling files each
take one domain of a distribution business — taking the order, pricing it, picking it, driving
it, billing it, collecting it, filing it — and answer four questions in the same shape:

1. What does this business do today without software, and what does that cost them?
2. What are the two or three irreducible use cases inside that problem?
3. What must exist for a tenant to be served at all (P0), what makes it good (P1), and what
   would make it differentiating (P2)?
4. How would we know each of those actually works?

Across the fifteen domains the model currently names **697 capabilities** (207 P0, 305 P1,
185 P2) and **230 gaps**.

**Status labels are a code-grounded audit at a point in time.** Every SHIPPED, PARTIAL, BROKEN
or MISSING verdict in these files was taken by reading the repository at commit **`f932289a`**
(branch `ci/minutes-diet`, audited 2026-08-30). They are not a roadmap and not a promise: a
capability marked SHIPPED means the code path was found and named, and a capability marked
BROKEN means a specific defect was located, not that someone reported a problem. Re-audit the
label before relying on it if the commit has moved.

## How to read it

### Tiers

| Tier                       | Means                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 — Must have**         | The basic service. Without this the domain does not work for any tenant, on any plan. A distributor could not run their week.                                  |
| **P1 — Nice to have**      | The same use cases done well. Speed, fewer steps, fewer surprises, the thing that turns "we can technically do it" into "we do it every day without thinking". |
| **P2 — Advanced / future** | Differentiating or deferred. Includes capabilities that are not built at all — the tier is about ambition, not about readiness.                                |

Tiering is by **importance to the use case**, not by build status. A P0 capability can be
MISSING; that is the most important signal in the model.

### Status legend

| Badge      | Meaning                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------ |
| SHIPPED ✅ | Built, reachable, and doing what the capability says. Carries a code anchor.                     |
| PARTIAL 🟡 | Built for some paths, roles, or surfaces but not all — or built and only half-wired.             |
| MISSING ⬜ | No implementation exists. Not a defect, an absence.                                              |
| BROKEN 🔴  | An implementation exists and produces a wrong result, is unreachable, or contradicts its own UI. |

### The evidence rule

**Every SHIPPED claim carries a code anchor** in its Evidence column — a route, a service
method, a Prisma model, a file path, or a pinned spec. A capability with no anchor cannot be
marked SHIPPED. PARTIAL and BROKEN rows anchor the specific line or branch that fails, so the
verdict can be re-tested rather than re-argued. Where a claim could not be settled by reading
the code, it goes in that file's **What we could not verify** section instead of being softened
into a status.

### Testing criteria

Below each capability table, a `### Testing criteria` block gives one `#### <ID>` heading per
capability that has criteria, each criterion a checklist line ending in its test layer in
backticks: `Jest`, `Playwright`, `manual`, or `CI` (a build-time or pipeline gate rather than a
test run). Unchecked boxes are the norm — these are the criteria, not a coverage report.

## The domain map

Rows follow **the operator's daily loop — intake → catalog and supply → fulfilment → money →
oversight** — not alphabetical order, because that is the order in which a distributor's day
breaks and the order in which a defect in one domain lands on the next.

| Domain                                                         | The problem in one line                                                                                                                  | P0  | P1  | P2  | Doc                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | -------------------------------------- |
| **Order Handling & Order Intake**                              | Orders arrive in five uncoordinated places and are re-keyed into money twice before anyone checks the case-versus-piece split.           | 13  | 19  | 12  | [orders.md](orders.md)                 |
| **Buyer Portal & Customer Self-Service**                       | The retailer cannot order at 11pm, cannot see what they owe, and phones the office for every invoice copy.                               | 13  | 20  | 13  | [buyer-portal.md](buyer-portal.md)     |
| **Customer Management (CRM for wholesale)**                    | The account lives in a phone contact list, a licence photo in WhatsApp, and one rep's memory of the price they promised.                 | 14  | 19  | 12  | [customers.md](customers.md)           |
| **Products, Pricing & Promotions**                             | One catalogue in three incompatible places, a different negotiated price per buyer, and deals honoured only if someone remembers them.   | 13  | 21  | 12  | [catalog.md](catalog.md)               |
| **Inventory & Stock Control**                                  | On-hand exists in a spreadsheet, on the shelf and in the van, and none of the three agree.                                               | 14  | 20  | 12  | [inventory.md](inventory.md)           |
| **Suppliers, Purchasing & Accounts Payable**                   | A shoebox of paper supplier invoices, a monthly statement that never ties out, and cost of goods that is a guess.                        | 13  | 20  | 13  | [purchasing.md](purchasing.md)         |
| **Route Planning, Dispatch & Delivery Execution**              | The delivery day is a whiteboard, a stack of paper and a WhatsApp group, re-keyed at 6pm from the driver's margin notes.                 | 14  | 19  | 12  | [routes.md](routes.md)                 |
| **Drivers & the Driver Mobile App**                            | Nobody knows where the van is, what actually came off it, or how much cash the driver is carrying until they walk back in.               | 13  | 20  | 13  | [drivers.md](drivers.md)               |
| **Invoicing & Getting Paid**                                   | Bills go out late and wrong, payments are applied from memory, and "who owes us what" takes an hour of spreadsheet work.                 | 14  | 20  | 12  | [invoicing.md](invoicing.md)           |
| **Estimates, Credit Notes & Returns**                          | Quotes are forgotten, goods come back into a delivery book, and a credit is a sticky note that can be spent twice.                       | 13  | 18  | 12  | [credit-returns.md](credit-returns.md) |
| **Finance, Bookkeeping & Reporting**                           | Three questions — who owes me, did I make money, what did that pallet cost — each take an evening of re-typing.                          | 16  | 23  | 12  | [finance.md](finance.md)               |
| **Regulated Goods & Compliance**                               | Licences expire in a WhatsApp thread, filings are rebuilt by hand from invoice PDFs, and excise is re-derived differently every time.    | 14  | 20  | 12  | [compliance.md](compliance.md)         |
| **Tenancy, Identity, Roles & Settings**                        | Anyone holding the file can change anything, nothing is attributable, and "how this business works" is written down nowhere.             | 13  | 22  | 13  | [tenancy.md](tenancy.md)               |
| **Plans, Entitlements & Platform Billing**                     | Sold as one monolith, the two-van operator pays for modules they never open and the regional wholesaler hits a wall that needs a deploy. | 14  | 21  | 13  | [billing-plans.md](billing-plans.md)   |
| **Data Onboarding, Import/Export, Documents & Communications** | A whole book of business has to move systems without restarting invoice numbering or losing the paper trail.                             | 16  | 23  | 12  | [data-comms.md](data-comms.md)         |

## Cross-cutting concerns

These are properties every domain must satisfy, not capabilities any single domain owns. Where a
concern is restated per domain, the verdicts already disagree with each other about one shared
mechanism — which is the strongest argument for owning them here instead. Each subsection's
criteria are the acceptance tests for the concern as a whole.

### 1. Tenant isolation

Twelve of fifteen domains carry their own tenant-isolation capability, so fifteen people each
decided independently how confident to be about one mechanism: `PrismaService.forTenant()`.
The verdicts already disagree (Orders SHIPPED, Invoicing PARTIAL, Purchasing BROKEN, Finance
BROKEN). Repeating the claim per domain hides the real question — which routes bypass it — and
at least one bypasses it catastrophically.

- [ ] Every controller method reaches the database through `prisma.forTenant()` or
      `prisma.tenantTransaction()`; a bare `this.prisma.<model>` write fails the build against an
      explicit reviewed allowlist (which today would have to name `settings.controller.ts` and
      `bookkeeping/invoice.service.ts:86`) `CI`
- [ ] Given two seeded approved test tenants each holding one invoice, every GET/PATCH/DELETE
      route called with tenant A's token and tenant B's resource id returns 403 or 404 **and**
      tenant B's row count is unchanged — asserted by row census, never by response body `Jest`
- [ ] An operator token in one test tenant calling `DELETE /api/v1/settings/financial-data`
      leaves the other test tenant's invoice, invoicePayment and vendorBill counts unchanged
      (fails today) `Jest`
- [ ] For every model whose `tenantId` is nullable (DeliveryMutation, DeliveryBatch, Transaction,
      Payment, StockLot, StockMovement, InboundTriage), no row is ever created with `tenantId`
      null — nested creates through a parent are the known leak `Jest`
- [ ] A JWT whose `tenantId` is edited to another tenant's id yields 403/404 on every read route
      and no foreign row in any body `Jest`

### 2. Money rounding and boxed-quantity discipline

`CLAUDE.md` already states the rule — all line, tax and total math through `computeLineSubtotal`,
`normalizeBoxesPieces` and `roundMoney`, never re-derive `qty * unitPrice` for a boxed line — yet
six domains restate it with independent verdicts. Money correctness cannot be PARTIAL in one
domain and SHIPPED in another when all six call the same three functions in
`apps/{api/src/common,web/lib,mobile/lib}/pricing.ts`.

- [ ] A CI check diffs the three `pricing.ts` mirrors and fails on any drift in exported function
      bodies — today this is maintained by convention and code review only `CI`
- [ ] Property test over a generated grid of (unitsPerBox, boxes, pieces, unitPrice):
      `computeLineSubtotal` equals `roundMoney` of the boxed-prorated value and never equals
      `qty * unitPrice` unless `unitsPerBox` is 1 — run in all three workspaces against their own
      mirror `Jest`
- [ ] An order with one boxed line of 3 boxes + 4 pieces at `unitsPerBox` 12, invoiced, split into
      sibling invoices, partly credited, partly returned and restocked, reconciles to the cent
      against the original — one round-trip invariant, not four assertions `Jest`
- [ ] Every write path persisting a Decimal money column passes through `roundMoney`; the money
      entries in the 165-entry `scan-ignore.json` baseline (3 under `money-rederive`) get a
      burn-down target rather than
      indefinite tolerance `CI`
- [ ] After a feature-smoke run, no `Decimal(10,2)` column holds a value with more than two
      decimal places `Jest`

### 3. Destructive operations and data-loss guardrails

Distinct from permissions: the danger is not who may call the route but what the route does once
called. Bulk deletes, financial-data wipes, void-with-reversal, count amendment, credit un-apply,
import rollback and tenant wipe are scattered across six domains. The repo already owns the right
pattern — dry-run default, `--execute`, `--live-tenant-override`, type-back confirmation, as used
by `scripts/lib/test-tenants.cjs` — it simply is not applied to HTTP routes.

- [ ] Every handler that can delete or reverse more than one row has (a) a preview/dry-run
      response shape, (b) a confirmation token echoing a count or typed value, and (c) an
      AuditLog entry naming actor, scope and affected row counts. `DELETE /api/v1/customers/all`
      and `DELETE /api/v1/settings/financial-data` fail all three today `CI`
- [ ] A confirm call carrying a stale count from a prior preview is refused — proving the operator
      confirmed what they were actually shown `Jest`
- [ ] For any destructive route, a second tenant's row census is unchanged before and after `Jest`
- [ ] A customer with a PAID invoice deleted through any route, including bulk paths, leaves the
      invoice, its payments and its credit notes intact and still in the receivables report `Jest`

### 4. Audit trail and attribution

Six domains assume an audit trail and rate it anywhere from SHIPPED to MISSING. One fact settles
all six: `AuditLog` and `AuditInterceptor` exist, and the interceptor is wired only into
`apps/api/src/platform-admin/`. Tenant staff actions are entirely unattributed. Configuration is
worse than records: `SystemConfig` carries `updatedAt`, no actor and no history, so "who changed
the tax rate, when, and what was it before" is unanswerable — and that question arrives after a
customer disputes an invoice.

- [ ] The audited action set is defined once (money writes, deletions, price and tier changes,
      entitlement and role changes, licence overrides, impersonation start/stop) and every
      controller method in that set is covered by the interceptor or an explicit service-level
      audit write `CI`
- [ ] An operator editing an order line produces an AuditLog row carrying tenantId, actor, action,
      entity type, entity id, before and after values, and no exposed route can delete it `Jest`
- [ ] A forced audit-write failure still commits the business write and logs at error level — so
      auditing can never become an outage `Jest`
- [ ] Any settings write records actor, key, old value, new value and timestamp, and the old value
      is retrievable for any past date `Jest`
- [ ] Secrets never appear in the audit trail: writing `email.smtpPassword` or `anthropic.apiKey`
      records the fact of the change and not the value `Jest`
- [ ] A product price change is answerable as "the price in effect on that date" without inferring
      it from invoice lines `Jest`
- [ ] Writes made during a support impersonation session name both the impersonated user and the
      RouteFlow staff member, and the session has a recorded start, scope and expiry `Jest`

### 5. Roles, permissions and entitlement gating

Four independent gate families (`@Roles`, `@RequirePlanFlag`, `@RequireAddon`, buyer scoping) are
applied per controller while every domain restates role authority as its own capability. The
observed failure mode is not a missing check but an **ungrantable** one — a gate keyed on a value
nothing can write, 403-ing a shipped feature for every tenant. Separately, `UserRole` is a
five-value enum, so "can void an invoice", "can change a price", "can see cost" and "can take a
payment" are one role today; tenants over-grant, which multiplies the blast radius of §3.

- [ ] Grant-path completeness: every key passed to `@RequireAddon` or `@RequirePlanFlag` exists in
      `plan-catalog.constants.ts` **and** is writable by at least one of the platform-admin
      `AVAILABLE_ADDONS` list, a SKU activation path, or a plan definition. A key with no writer
      fails the build `CI`
- [ ] Deploy-day regression: a tenant that used a feature before a new gate existed still passes
      that gate, pinned by a fixture of existing entitlement sets `Jest`
- [ ] A generated role × mutating-route table asserts the expected allow/deny, so adding a route
      without a role decision fails the table's completeness check `Jest`
- [ ] For every surface hidden behind a composed access hook (`useRoutesAccess`,
      `useDeliveryAccess`), the corresponding endpoint 403s independently —
      `dispatch-addon-gate.spec.ts` is the pattern to generalise `Jest`
- [ ] Every money-mutating route declares a required permission, not just a role; a route with no
      declaration fails the build `CI`
- [ ] A user granted "record payment" but not "void invoice" gets a 403 with a permission-shaped
      body and no partial state on an attempted void `Jest`
- [ ] A role change that removes a permission takes effect within the entitlement cache TTL on an
      already-issued token `Jest`

### 6. Offline durability and idempotent replay

Five domains claim offline capability with verdicts from SHIPPED to MISSING, but there is one
queue to build and one replay contract to honour. Today `apps/mobile/lib` contains only
`pending-cache.ts` (a read cache) and `pending-scroll.ts` (a scroll helper), and `IdempotencyKey`
is referenced in exactly one API file — so the only safe-to-replay path is the one that moves the
least money.

- [ ] Offline, a driver completing a stop, recording an at-door payment, filing a return and
      taking a new order persists all four locally and survives a hard process kill and relaunch —
      not a backgrounding `manual`
- [ ] Replay with every request duplicated exactly once creates no duplicate InvoicePayment,
      Return, Order or StockMovement row, with the **server** rejecting on an idempotency key
      rather than the client de-duplicating `Jest`
- [ ] A queued write that conflicts with an office change made while offline (the order was
      cancelled) surfaces a structured conflict — never silently dropped, never silently
      applied `Jest`
- [ ] A queued write that can never succeed moves to a visible dead-letter state after a bounded
      number of attempts instead of retrying forever `Jest`
- [ ] Every money-mutating endpoint accepts and honours an `Idempotency-Key` header; any that
      ignores it fails the check `CI`

### 7. Time: one business day, one timezone

`TenantConfig.timezone` is honoured for invoice issue dates and almost nowhere else. Analytics,
AR aging, regulated period bucketing (`apps/api/src/regulated/period.ts` is explicitly UTC) and
cash flow all use UTC, while quiet hours use a **second** timezone on `MessagingSettings`. On-time
delivery is measured against the end of the scheduled UTC day. For a tenant west of UTC, yesterday's
sales, the aging boundary and the filing period disagree with the till and with each other — and
most at month end, which is when someone checks.

- [ ] Every date-bucketing decision (analytics ranges, on-time measurement, regulated filing
      periods, cash-basis `settledAt`, statement months) is computed against one explicit tenant
      timezone, asserted with a fixture tenant in a non-UTC zone whose late-evening order falls on
      a different local day `Jest`
- [ ] An invoice created at 22:00 local on the last day of a month lands in the same month on the
      finance dashboard, the AR aging bucket, the regulated filing period and the P&L `Jest`
- [ ] A daily report spanning a DST transition covers 23 or 25 hours as appropriate and no order
      is counted twice or dropped `Jest`
- [ ] Exactly one timezone source of truth: a test fails if `MessagingSettings.timezone` can
      diverge from `TenantConfig.timezone` `Jest`

### 8. Localisation, currency and language

Timezone above is correctness; this is presentation and reach. `TenantConfig.currency` defaults
USD with no writer, `stripe-payment-provider.ts` throws on anything but USD, `apps/web` hard-codes
`en-US` in its formatters, and the shipped user guide advertises a Language article against a
codebase with no i18n framework at all. The driver app is used one-handed outdoors, often by
someone whose first language is not English.

- [ ] No date or money is formatted with a hard-coded locale: a lint rule bans literal locale
      arguments to `toLocaleDateString`/`toLocaleString` outside one formatting module
      (`settings/page.tsx:784` fails today) `CI`
- [ ] For a tenant configured in a non-USD currency, symbol, decimal places and rounding are
      consistent across invoice PDF, statement PDF, buyer portal and mobile — or currency is
      asserted to be a single tenant-level constant defined in exactly one place `Jest`
- [ ] If a Language setting ships, every string on the three highest-traffic screens resolves from
      a catalogue and a missing key fails the build rather than rendering the key `CI`
- [ ] With the OS language set to Spanish, the driver stop card, delivery actions and error
      messages are all translated — no mixed-language screens `manual`

### 9. Notification delivery, consent and a verifiable send log

Every domain that says "we tell the customer" — invoice sent, order confirmed, back-in-stock,
delivery ETA, licence expiring, payment reminder — depends on one transport whose only
implementation is `apps/api/src/messaging/providers/stub.provider.ts`, which makes no network
call, never throws, and returns a synthetic id. Consent (`MessageOptOut`), quiet hours
(`MessagingSettings`) and a send log are trust and legal obligations that cannot be re-decided per
domain. WhatsApp/SMS sends also increment the billable MSGS meter for messages that never left the
server.

- [ ] While the outbound provider is the stub, no surface tells the user a message was delivered —
      the displayed status is queued or simulated, never sent (fails today) `Jest`
- [ ] A customer opted out of a channel receives nothing from **any** triggering domain and the
      suppression is recorded with a reason — asserted per triggering domain `Jest`
- [ ] A notification triggered inside quiet hours (evaluated in the tenant's timezone) is deferred
      to the next allowed window, and any urgent exemption is explicitly listed `Jest`
- [ ] Every send attempt produces a durable record carrying tenant, recipient, channel, template,
      provider message id and terminal status, readable from the customer's record `Jest`
- [ ] Meter increments happen only behind confirmed provider acceptance, so a stub or a failure
      meters nothing `Jest`

### 10. Search and findability

"Find the thing" is claimed once, per entity, and marked BROKEN there. Cross-entity search does
not exist: `apps/web/components/CommandPalette.tsx` holds only navigation and `act-*` commands and
never queries a record. For a business replacing a paper delivery book, looking something up by a
fragment of a name, a phone number, an order number or an amount is the most common action of the
day.

- [ ] A fragment matching a customer, a product, an order number and an invoice number returns
      grouped, tenant-scoped results from all four entity types `Playwright`
- [ ] Search matches the identifiers people actually quote: order number, invoice number, the
      supplier's own invoice number, tracking number, customer phone and address fragment `Jest`
- [ ] Search respects role and entitlement: a driver's search never returns finance records, and a
      surface hidden by a disabled addon never appears in results `Jest`
- [ ] Search latency at seeded realistic scale stays inside the list-endpoint p95 budget, and a
      no-match query renders a distinguishable empty state `Playwright`

### 11. Data export and portability

Nine capabilities across five domains each hedge on export independently. Actual coverage is three
screens with a `text/csv` download (invoices, orders, platform-admin billing) plus customers,
payments and regulated reports on the API. "How do I get my data out if this doesn't work" is a
procurement question and a contractual one, not a per-list nicety — and unanswered it makes the
migration hub feel like a trap.

- [ ] Every list surface with filters exports exactly the filtered, sorted result: a filter
      yielding 3 of 500 rows produces a file with 3 data rows `Playwright`
- [ ] Exported money and quantity values match the screen to the cent and to the decimal for boxed
      lines — no re-derivation in the export path `Jest`
- [ ] A whole-workspace export exists and completes at realistic volume, covering customers,
      products, orders, invoices, payments, credit notes, returns, bills, expenses and stock
      movements, with stable ids that let the sets be re-joined `Jest`
- [ ] Export respects tenant scope and role: a user cannot export data they cannot read on screen,
      and no export contains another tenant's rows `Jest`

### 12. Performance and correctness at realistic scale

No domain owns "still works with 20,000 customers and 500,000 invoice lines". Entitlements are
cached for 30 seconds; settings are not — `SystemConfigService.get` does a `findFirst` per key and
`getInvoiceSettings` issues four sequential queries, on a path invoice creation runs every time.
The `limit: 0` fetch-all sentinel means tightening a list DTO silently changes caller behaviour,
and the dashboard fans out across sixteen analytics endpoints.

- [ ] A seeded approved test tenant at realistic scale (10k customers, 50k orders, 200k invoice
      lines) meets a p95 latency budget per list and per dashboard endpoint, with the budget
      written down in the repo as a number `Jest`
- [ ] No list endpoint returns an unbounded set by default: every list DTO has a maximum limit, and
      every caller passing the `limit: 0` sentinel is enumerated and pinned `CI`
- [ ] Query counts are asserted (no N+1) for the dashboard fan-out and the customer list's live
      money columns, and creating an invoice issues no more than N configuration round-trips, with
      N not growing as settings are added `Jest`
- [ ] Pagination is stable under concurrent writes: paging 1..N while rows are inserted repeats no
      row and skips none `Jest`
- [ ] A settings change invalidates the cached value within the declared TTL, for that tenant
      only `Jest`

### 13. Accessibility

Not one domain mentions it and the repo has no tooling to check it: no axe-core, no jest-axe, no
eslint-plugin-jsx-a11y, and no component tests in `apps/web` at all. The operator dashboard is a
dense keyboard-heavy all-day tool and the buyer portal is public-facing — both are exactly where
keyboard traps, unlabelled icon buttons and colour-only status carry real cost.

- [ ] An automated axe scan across every top-level route (dashboard, buyer portal, marketing,
      platform admin) reports zero serious or critical violations, wired into the existing
      Playwright run `Playwright`
- [ ] No button, link or input in the rendered accessibility tree has an empty name — icon-only
      buttons are the expected failure class `Playwright`
- [ ] Keyboard-only completion of create-an-order, record-a-payment and place-a-buyer-order with no
      pointer events, including every modal and the command palette without a trap `Playwright`
- [ ] No status is conveyed by colour alone: every status rendering pairs colour with text or an
      icon, asserted on the status cell's text content `Playwright`
- [ ] Every driver-app touch target meets the platform minimum and every screen renders at the
      largest OS font scale without truncating money or quantity values `manual`

### 14. Mobile ↔ web parity

`CLAUDE.md` makes web the golden reference and requires mobile to reuse the same endpoints, DTOs
and flows, yet roughly fourteen capabilities across the model are PARTIAL specifically because
mobile lags. Parity is asserted per domain and verified nowhere: `apps/mobile` has pure-logic Jest
tests only, so a mobile screen calling a stale endpoint shape fails first in a user's hands.

- [ ] Every endpoint path and payload shape used by `apps/mobile/lib/api/*` is asserted against the
      same source of truth as `apps/web/lib/api/*`, so an API change breaks both or neither `Jest`
- [ ] Byte-identical mirrors are enforced rather than trusted: a CI diff over `pricing.ts` across
      api/web/mobile and `packages/types/trip-grouping.ts` against `apps/mobile/lib/trip-grouping.ts`
      fails on drift `CI`
- [ ] A per-capability parity register: a capability marked SHIPPED for mobile has a named mobile
      test, not only a web one `CI`
- [ ] Gating parity: with an addon off, both surfaces hide it and both receive the same server
      403 — the two platforms' composed access hooks produce the same decision for the same
      entitlement set `Jest`

## Per-tenant variation: can the current machinery carry 10–100 variations?

**Verdict: no — not as variation. The machinery is sufficient to SELL modules and insufficient to
VARY behaviour, and left as-is it will force per-tenant forks or "just build it for everyone".**

### What exists today

| Mechanism           | Shape                                                                                                                                                                                                                                                             | What it can express                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Plan keys           | 4 (`STARTER`, `GROWTH`, `SCALE`, `ENTERPRISE`)                                                                                                                                                                                                                    | Which tier a tenant is on                                                  |
| Feature flags       | 16 `FLAG_KEYS` in `apps/api/src/billing/plan-catalog.constants.ts`                                                                                                                                                                                                | Whether a module is visible/reachable                                      |
| Addon SKUs          | 10 `ADDON_SKUS`, plus a parallel free-text `TenantAddon.addonKey` namespace declared in `packages/types`                                                                                                                                                          | À-la-carte module purchase, plus platform-admin-only keys                  |
| Meters              | 5 `METER_KEYS` (customers, seats, routes, scans, msgs)                                                                                                                                                                                                            | Capacity, of which only CUSTOMERS is actually enforced                     |
| `TenantConfig`      | ~25 **fixed columns** (branding, address, smtp, timezone, currency)                                                                                                                                                                                               | Identity and mail — a new tenant-level toggle needs a **Prisma migration** |
| `SystemConfig`      | Per-tenant key/value, ~15 keys actually read, in a handful of namespaces: `anthropic.*`, `email.*`, `zoho.*`, `remittance.config`, plus the route / invoice / margin / pricing-tier-label settings exposed by `apps/api/src/system-config/settings.controller.ts` | Free-text values read through bespoke hand-written getters                 |
| `NumberingSequence` | 4 document types                                                                                                                                                                                                                                                  | Configured but **not honoured** by live invoice minting                    |

Call it roughly **70 knobs against 697 capabilities** — well under one knob per ten capabilities.

### Why the count is not the real problem

Every one of those knobs answers _"does this tenant SEE this module"_. None answers _"how does
this capability BEHAVE for this tenant"_. The variations distributors actually ask for are
behavioural, and not one of them is expressible today:

- does a driver's edit at the door replace the order or amend it?
- does a return restock at sale-time cost or today's average cost?
- does a short delivery auto-credit or wait for review?
- is a credit above $X approved by a second person?
- does the invoice show cost, MSRP, both, or neither?
- is tax charged on shipping? is the business day boundary 5am or midnight?
- does an order above $X need sign-off?

The enforcement picture is also thinner than the catalog implies: seven flags sit in
`DARK_PLAN_FLAGS` and are muted by the global `PLAN_FLAG_ENFORCEMENT` env switch (default `off`),
`flag.api_sso` and `flag.settlement` are documented as RESERVED with nothing to gate,
`flag.dispatch_live` is deliberately unenforced, and only 2 of 10 SKUs are self-service. Roughly
six flags actually enforce anything today. `PLAN_FLAG_ENFORCEMENT` is also **global, not
per-tenant**, so a pilot tenant cannot be opted in or out individually.

Adding one variation is a code change in at least three places — the key constant in
`packages/types`, the hardcoded `AVAILABLE_ADDONS` array in
`apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`, and a decorator on a controller —
plus a deploy. That does not scale to 10–100 variations, and the pressure resolves one of two bad
ways: per-tenant branches, or shipping everything to everyone, which makes the product heavier for
the two-van operator it is being sold to.

### Recommended direction

Add a **typed, versioned, defaulted policy layer beside the entitlement layer** — not more flags.
Entitlements answer _may this tenant have it_; policy answers _how does it behave_. Concretely: a
registry of named settings, each with a type, a default, an allowed scope (tenant / customer /
category / role), validation, history and an admin UI generated from the registry. `SystemConfig`
is the right storage with the wrong contract: free-text key/value, no registry, no defaults table,
no validation outside per-endpoint DTOs, no history, no scoping, and no cache — contrast
`EntitlementsService`, which caches for 30 seconds. Resolution order (tenant default → category →
customer) should be implemented once and covered by a table-driven test, rather than the current
split where `defaultPaymentTerms` is per-customer and the margin floor is per-category through two
unrelated mechanisms.

### The durable lesson

**An entitlement gate with no UI that can GRANT it is a self-inflicted outage.** This has already
happened in production: `@RequireAddon("ocr")` keyed on an addon nothing could create — no admin
toggle, and SKU activation writing a different key — 403-ing four scan endpoints for every tenant.
The same shape is live again in the catalog: `LEGACY_ADDON_KEY_TO_SKU` bridges `"ocr"` to
`OCR_PACK_250`, which `publish-plan-catalog-v11.ts` deliberately retired. Before any new
`@RequireAddon` or `@RequirePlanFlag`, three questions must be answered: **which UI grants it, does
SKU/plan activation write THAT key, and what happens to existing users on deploy day?** The
grant-path completeness check in cross-cutting §5 is the standing form of this lesson.

### Variation criteria

- [ ] Every key in `FLAG_KEYS` and `ADDON_SKUS` has at least one path that grants it (a plan
      definition `featureFlags` entry, an `AddonSku.grantsFlags` entry, or a platform-admin toggle);
      a key with no grant path fails the build `CI`
- [ ] A fresh tenant on each of the four plans with no addons yields a non-403 route set exactly
      equal to a checked-in per-plan snapshot, so a new controller cannot silently join or leave a
      tier `Jest`
- [ ] Every setting read at runtime resolves through one registry lookup with a declared default; a
      service reading `SystemConfig` by a string literal absent from the registry fails the
      build `CI`
- [ ] Two tenants, one setting a behavioural policy (costing method, margin floor) and one on
      defaults, price the same order differently in exactly the intended way, and neither read
      observes the other's value `Jest`
- [ ] A policy that must vary by customer and by category resolves tenant → category → customer in
      one implementation, covered by a table-driven test `Jest`
- [ ] A `PLAN_GATE` 403 carrying `INLINE_RESOLVE` leads to a purchasable addon that unlocks the
      surface within the entitlement cache TTL — the upsell loop verified end to end `Playwright`

## Coverage gaps in this model itself

The fifteen domains were chosen from the operator's daily loop. Two independent critics — a
completeness critic and a product-strategy critic — read the model against the repository and the
user guide. What follows is what they found the model does not cover.

### Domains this model does not have

| Proposed domain                                                             | Why it is a gap                                                                                                                                                                                                                                                                                                     | Evidence                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Warehouse Operations — picking, packing & load verification**             | The hour between "order confirmed" and "box on the truck" is unowned. Inventory knows totals, Routes starts at the manifest; nobody owns picking, the picker's role, or verification that what was picked equals what was ordered — where short-picks are born.                                                     | `apps/mobile/app/(operator)/(tabs)/warehouse.tsx`, `(tenant)/warehouse.tsx`, and `(operator)/pick.tsx` (a hard-coded empty state whose own comment says no `/routes/:id/picks` endpoint exists). No Warehouse/Location/Bin/Pick/Wave model in `schema.prisma`. Guide Chapter 08 has two articles on it. |
| **Notifications, Messaging & Realtime**                                     | Four API modules, eight Prisma models and three user-visible surfaces implement "tell someone something happened", scattered as one-liners across five domains. Nobody owns the delivery guarantee, consent, the send log, or the fact that the transport is a stub. Consent and quiet hours are legal obligations. | `apps/api/src/{messaging,messages,notifications}/`, `gateways/routeflow.gateway.ts`; models Message, MessageThread, MessageTemplate, NotificationRule, MessageOptOut, MessagingSettings, InboundTriage, DeviceToken.                                                                                    |
| **Delivery Transparency & Outbound Customer Communications**                | The rules engine, templates, consent flags and quiet hours are built and the message goes nowhere; meanwhile the buyer who wants to know when the van arrives has no link they can open without logging in. The most demo-able delivery feature in the category, currently domain-less.                             | `messaging/providers/stub.provider.ts` is the only `MessageProvider`; no public or tokenized tracking route exists.                                                                                                                                                                                     |
| **The Daily Operating Picture (dashboard home / today view)**               | The first screen every operator opens belongs to no domain, and composition surfaces have their own failure modes: a KPI that disagrees with the list it links to, a card empty because an addon is off rather than because there is no work.                                                                       | `apps/web/app/(dashboard)/dashboard/page.tsx` and `apps/mobile/app/(operator)/(tabs)/home.tsx` (~30 KB of composed KPI and queue logic). Guide Chapter 02.                                                                                                                                              |
| **Platform Administration & Vendor Back-Office**                            | One line in the billing domain covers a whole application with its own auth, audit log, buyer identity arbitration and vendor invoice ledger. Impersonation and cross-tenant buyer merges are the highest-blast-radius operations in the product with no tiering, criteria or owner.                                | `apps/web/app/(platform-admin)/admin/*`; `apps/api/src/platform-admin/` is the only consumer of `AuditInterceptor`; models AuditLog, PlatformConfig, BuyerMergeRequest, RfInvoice.                                                                                                                      |
| **Tenant Health & Vendor Support Operations**                               | Nothing answers which tenant is stuck right now, what gate blocked whom, which import half-landed, or what support changed on their behalf. For a vendor selling fifteen domains to non-technical distributors, support load is the real cost of goods and it is invisible.                                         | `AuditLog` exists with no health/gate-denial/support surface built on it; `PlanFlagGuard` throws a structured `PLAN_GATE` 403 that nothing records.                                                                                                                                                     |
| **Fleet, Vehicles & Cost-to-Serve**                                         | RouteFlow plans stops with no concept of the thing that carries them: will it fit the small van, what did the run cost, which vehicle is off the road, is the driver's licence valid. Cost-to-serve is also the argument for raising a customer's minimum order.                                                    | No Vehicle/Asset/Maintenance/Odometer model; Product has no weight/volume/dimensions. Vehicle-shaped capabilities are scattered as orphan bullets across Routes and Drivers.                                                                                                                            |
| **Integration Platform (public API, webhooks, accounting connectors, EDI)** | Integration appears only as the tail of onboarding, framed as one-way migration. It is a permanent bidirectional obligation — the bookkeeper's package every month, a chain customer's EDI every week, the tenant's own scripts.                                                                                    | No ApiKey/Webhook/WebhookDelivery/OAuthConnection model; only `ImportExternalRef` plus loose Zoho `SystemConfig` keys; `flag.api_sso` is declared and documented as RESERVED.                                                                                                                           |

### Capabilities missing from the domains we did map

Tier is the critics' own (MUST / NICE / ADVANCED). None of these appear as capability rows in the
fifteen files.

| Domain           | Proposed capability                                                                        | Tier | Why                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders           | Ship-to / bill-to snapshotted onto the order and invoice                                   | MUST | A customer moving shop silently rewrites every invoice ever issued to them; `Order` has no `shipToAddressId`.                                      |
| Orders           | Customer PO / reference number on an operator-keyed order                                  | MUST | Any multi-store retailer rejects an invoice without their PO number; the field exists only in the buyer-portal thinking.                           |
| Orders           | One document-numbering mechanism shared by every document type                             | MUST | `NumberingSequence` and a separate `PaymentCounter` are two counters, i.e. two ways to collide; owner should be Tenancy/Settings.                  |
| Orders           | Promised delivery date validated against route day, cutoff and calendar                    | NICE | `requestedDeliveryDate` is free-form; a promise is made that dispatch cannot keep.                                                                 |
| Buyer portal     | Transactional email to the buyer (confirmation, receipt, statement)                        | MUST | Self-service where placing an order produces no confirmation sends the buyer back to the phone.                                                    |
| Buyer portal     | Global cross-entity search                                                                 | NICE | `CommandPalette.tsx` never queries a record; an operator with only a shop name has to guess the list.                                              |
| Buyer portal     | Downloadable buyer app the seller can point a retailer at                                  | NICE | The store submission profile is a stub, so the answer is a browser bookmark.                                                                       |
| Customers        | Confirmation and financial-history guard on `DELETE /customers/all`                        | MUST | Cascades into transaction and payment `deleteMany` with no confirmation, no dry run, no paid-document check — and it is wired into the UI.         |
| Customers        | Agreed price list per customer with an effective date and a printable copy                 | NICE | `CustomerPrice` is mutable with no history, so "you promised me $28" cannot be settled.                                                            |
| Customers        | Per-contact reachability and channel preference                                            | NICE | Consent lives on Customer, not ContactPerson; the owner takes order calls and the bookkeeper takes invoices.                                       |
| Customers        | Days-to-pay / payment-behaviour signal shown where the order is taken                      | NICE | The data exists in payment dates and is never rolled up, so the credit judgement stays in one person's head.                                       |
| Catalog          | Multi-level pack hierarchy (piece / inner pack / case / pallet)                            | NICE | One `unitsPerBox` column; real cases contain sleeves that buyers order.                                                                            |
| Catalog          | Preferred supplier, last purchase cost and lead time on the product                        | NICE | None of the three is on Product, so reorder decisions leave the app and PO drafting has nothing to draft from.                                     |
| Catalog          | Price-change history and effective-dated future prices                                     | NICE | Price columns are overwritten in place; a disputed invoice cannot be defended from the catalogue.                                                  |
| Inventory        | Reconcile the three stock-deduction writers into one stated invariant                      | MUST | Orders decrement, the driver path writes compensating movements, and nothing states what on-hand should be at any instant.                         |
| Inventory        | Required reason codes on adjustments, and a SALE movement per sale                         | MUST | Reasons are optional and sales write no movement, so the ledger has a hole exactly where the shrinkage argument happens.                           |
| Inventory        | Decide what `StockLot` is for — real lot tracking or dead schema                           | NICE | The model exists with the shape a FIFO layer needs; either costing ignores it or it is maintenance debt.                                           |
| Inventory        | Cycle counting on a schedule, with ABC classes                                             | NICE | The resumable count is the Sunday-with-a-clipboard exercise; what keeps stock honest is counting fast movers weekly.                               |
| Inventory        | Expiry / short-dated stock visibility                                                      | NICE | `StockLot` has purchase date and cost but no expiry, so "what is about to go out of code" is unanswerable.                                         |
| Purchasing       | AP aging — what you owe, by age, per supplier                                              | MUST | The mirror of AR aging, which is shipped. A read model over data already held.                                                                     |
| Purchasing       | Dock-side receiving on a phone against the PO or bill                                      | MUST | Receiving is an office action, so counting happens on paper and is keyed later — the delay the product exists to remove.                           |
| Routes           | Carry-over queue for stops not delivered today                                             | MUST | The domain's own problem statement says missed orders quietly fall off the schedule; there is no standing undelivered queue.                       |
| Routes           | Reopen-stop guard that can see at-door payments                                            | MUST | The guard queries the dead `Transaction` ledger, so it always passes and a stop with cash collected can be reopened.                               |
| Routes           | Printable run sheet and paper POD fallback                                                 | NICE | Phones die; every process this replaces is paper, and the demo question is always "what if the phone dies".                                        |
| Routes           | On-time measurement against a promised window                                              | NICE | `arrivedAt`/`completedAt` and the customer's delivery window both exist and are never compared.                                                    |
| Drivers          | A durable offline write queue that survives an app restart                                 | MUST | Only a read cache and a scroll helper exist, on the surface most likely to lose signal and most likely to be holding cash.                         |
| Drivers          | Read-only day cache so the manifest survives a dead zone                                   | MUST | Writes queue but the driver cannot even see the next stop's address without signal.                                                                |
| Drivers          | Opening cash float and end-of-run variance                                                 | NICE | Settlement without a declared float counts only what the driver says they collected.                                                               |
| Invoicing        | Idempotency implemented once, on the endpoints that move money                             | MUST | `IdempotencyKey` is referenced in one file; recording a payment, issuing a credit and applying a statement are all unsafe to replay.               |
| Invoicing        | Batch send — the whole day's invoice run in one action                                     | MUST | Sending one at a time is why invoices go out three days late, which is why cash arrives three days late.                                           |
| Invoicing        | Unapplied-cash view with an age                                                            | MUST | `AdvancePayment` exists; no report answers "what money is sitting unallocated and how old is it".                                                  |
| Invoicing        | Tax treatment snapshotted per line (rate, jurisdiction, exemption reason)                  | MUST | Tax is one tenant-wide scalar read at render time, so history re-prices and an audit has no basis to inspect.                                      |
| Credit & returns | Customer-facing documents: quote PDF, credit note PDF, delivery note, return receipt       | MUST | Four PDF templates exist and none of them is these; a quote you cannot send is not a quote.                                                        |
| Credit & returns | Automatic credit proposal from a short delivery                                            | MUST | The delivered-vs-ordered variance is the seam between Drivers and Credit and neither owns it.                                                      |
| Finance          | Retire the shadow ledger (`Transaction` / `TransactionItem` / `Payment`)                   | MUST | Nothing creates these rows any more and four services still read, update and delete from them, so every read is guaranteed empty.                  |
| Finance          | Reporting day boundaries in the tenant's timezone                                          | MUST | Honoured for invoice issue dates only; analytics, aging, regulated periods and cash flow are UTC.                                                  |
| Finance          | Journal-shaped export the bookkeeper's package can ingest                                  | MUST | A dated, account-coded, balanced CSV removes the largest re-keying task in the business — much smaller than a full ledger.                         |
| Finance          | One export policy instead of nine per-domain guesses                                       | NICE | Coverage is three screens; customers, products, inventory, movements, expenses, payments, returns, credits and estimates have none.                |
| Finance          | Owner's Monday digest — one scheduled summary                                              | NICE | The owner's three questions are answerable only by someone who logs in and clicks.                                                                 |
| Compliance       | Attach, retain and read back the licence document itself                                   | MUST | Blocking the unlicensed sale rests on a record with no evidence behind it; the upload machinery already exists.                                    |
| Compliance       | Manufacturer-format (MSA-style) reporting alongside the state templates                    | MUST | The template registry covers state jurisdictions only, so for the sharpest segment the story stops one filing short.                               |
| Compliance       | Purchase-side excise capture                                                               | MUST | The levy is computed at sale time only, so the two sides of the regulated ledger can never be tied out.                                            |
| Tenancy          | Contain the blast radius of `DELETE /api/v1/settings/financial-data`                       | MUST | Ten unscoped `deleteMany({})` calls behind a plain operator role, registered at two paths, reaching every tenant's finances.                       |
| Tenancy          | A tenant-side audit trail                                                                  | MUST | `AuditInterceptor` is wired only into platform-admin; nothing a tenant's own staff does is recorded anywhere.                                      |
| Tenancy          | Two-factor authentication for admin and finance accounts                                   | MUST | No TOTP implementation exists; one compromised operator password reaches every money mutation that role allows.                                    |
| Tenancy          | Delegable financial permissions inside the operator role                                   | MUST | Five fixed roles cannot express "warehouse clerk who cannot see margin" — the most common real-world variation request.                            |
| Tenancy          | Guided first-week setup that knows what is still unconfigured                              | NICE | A trial tenant lands on an empty product with fifteen domains; nothing names the six things that must be true before the first invoice is correct. |
| Tenancy          | Language / localisation                                                                    | NICE | The guide carries a Language article against a codebase with no i18n framework and hard-coded `en-US` formatters.                                  |
| Billing & plans  | A standing gate-to-grant audit (grantability invariant)                                    | MUST | With 16 flags, 10 SKUs and a hardcoded admin toggle array in a page component, nothing structurally prevents the next ungrantable gate.            |
| Billing & plans  | Tenant-facing RouteFlow invoice and receipt history                                        | NICE | `RfInvoice` already stores number, amount, status, cycle and pdfKey — the gap is a read endpoint and a screen, not a data model.                   |
| Billing & plans  | Gate-denial telemetry                                                                      | NICE | The `PLAN_GATE` 403 is the highest-intent signal the business produces and it is thrown and discarded.                                             |
| Data & comms     | State plainly that all outbound messaging is simulated                                     | MUST | The product shows a successful send, a thread entry and a metered count for a message that never left the server.                                  |
| Data & comms     | Opening accounts-payable import                                                            | MUST | Opening AR is covered and opening AP is not, so the first month's payables position is wrong and the shoebox keeps running.                        |
| Data & comms     | Get everything out — full-fidelity export of orders, invoices, stock, movements, documents | MUST | A standard procurement question; unanswered it makes the migration feel like a trap.                                                               |
| Data & comms     | Resolve the half-built inbound triage path                                                 | NICE | `InboundTriage` has a status machine and no visible reader — inbound messages could be landing in a table no screen shows.                         |

Capabilities the critics assigned to the proposed new domains above: guided pick list with scan
verification (MUST), multi-location stock with transfers (MUST), van load-out verification and
return-to-stock (NICE); vehicle record with a capacity check (NICE), cost per run and per stop
rolled up to cost-to-serve (ADVANCED); tenant-scoped API keys with scopes (NICE), outbound
webhooks (NICE); real SMS / WhatsApp / email transport (MUST), loginless shareable tracking link
(NICE), verifiable send log (MUST); per-tenant health view (NICE), fully attributed and consented
support impersonation (MUST).

### Contested capabilities and who should own them

Where two or more domains claim the same capability, they already disagree about its status —
which is itself the finding. Proposed owners:

| Contested capability                                       | Claimed by                                                                   | Proposed owner                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At-door payment collection                                 | Routes, Drivers, Invoicing                                                   | **Invoicing** owns the payment record and its money rules (one `InvoicePayment` writer, one rounding rule, one `settledAt` convention); Drivers owns only the capture UI and offline replay; Routes drops its claim. |
| End-of-run cash settlement                                 | Routes, Drivers                                                              | **Drivers** — it is the driver's money and the driver's handback. Routes references, never restates.                                                                                                                 |
| Proof of delivery (and its geo/share variants)             | Routes, Drivers                                                              | **Drivers** owns capture, artifacts and gating; Routes owns only whether a stop may be completed without one.                                                                                                        |
| Short-pick capture and delivered-vs-ordered reconciliation | Routes, Drivers, Invoicing                                                   | **Drivers** owns capture at the door; **Invoicing** owns what the shortfall does to the bill. Routes owns neither.                                                                                                   |
| Driver-filed returns and refusals                          | Credit & returns, Drivers                                                    | **Credit & returns** owns the Return record, the over-return guard and the money; Drivers owns the doorstep surface.                                                                                                 |
| Credit-limit enforcement                                   | Customers, Orders, Buyer portal, Invoicing                                   | **Customers** holds the limit and the exposure formula; **Orders** enforces it at the single point where an order's value is committed. Buyer portal and Invoicing reference, never re-implement.                    |
| Customer statement (monthly PDF)                           | Invoicing, Customers, Buyer portal, Data & comms                             | **Invoicing** — it is a receivables document. The others own entry points only.                                                                                                                                      |
| Standing orders / order templates                          | Orders, Customers, Buyer portal                                              | **Orders**, because it generates the orders. The three-way status disagreement is the finding.                                                                                                                       |
| MSRP                                                       | Catalog, Customers, Invoicing                                                | **Catalog** owns the resolution order and the per-piece rule; Invoicing owns only the snapshot onto the line and must never let it reach money math.                                                                 |
| Per-customer price override                                | Customers, Catalog                                                           | **Catalog** owns resolution; Customers owns the editing surface on the customer record.                                                                                                                              |
| Auto-apply oldest open credits at send                     | Invoicing, Credit & returns                                                  | **Credit & returns** owns the balance and the spend-only-once invariant; Invoicing owns the trigger point.                                                                                                           |
| Buyer self-serve payment                                   | Invoicing, Buyer portal                                                      | **Buyer portal** owns the checkout surface; **Invoicing** owns what lands as an `InvoicePayment` and the Stripe Connect webhook's idempotency.                                                                       |
| Age / ID verification at the door                          | Routes, Drivers, Compliance                                                  | **Compliance** — it is a legal control, not a delivery nicety, and it currently has no writer.                                                                                                                       |
| Licence gating on what a customer may buy                  | Orders, Customers, Buyer portal, Compliance                                  | **Compliance** owns the decision function; the other three own only the call site.                                                                                                                                   |
| Returns putting stock back, and at what cost               | Credit & returns, Inventory                                                  | **Inventory** owns the movement and the cost-basis question; Credit & returns owns only the decision to make it.                                                                                                     |
| Landed cost                                                | Inventory, Purchasing, Finance                                               | **Purchasing** — the freight and duty arrive on the bill.                                                                                                                                                            |
| Reorder points → draft purchase order                      | Catalog, Inventory, Purchasing                                               | **Catalog** owns the reorder point as data, **Inventory** owns the demand signal, **Purchasing** owns turning it into a draft PO.                                                                                    |
| Customer dunning                                           | Invoicing, Customers, Data & comms                                           | **Invoicing** owns the ladder and the trigger. The billing domain's tenant dunning is a different thing and should be renamed so it stops colliding.                                                                 |
| Order acknowledgement and document delivery                | Orders, Buyer portal, Data & comms                                           | **Data & comms** owns the render-and-send pipeline; each document domain owns only its template and its trigger.                                                                                                     |
| Customer delivery tracking                                 | Routes, Buyer portal, Drivers                                                | The proposed **communications** domain — the tokenized public page and the notification are one artefact seen from two sides.                                                                                        |
| Quiet hours                                                | Tenancy, Data & comms                                                        | The proposed **Notifications, Messaging & Realtime** domain — one `MessagingSettings` record, currently two opposite verdicts.                                                                                       |
| Accounting-package export                                  | Invoicing, Finance, Data & comms                                             | **Finance** owns the journal shape; onboarding owns only the one-time historical load.                                                                                                                               |
| CSV import/export machinery                                | Data & comms, Customers, Catalog, Orders, Invoicing                          | **Data & comms** owns a generic engine (mapping, validation, dry run, error file, undo); each domain registers a schema against it.                                                                                  |
| Tenant timezone                                            | Tenancy (MISSING) vs `TenantConfig.timezone` vs `MessagingSettings.timezone` | **Tenancy** owns exactly one. Two timezones for one business is a bug waiting to be filed.                                                                                                                           |
| Offline capture                                            | Orders, Routes, Drivers, Inventory                                           | Nobody — see cross-cutting §6. One queue, one replay contract, five surfaces.                                                                                                                                        |

## Testing strategy

### The layers this repo actually has

| Layer             | Runner                                                | Scope                                                                                                      | What belongs here                                                                                                     |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| API unit          | Jest (`apps/api`, `*.spec.ts`)                        | 181 specs against 463 source files, mocking at the module boundary (`apps/api/src/testing/prisma-mock.ts`) | Money math, state machines, guards' decision logic, service invariants, cross-tenant deny per service, DTO validation |
| Mobile pure logic | Jest (`apps/mobile/__tests__`)                        | 89 tests, pure logic only by project convention                                                            | Pricing mirrors, trip grouping, short-pick derivation, status flow, cache semantics                                   |
| Web e2e           | Playwright (`apps/web/e2e`, 20 specs)                 | Runs against the **deployed** site, gated on the deployed web build matching `github.sha`                  | Critical user paths, money shown to a user, gate/upsell rendering, accessibility scans, keyboard-only flows           |
| Static gates      | `npm run verify`, `validate-lock`, bug-signature scan | Repo-wide                                                                                                  | Mirror-drift diffs, grant-path completeness, raw-Prisma allowlist, locale-literal lint, route-inventory completeness  |
| Manual            | —                                                     | Devices, dead zones, restarts                                                                              | Anything requiring a real phone kill, a real network loss, a real screen reader, a real font scale                    |

### Structural gaps both critics found

1. **No integration or HTTP-level tier for the API.** The only supertest-shaped file is the Nest
   starter. Guards, interceptors, the validation pipe, DTO whitelisting and tenant scoping are
   never exercised together, so a route can be provably correct in unit tests and completely
   unguarded in production — exactly the shape of the unscoped financial-data wipe.
2. **`apps/web` has zero unit or component tests.** The golden reference for every flow and DTO is
   tested only through Playwright against a deployed site.
3. **E2E tests a deployed environment, not the code under review.** A good deploy gate and a poor
   correctness gate: a branch regression is invisible until after it ships, and every run must
   mutate or carefully avoid mutating a shared tenant.
4. **No end-to-end money invariant.** `pricing.spec.ts` is strong at the function level; nothing
   asserts order → invoice → partial payment → credit note → return → restock reconciling to the
   cent. Given how many writers touch a line's money, that single test would be the
   highest-value one in the repo.
5. **Tenant isolation is spot-tested, not systematic.** What is needed is a generated route
   inventory asserting cross-tenant deny for every mutating endpoint.
6. **The driver's day has effectively no automated coverage** — the surface with the most cash and
   the worst connectivity.
7. **The buyer portal has two specs and no negative paths** — nothing asserts buyer A cannot read
   seller B's catalogue, nothing tests merge, disconnect or revocation.
8. **Offline and replay are untested as a system.** Nothing kills and restarts the app, replays a
   queue, or duplicates a request to prove idempotency.
9. **No accessibility testing and no tooling installed to do it**, across four user-facing surfaces.
10. **No performance or scale testing** — no seeded large tenant, no query-count harness, no
    latency budget written down.
11. **Entitlement gates are tested case by case**, when the recurring failure is a completeness
    property over the whole key set.
12. **No migration or upgrade test.** `migrate deploy` on an empty database proves the DDL applies;
    nothing proves a populated tenant survives, and nothing tests a new gate against existing rows.
13. **No gate-recovery test** — the denial is tested, the purchase-and-unlock loop the business
    model depends on is not.
14. **Nothing tests that evidence survives a dispute** — prove this was delivered, prove this was
    the agreed price, prove this credit was applied once — three weeks later.
15. **Test signal is not trustworthy at the harness level**, which undermines every coverage claim
    above: turbo replays a cached log verbatim, so a full Jest summary can print for tests that
    never executed. The `Cached: N` line is the only reliable indicator, and run freshness is not
    asserted mechanically.
16. **The bug-signature baseline is load-bearing deferred debt** — 165 entries with no burn-down
    target and no review cadence.

### Standing invariants (always-on criteria)

These four hold for every domain, every release, and are the acceptance criteria of last resort.
A change that breaks one of them is wrong regardless of what its own tests say.

- [ ] **Every monetary write is rounded to cents through `roundMoney`** before it reaches a Decimal
      column — no intermediate float is ever persisted `Jest`
- [ ] **Boxed lines are priced through `computeLineSubtotal`** with box proration and are **never**
      re-derived as `qty * unitPrice` — the over-charge is exactly `unitsPerBox` and it is
      invisible in a demo `Jest`
- [ ] **A document's total equals the sum of its lines ± tax, discount and shipping** — for orders,
      invoices, credit notes and estimates, after any edit, split, void or reversal `Jest`
- [ ] **Every stock change writes a `StockMovement`, and Σ movements equals `currentStock`** for
      every product in a tenant — the ledger must be able to explain on-hand `Jest`
- [ ] The three `pricing.ts` mirrors (api / web / mobile) are identical in their exported
      logic `CI`
- [ ] No tenant-scoped write reaches the database outside `prisma.forTenant()` /
      `prisma.tenantTransaction()` without an explicit reviewed allowlist entry `CI`
- [ ] Every `@RequireAddon` / `@RequirePlanFlag` key has a path that can grant it `CI`

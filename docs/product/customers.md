# Customer Management (CRM for wholesale)

_The single record a wholesale distributor uses to know, price, bill and serve every retail account._

## The problem

A wholesale distributor knows its retail accounts through a scatter of artefacts: a paper
delivery book in the van, a phone contact list, a spreadsheet of "who I promised what price", a
folder of tobacco/liquor licence photos, and the memory of whichever rep covers that street.
Nobody can answer "what does this shop owe me, what price did I quote them, who do I call when
the owner is out, and is their licence still valid" without three phone calls and a hunt through
WhatsApp. When a rep or driver leaves, the relationship, the negotiated prices and the collection
history walk out with them, and the accounting package — which holds the only reliable balance —
knows nothing about delivery addresses, licences or who the account belongs to.

## Why it matters to a tenant

One tenant-scoped customer record carries identity, contacts, geocoded delivery addresses,
negotiated prices, payment terms, credit exposure, compliance licences and agent attribution, so
any operator or driver can serve any account without asking anyone. Concretely: the customer list
computes live receivables and unused credit per row in the same query
(`customers.service.ts findAll`), `GET /api/v1/customers/:id/statement` returns outstanding /
overdue / available-credit / pending-order exposure in one call, a monthly statement PDF is one
tap on mobile (`GET /:id/statements/:month`), and price memory plus `CustomerPrice` overrides
mean the price a customer was quoted survives the person who quoted it. Deleting a customer who
has financial history is impossible by accident — it soft-deletes and preserves every invoice
(`deleteCustomer(force)` + `POST /:id/restore`).

## Core use cases

1. **Maintain the account of record** — create and keep current one row per buying business:
   legal/display name, contacts, phone/email (email optional), delivery and billing addresses
   with lat/lng for routing, tax id and exemption, and status — so every other domain (orders,
   invoices, routes, portal) resolves the same customer.
2. **Price and term the account** — decide what this specific customer pays and on what terms: a
   default pricing tier (1-5), per-product price/MSRP overrides, remembered last-given price,
   per-customer payment terms and deposit percent — all resolved automatically when an order or
   invoice is built for them.
3. **Know what they owe and whether to keep selling** — see the account's live financial position
   — open invoice balance, overdue amount, unused credit notes and advance payments, uninvoiced
   open orders — and hold selling against a credit limit when exposure would breach it.

## Must have (P0)

| ID      | Capability                                                          | Status     | What it does                                                                                                                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRM-M1  | Customer record CRUD, tenant-scoped                                 | SHIPPED ✅ | Operators create, read, update and deactivate a customer record with business/contact/display names, phone, mobile, email, notes, type, tax id and tax-exempt flag; every read/write is tenant-scoped.                               | `POST/GET/PATCH /api/v1/customers(/:id)` — `customers.controller.ts:52-169`; `customers.service.ts create():384` / `update():638`; Prisma `Customer` (`schema.prisma:750`); tenant post-filter in `prisma.service.ts forTenant():223`                                                                                                                                                                                    |
| CRM-M2  | Multiple addresses, geocoded, one default                           | SHIPPED ✅ | Many addresses per customer, one flagged default, geocoded to lat/lng on create and re-geocoded on edit; geocode failure never blocks the save.                                                                                      | `POST/PATCH/DELETE /:id/addresses(/:addrId)` — `customers.controller.ts:259-279`; `addAddress():743` etc.; `geocodeIfPossible():76`; `POST /customers/geocode-all`                                                                                                                                                                                                                                                       |
| CRM-M3  | Named contact people per account                                    | SHIPPED ✅ | Multiple contact people (owner, buyer, night manager) each with salutation, name, email, phone, mobile, one primary flag.                                                                                                            | `GET/POST/PATCH/DELETE /:id/contacts(/:cid)` — `customers.controller.ts:297-319`; Prisma `ContactPerson` (`schema.prisma:2148`)                                                                                                                                                                                                                                                                                          |
| CRM-M4  | Email is optional (placeholder sentinel, never surfaced)            | SHIPPED ✅ | A phone-only customer can still be created; a non-routable internal login address is minted and never shown.                                                                                                                         | `CreateCustomerDto.email @IsOptional`; `create():400` mints `no-email+<uuid>@placeholder.local`; `sendPortalInvite():2258` ignores it                                                                                                                                                                                                                                                                                    |
| CRM-M5  | Customer list: search, filter, sort, pagination, live money columns | SHIPPED ✅ | Finds an account by name/contact/phone/email/display name, filters by status/type/tag/regulated, sorts on an allowlist, shows live receivables and unused credit per row.                                                            | `GET /api/v1/customers?...` — `dto/list-customers.dto.ts`; `findAll():103` (`receivablesMap:208`, `creditsMap:219`)                                                                                                                                                                                                                                                                                                      |
| CRM-M6  | Per-customer price tier and per-product price override              | SHIPPED ✅ | Account sits on a pricing tier (1-5) and can carry per-product overrides that survive independently of the tier.                                                                                                                     | `Customer.pricingTier`; `GET/POST/DELETE /:id/prices` behind `@RequirePlanFlag('flag.pricing_tiers')`; Prisma `CustomerPrice` unique on `(customerId,productId)`; consumed by `resolveBuyerLinePrice():119`                                                                                                                                                                                                              |
| CRM-M7  | Per-customer payment terms and deposit default                      | SHIPPED ✅ | "This account is Net 60" / "50% deposit" as properties of the customer, overriding the tenant default; empty string clears back to tenant default.                                                                                   | `Customer.defaultPaymentTerms` / `defaultDepositPercent` (`schema.prisma:782-788`); consumed by `invoices.service.ts` term/deposit resolution                                                                                                                                                                                                                                                                            |
| CRM-M8  | Credit limit held against the account                               | PARTIAL 🟡 | A dollar credit limit refuses growth of open exposure — but only on order **edit** and change-request approval, not on order **create**.                                                                                             | `Customer.creditLimit`; `assertWithinCreditLimit():3957` called from `updateOrderItems():3460` and `approveChangeRequestAtStop():4464`; no call site inside `orders.service.ts create():1444-2040` or `createSale():2040`                                                                                                                                                                                                |
| CRM-M9  | Customer statement JSON, and a monthly statement PDF                | PARTIAL 🟡 | Operator gets outstanding/overdue/available-credit/advance/pending-order exposure in one call on both web and mobile — but the downloadable monthly PDF has **no web consumer**.                                                     | verified: `GET /:id/statement` → `getStatementForOperator():860`, used on web via `useCustomerStatement` (`customers/[id]/page.tsx:85,1948`). The PDF (`GET /:id/statements`, `/:id/statements/:month`) is consumed ONLY by mobile — `apps/mobile/lib/api/customers.ts:96-108` behind `apps/mobile/app/(operator)/customers/[id]/statement.tsx:29,59`. `apps/web/lib/api/customers.ts` has no statement-PDF hook at all. |
| CRM-M10 | Safe delete and undo that never destroys financial history          | PARTIAL 🟡 | Deleting a customer with history soft-deletes and preserves records, with an 8-second Undo — but `DELETE /customers/all` bypasses all of this.                                                                                       | `DELETE /:id?force=` → `deleteCustomer():1761`; `POST /:id/restore`; `POST /customers/batch-delete` pre-flight blocks PAID/SENT invoices. `DELETE /customers/all` → `deleteAllCustomers():1959` has NO guard and hard-deletes every customer's payments/invoices/credit notes/returns/orders/transactions from any OPERATOR token (`customers.controller.ts:131`)                                                        |
| CRM-M11 | Account status (active/inactive) drives login and visibility        | SHIPPED ✅ | Suspending an account stops the customer's login and can filter the row out of the working list, without deleting anything.                                                                                                          | `PATCH /:id/status` → `changeStatus():678`; `ListCustomersDto.status` filters `where.user.status`                                                                                                                                                                                                                                                                                                                        |
| CRM-M12 | Role-scoped access to a customer's own data                         | BROKEN 🔴  | A customer login should see only their own profile/statement/orders — but `PATCH /customers/me` takes the full `UpdateCustomerDto`, so a customer can rewrite their own credit limit, pricing tier, tax exemption and payment terms. | `updateMyProfile():246` calls `update()` unchanged with the operator DTO (`customers.controller.ts:125`); the buyer-portal twin was hardened for exactly this (`UpdateBuyerProfileDto`, F4-001) but this legacy route was not                                                                                                                                                                                            |
| CRM-M13 | Per-customer price memory ("what did we last charge this shop?")    | SHIPPED ✅ | A dedicated endpoint returns the last price given to this customer per product, injected into every order/scan build so a negotiated price is never re-typed from memory.                                                            | `GET /api/v1/orders/price-history?customerId=` — `orders.controller.ts:183-191` → `getCustomerPriceHistory():473`; consumed at `orders.service.ts:1570-1571, 1596, 1740, 2647, 4154-4156, 4403`                                                                                                                                                                                                                          |
| CRM-M14 | Retail tobacco licence fields feeding state filings                 | MISSING ⬜ | `Customer.tobaccoLicenseNo` / `tobaccoLicenseExpiry` are read by tobacco/regulated state-filing reports, but nothing in the product writes them.                                                                                     | claim unsupported by code: `schema.prisma:774-775` fields are read at `regulated/tx-report.ts:439`, `regulated-report.service.ts:267,283`, `tobacco.service.ts:152-153`; grep of `apps/api/src/customers` for `tobaccoLicense` returns zero hits, neither Create nor Update DTO carries the fields, and the only writer in the repo is `apps/api/scripts/demo-seed.js:1758`                                              |

### Testing criteria

#### CRM-M1

- [ ] Creating a customer with businessName+contactName+username persists a Customer AND a linked User with role CUSTOMER and forcePasswordChange=true, in one transaction. `Jest`
- [ ] POST with a username already taken in this tenant returns 400 and writes nothing. `Jest`
- [ ] GET /customers/:id for a tenant-B id with a tenant-A token returns 404. `Jest`
- [ ] A 4000-character businessName is rejected at the API rather than truncated. `Playwright`

#### CRM-M2

- [ ] Posting a second address with isDefault:true clears isDefault on every other address of that customer. `Jest`
- [ ] Geocoding provider failure still creates the address with lat/lng null and a 2xx. `Jest`
- [ ] PATCH of an address re-geocodes asynchronously without blocking the response. `Jest`
- [ ] DELETE of an address referenced by a RouteStop returns 4xx and the address still exists. `Jest`

#### CRM-M3

- [ ] Adding a contact with isPrimary:true demotes every existing contact in the same transaction. `Jest`
- [ ] PATCH of contact X to isPrimary:true demotes all others except X. `Jest`
- [ ] PATCH/DELETE of a contactId belonging to a different customer returns 404. `Jest`

#### CRM-M4

- [ ] POST with no email: Customer.email null, User.email matches the placeholder pattern, response user.email is null. `Jest`
- [ ] Two emailless customers created back-to-back both succeed with unique minted addresses. `Jest`
- [ ] Portal-invite on an emailless customer with no overrideEmail returns 400 and never leaks the placeholder. `Jest`
- [ ] Customer detail page renders an empty email field, not the placeholder string. `Playwright`

#### CRM-M5

- [ ] sortBy of a non-scalar/injected/prototype key falls back to `{createdAt:'desc'}`. `Jest`
- [ ] A VOID InvoicePayment does not reduce a row's receivables figure. `Jest`
- [ ] Soft-deleted and supplierOnly customers are absent from the list and count. `Jest`
- [ ] Search → open row → Back returns to the searched, same-page list. `Playwright`

#### CRM-M6

- [ ] A tier-only PATCH on a row with an MSRP override leaves the msrp untouched, and vice versa. `Jest`
- [ ] A DRIVER posting `{pricingTier:null}` on a row with no MSRP returns 403. `Jest`
- [ ] Posting neither field returns 400; clearing both deletes the row rather than leaving it empty. `Jest`
- [ ] Without flag.pricing_tiers, all three price routes return 403 with no write. `Jest`
- [ ] A boxed line priced from a tier uses computeLineSubtotal, never qty × unitPrice, rounded to cents. `Jest`

#### CRM-M7

- [ ] PATCH defaultPaymentTerms:'' stores null; a valid label stores verbatim; an invalid one 400s. `Jest`
- [ ] Invoice created for a customer with Net 60 gets dueDate = issueDate+60 even if tenant default is Net 30. `Jest`
- [ ] An order with an explicit depositPercent is not overwritten by the customer default. `Jest`
- [ ] The deposit amount is roundMoney'd and invoice total still equals line subtotals plus tax. `Jest`

#### CRM-M8

- [ ] Editing an order to land one cent over creditLimit throws CREDIT_LIMIT_EXCEEDED and rolls back. `Jest`
- [ ] Creating a NEW order whose total alone exceeds creditLimit must be rejected (currently failing/absent). `Jest`
- [ ] A VOID payment does not reduce exposure. `Jest`
- [ ] creditLimit null skips the check with no extra query. `Jest`
- [ ] Exposure de-dupes an order with an open mirror invoice. `Jest`

#### CRM-M9

- [ ] availableCredit = Σ roundMoney(creditNote.amount − amountUsed) over non-VOID, non-expired notes. `Jest`
- [ ] outstandingAmount excludes VOID payments and PAID/VOID/WRITTEN_OFF invoices; advance/pending reported separately. `Jest`
- [ ] GET /:id/statements/:month with a malformed month returns 400, not 500 or an empty PDF. `Jest`
- [ ] Both statement routes carry @Roles(OPERATOR); CUSTOMER/DRIVER tokens get 403. `Jest`
- [ ] A web statement-PDF affordance must exist or the "one click" claim should be dropped from user-facing copy. `manual`

#### CRM-M10

- [ ] DELETE with 1 invoice returns 409 naming counts; with force=true soft-deletes and preserves the invoice. `Jest`
- [ ] POST /:id/restore clears deletedAt, reactivates the user, and is idempotent. `Jest`
- [ ] batchDelete of a set containing one PAID-invoice customer 409s for the whole batch. `Jest`
- [ ] DELETE /customers/all must refuse when any customer has a PAID/SENT invoice (currently failing/absent). `Jest`
- [ ] deleteAllCustomers runs inside a tenant transaction and touches zero rows of another tenant. `Jest`

#### CRM-M11

- [ ] PATCH /:id/status updates the linked User row; a subsequent login is rejected. `Jest`
- [ ] GET /customers?status=INACTIVE returns only suspended accounts with correct meta.total. `Jest`
- [ ] PATCH /:id/status for another tenant's id returns 404 before any write. `Jest`

#### CRM-M12

- [ ] PATCH /customers/me with creditLimit:999999 from a CUSTOMER token must be rejected (currently failing). `Jest`
- [ ] Same for pricingTier, isTaxExempt, taxId, currency, customerType, fulfillPath. `Jest`
- [ ] PATCH /customers/me with phone/contactName/deliveryWindowStart succeeds and touches only those fields. `Jest`
- [ ] Every CustomersController handler declares @Roles (reflection spec). `Jest`

#### CRM-M13

- [ ] Price history returns the most recent non-void line price per product for the customer. `Jest`
- [ ] An order/scan build injects lastPrice from this endpoint rather than a stale snapshot. `Jest`

#### CRM-M14

- [ ] Given the fields are still unwritable, the tobacco/regulated report must not silently emit a blank licence number where one is legally required — surface an explicit gap instead. `manual`
- [ ] Once a writer exists: CreateCustomerDto/UpdateCustomerDto accept and validate the licence number/expiry. `Jest`

## Nice to have (P1)

| ID      | Capability                                                         | Status     | What it does                                                                                                                                                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM-N1  | Tags as lightweight segmentation                                   | SHIPPED ✅ | Colour-coded tenant-defined tags assigned to customers, usable as a list filter.                                                                                                                                                                                     | `GET/POST /customers/tags`, `POST/DELETE /:id/tags(/:tagId)`; Prisma `CustomerTag`/`CustomerTagAssignment`                                                                                                                                                                               |
| CRM-N2  | Internal comments timeline on the account                          | SHIPPED ✅ | Dated internal notes against a customer, visible to the whole team.                                                                                                                                                                                                  | `GET/POST/DELETE /:id/comments(/:cid)`; Prisma `CustomerComment`                                                                                                                                                                                                                         |
| CRM-N3  | Customer documents and tax-exemption certificates                  | SHIPPED ✅ | Attach signed agreements, W-9s, resale certificates, licence scans, typed and viewable, with a hard file-type allowlist.                                                                                                                                             | `GET/POST/DELETE /:id/documents(/:docId)`, `/:id/tax-documents`; MIME allowlist, SVG blocked, 15 MB cap                                                                                                                                                                                  |
| CRM-N4  | Bulk import of customers from a CSV                                | SHIPPED ✅ | Onboard an existing book of accounts in one upload, including accounting-package exports.                                                                                                                                                                            | `POST /api/v1/import/contacts`; `Customer.zohoContactId @unique` for re-import matching                                                                                                                                                                                                  |
| CRM-N5  | Customer list export to CSV                                        | PARTIAL 🟡 | Exports the (filtered) list with receivables/credits — but its filter omits `supplierOnly:false` and `deletedAt:null`, unlike the on-screen list.                                                                                                                    | `GET /customers/export` → `exportCustomers():1463`; `where` at :1464 diverges from `findAll():108`                                                                                                                                                                                       |
| CRM-N6  | Merge duplicate customer records                                   | SHIPPED ✅ | Merges two rows for the same shop, moving orders, invoices, prices, tags and regulated licences onto the survivor.                                                                                                                                                   | `POST /customers/merge` → `mergeCustomers():1578`; re-points `CustomerAuthorization`/`AuthorizationOverride` before deleting the secondary                                                                                                                                               |
| CRM-N7  | Buyer-portal invitation, approval and disconnection                | PARTIAL 🟡 | Invite/approve/decline/disconnect a buyer-portal link — but "Send Portal Invite" sends no email or SMS, only returns a URL in a message string.                                                                                                                      | `POST /:id/portal-invite` etc. — `sendPortalInvite():2245`; no portal-invite email template exists anywhere in `apps/api/src/email`                                                                                                                                                      |
| CRM-N8  | Standing orders / order templates per account                      | SHIPPED ✅ | A recurring basket ("the usual Tuesday order") droppable into a new order.                                                                                                                                                                                           | Prisma `OrderTemplate` relation on Customer; web Standing Orders tab; buyer twin `GET /buyer/templates`                                                                                                                                                                                  |
| CRM-N9  | Advance payments / customer deposits held on account               | SHIPPED ✅ | Take money on account before an invoice exists and apply it to specific invoices later; live apply flow on mobile invoices.                                                                                                                                          | verified: `POST/GET /:id/advance-payments`, `POST /:id/advance-payments/:apId/apply`; live on `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx:38,1084` via `useApplyAdvancePayment`; both web apply hooks (`customers.ts:288`, `invoices.ts:475`) are dead code with zero importers |
| CRM-N10 | Per-customer order and invoice history from the record             | SHIPPED ✅ | See a customer's orders/invoices from their page without filtering the global list.                                                                                                                                                                                  | `GET /:id/orders` → `findOrders():723`, `@Roles(OPERATOR, CUSTOMER)`, own-data enforced                                                                                                                                                                                                  |
| CRM-N11 | Fulfilment preference and delivery window on the account           | PARTIAL 🟡 | Records routed-vs-shipped and delivery hours — but the window is two unvalidated free-text strings at customer (not address) level, and unsettable at create time.                                                                                                   | `Customer.fulfillPath`, `deliveryWindowStart/End`; `UpdateCustomerDto` exposes the window fields, `CreateCustomerDto` does not                                                                                                                                                           |
| CRM-N12 | Customer income chart (6-month revenue vs cost)                    | SHIPPED ✅ | A quick per-account picture of money received vs spent over six months.                                                                                                                                                                                              | `GET /:id/income-chart` → `getIncomeChart():1406`                                                                                                                                                                                                                                        |
| CRM-N13 | Bulk selection: delete and assign                                  | SHIPPED ✅ | Select many customers to clean up an import or hand a block of accounts to a sales agent.                                                                                                                                                                            | `POST /customers/batch-delete`; `POST /sales-agents/:id/assignments/bulk`. Cleanup-preview/cleanup-imported routes exist but are unused by any UI.                                                                                                                                       |
| CRM-N14 | Operator customer management on mobile                             | PARTIAL 🟡 | Most of the record is reachable on mobile — parity gap runs both ways: mobile is missing buyer-portal controls, income chart, merge, import/export, sales-agent assignment; but mobile is the ONLY surface for the statement PDF and the advance-payment apply flow. | verified: mobile screens listed under `apps/mobile/app/(operator)/customers/`; mobile-only capabilities are the statement PDF (CRM-M9) and advance-payment apply (CRM-N9)                                                                                                                |
| CRM-N15 | Address geocoding backfill                                         | SHIPPED ✅ | Retro-geocodes every address with no coordinates in one action.                                                                                                                                                                                                      | `POST /customers/geocode-all` → `geocodeAllAddresses():82`                                                                                                                                                                                                                               |
| CRM-N16 | Buyer-submitted regulated authorisations                           | SHIPPED ✅ | The customer/buyer uploads their own licence for operator approval, and sees their own expiry warning.                                                                                                                                                               | `GET/POST /buyer/authorizations` — `buyer.controller.ts:960,971,979` → `AuthorizationsService.submit():183`; `GET /buyer/authorizations/expiring`                                                                                                                                        |
| CRM-N17 | Buyer-initiated portal connection request and disconnection        | SHIPPED ✅ | The other half of the portal link: buyer requests a connection, redeems the invite token, and can disconnect.                                                                                                                                                        | `POST /buyer/sellers/request` (`buyer.controller.ts:128`); `DELETE /buyer/sellers/:sellerSlug` (:139); `GET /buyer/invites/:token/details` (:114); `POST /buyer/invites/:token/accept` (:121)                                                                                            |
| CRM-N18 | Per-customer shelf: favourites, stock alerts, replenishment snooze | SHIPPED ✅ | The buyer's own favourites list, low-stock alerts and reorder-cadence snoozing, hanging off the customer record.                                                                                                                                                     | `GET/POST/DELETE /buyer/favorites(/:productId)`; `/buyer/stock-alerts`; `/buyer/replenishment`, `/buyer/shelf`, snooze routes; Prisma `buyerFavorites`/`replenishmentSnoozes`/`stockAlerts` on Customer                                                                                  |
| CRM-N19 | Per-customer payment requests                                      | SHIPPED ✅ | Buyer-initiated "let me pay this" with operator approval, a per-customer money surface.                                                                                                                                                                              | Prisma `BuyerPaymentRequest` relation on Customer; `GET /payment-requests`, `POST /:id/approve`, `POST /:id/reject`, all `@Roles(OPERATOR)`                                                                                                                                              |

### Testing criteria

#### CRM-N5

- [ ] Soft-delete a customer, then export; row count must equal the list's meta.total and the deleted customer must be absent (currently failing). `Jest`
- [ ] A business name with a comma or quote is CSV-escaped so column count stays stable. `Jest`
- [ ] The Receivables column matches the list's value to the cent, excluding VOID payments. `Jest`

#### CRM-N6

- [ ] Merging a secondary with a VERIFIED tobacco authorization into a primary with none leaves the primary VERIFIED. `Jest`
- [ ] When both rows hold an authorization for the same category, the stronger one survives before the re-point. `Jest`
- [ ] After a merge, the primary's statement outstanding equals the sum of the two pre-merge outstandings to the cent. `Jest`
- [ ] Merging a customer from another tenant returns 404 and mutates nothing. `Jest`

#### CRM-N7

- [ ] Declining a request against a still-live invite reverts to INVITED with buyerAccountId null; declining an expired one deletes the row. `Jest`
- [ ] Approving a non-PENDING_SELLER_APPROVAL link returns 409; approving clears inviteToken. `Jest`
- [ ] portal-disconnect burns inviteToken/inviteExpiresAt. `Jest`
- [ ] POST /:id/portal-invite must actually dispatch an email, or the UI must stop claiming it did (currently failing/absent). `Jest`
- [ ] The pending-approval bell row survives "mark all read" and disappears only once approved/declined. `Playwright`

#### CRM-N9

- [ ] Applying an advance reduces AdvancePayment.balance by exactly the applied amount and increases the invoice's paid total, both roundMoney'd. `Jest`
- [ ] The alreadyPaid figure excludes VOID payments. `Jest`
- [ ] POST with amount ≤ 0 returns 400 and writes nothing. `Jest`
- [ ] advanceBalance is reported separately on the statement, never folded into availableCredit. `Jest`

#### CRM-N11

- [ ] An order with no fulfillPath for a SHIP customer is created as SHIP; a customer with none defaults to ROUTE. `Jest`
- [ ] deliveryWindowStart:'25:99' should be rejected 400 rather than stored (currently failing/absent). `Jest`
- [ ] PATCH with deliveryWindowStart:'' clears to null. `Jest`
- [ ] The delivery window is visible to the driver at the stop, not only in the office. `manual`

## Advanced / future (P2)

| ID      | Capability                                           | Status     | What it does                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ---------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM-A1  | Sales agent ownership of accounts, with commission   | SHIPPED ✅ | Attributes each customer to the agent who brought them in, accrues commission on issued invoices as cash is collected, gated by an addon.                                                                             | `apps/api/src/sales-agents/`; `CreateCustomerDto.salesAgentId`; `@RequirePlanFlag('flag.sales_agents')`. Operator controls not previously named: per-customer commission-rate override (`POST /sales-agents/:id/customer-rates`), assignment close (`POST /sales-agents/assignments/close`), current-assignment lookup, and per-agent "stop new business" freeze (`PATCH /:id/status` `stopNewBusinessAt`) |
| CRM-A2  | Per-customer MSRP override for shelf-price guidance  | SHIPPED ✅ | Suggested retail price on a specific customer's invoice — display only, never money math.                                                                                                                             | `CustomerPrice.msrp`; `common/msrp.ts resolveMsrp`; gated by `flag.msrp`                                                                                                                                                                                                                                                                                                                                   |
| CRM-A3  | Per-customer regulated authorisations (licences)     | SHIPPED ✅ | Holds tobacco/liquor licences per category with expiry and verifying-operator snapshot; gates buyer catalogue visibility.                                                                                             | `authorizations.controller.ts`; Prisma `CustomerAuthorization` unique `(customerId,trackedCategoryId)`, append-only `AuthorizationOverride`                                                                                                                                                                                                                                                                |
| CRM-A4  | Customer messaging (WhatsApp/SMS with consent)       | BROKEN 🔴  | Consent-gated messaging engine exists end to end, but nothing in the product ever writes consent, so every send is skipped.                                                                                           | `Customer.smsConsent`/`waConsent` default false; `messaging.service.ts sendMessage` gates on them (:106); no DTO field, endpoint, web or mobile control writes them; bound provider is a stub                                                                                                                                                                                                              |
| CRM-A5  | Customer-level activity timeline                     | PARTIAL 🟡 | Every mutation is captured in AuditLog, but the only reader is the platform-admin panel — no tenant-facing customer timeline.                                                                                         | `audit.interceptor.ts`; only consumer is `apps/web/app/(platform-admin)/admin/audit-logs/page.tsx`                                                                                                                                                                                                                                                                                                         |
| CRM-A6  | Customer-specific catalogue / assortment             | MISSING ⬜ | No allow/deny list model exists to restrict which products an account can see or order beyond the regulated licence gate.                                                                                             | Only gate is the regulated computeGate; `CustomerPrice` controls price, not visibility; mobile screen named "catalog" is actually the price-override editor                                                                                                                                                                                                                                                |
| CRM-A7  | Dormancy, churn and at-risk account signals          | MISSING ⬜ | No report surfaces accounts that have gone quiet; no recency filter on the customer list.                                                                                                                             | `GET /analytics/customers/top` is the only related endpoint (revenue ranking, not recency); `ListCustomersDto` has no `lastOrderedBefore`/`inactiveDays` filter                                                                                                                                                                                                                                            |
| CRM-A8  | Account value / behavioural segmentation (RFM / LTV) | MISSING ⬜ | Segmentation today is manual tags plus free-text customerType; a tenant-level DSO/margin/AOV exists but nothing per-customer.                                                                                         | `common/msrp.ts:13-19` documents a segment layer as explicitly future; tenant-level `GET /analytics/dso`, `/gross-margin`, `/aov` exist but nothing per-customer                                                                                                                                                                                                                                           |
| CRM-A9  | Credit hold and dunning workflow                     | MISSING ⬜ | No onHold flag, no reminder ladder, no operator-override flow beyond the single synchronous credit-limit throw.                                                                                                       | `Customer.creditLimit` only; enforcement is one throw inside order edit; comment at `orders.service.ts:3941-3943` explicitly leaves room for an override flow that does not exist                                                                                                                                                                                                                          |
| CRM-A10 | Duplicate detection at creation                      | MISSING ⬜ | No fuzzy match on businessName/phone/address at create time; merge is fully manual and after the fact.                                                                                                                | `create():392` checks only email/username uniqueness; `POST /customers/suggest-merge` operates on buyer accounts, not duplicate customer records                                                                                                                                                                                                                                                           |
| CRM-A11 | Territory / route ownership of accounts              | PARTIAL 🟡 | `GET /:id/routes` returns a customer's routes and driver — but routes are addon-gated, so a tenant without the delivery addon has no territory concept at all, and no territory entity exists independent of a route. | `Customer.routes`/`routeStops` relations; `findRoutes():687`; `RoutesController` behind `@RequireAddon('recurring_routes','order_delivery','developer_mode')`                                                                                                                                                                                                                                              |
| CRM-A12 | Customer-facing self-service account portal          | SHIPPED ✅ | The customer signs in, sees statement/balance/price list/order history and reorders, with commercially-editable fields controlled by the seller — except on the legacy path (see CRM-M12).                            | Buyer portal (`BuyerAccount`↔`CustomerLink`, `PATCH /buyer/me` hardened with `UpdateBuyerProfileDto`) and legacy customer-role path (`GET/PATCH /customers/me`)                                                                                                                                                                                                                                            |

### Testing criteria

#### CRM-A1

- [ ] Commission base = max(0, subtotal − discount − nsfFees); tax/shipping/NSF fees never enter. `Jest`
- [ ] A re-sync of unchanged state writes nothing; negative drift emits exactly one adjustment. `Jest`
- [ ] Cash math counts only PAID payments — a DRAFT payment must not release commission. `Jest`
- [ ] Closing an assignment at or before its own effectiveFrom returns 400. `Jest`
- [ ] With the addon off, sales-agent nav/UI/routes are absent client-side and 403 server-side. `Playwright`

#### CRM-A2

- [ ] msrp of 0/negative/non-numeric resolves to null and renders blank. `Jest`
- [ ] A customer MSRP override wins over the product default; clearing falls back with no row left behind. `Jest`
- [ ] MSRP never participates in subtotal/tax/total — invoice totals are byte-identical with and without it. `Jest`
- [ ] Without flag.msrp, an msrp key on the prices POST returns 403 while a tier-only post succeeds. `Jest`

#### CRM-A3

- [ ] A customer with no VERIFIED authorization for a gated category cannot see those products; the untracked catalogue is unaffected. `Jest`
- [ ] An expired authorization behaves as unverified; expiry notice fires once per bucket. `Jest`
- [ ] The verifying operator's id and name are snapshotted, surviving that operator's deletion. `Jest`
- [ ] An override is append-only — no route mutates one after creation. `Jest`
- [ ] The expiry bell lists a customer expiring in 7 days and links to their Authorizations tab. `Playwright`

#### CRM-A4

- [ ] An operator-facing write path must set smsConsent/waConsent and stamp consentUpdatedAt (currently failing/absent). `Jest`
- [ ] With consent false, send is skipped with reason NO_CONSENT and nothing is metered. `Jest`
- [ ] Invoice-type events are never dispatched over WhatsApp/SMS regardless of consent. `Jest`
- [ ] Before enabling for a tenant, confirm consent capture is legally recorded (who/when/channel). `manual`

#### CRM-A5

- [ ] PATCH /customers/:id writes an AuditLog row with tenantId, userId, action, entityType, entityId and a trust-proxy-aware IP. `Jest`
- [ ] IP is taken from req.ip, never a spoofable X-Forwarded-For entry. `Jest`
- [ ] Audit writes never fail or delay the underlying request. `Jest`
- [ ] Build a tenant-scoped, per-customer timeline that leaks no other tenant's rows. `manual`

#### CRM-A6

- [ ] An excluded SKU is omitted from buyer catalogue, search, "usuals" and the operator order builder; direct productId POST is rejected 4xx. `Jest`
- [ ] No assortment configured behaves byte-identical to today. `Jest`
- [ ] An assortment row for tenant A is invisible in tenant B. `Jest`
- [ ] An assortment composes with, not replaces, the regulated gate. `Jest`

#### CRM-A7

- [ ] A customer whose most recent order is older than the threshold appears with days-since-last-order and trailing-12mo revenue; a brand-new customer does not. `Jest`
- [ ] The measure is invoiced sales, not StockMovement type SALE (unwritten since c5f579c2). `Jest`
- [ ] The report never counts another tenant's orders. `Jest`
- [ ] An INACTIVE or soft-deleted customer is excluded rather than flagged at-risk. `Jest`

#### CRM-A8

- [ ] Segment membership recomputes on a schedule and is queryable as a list filter. `Jest`
- [ ] Revenue driving a segment is sourced from stored line subtotals, never qty × unitPrice, rounded to cents. `Jest`
- [ ] A segment used as a pricing input resolves below a per-customer override and above the product default. `Jest`
- [ ] Segment definitions and memberships never cross tenants. `Jest`

#### CRM-A9

- [ ] An account 45 days past due with a 30-day hold policy blocks new order creation with a distinguishable error code, visible on the record and at the driver's stop. `Jest`
- [ ] Recording a payment that clears the oldest overdue invoice releases the hold in the same transaction. `Jest`
- [ ] A named role can override a hold with a recorded, append-only reason. `Jest`
- [ ] Overdue/exposure are derived from the one statement formula, never a second derivation. `Jest`

#### CRM-A10

- [ ] Creating a near-duplicate at the same address surfaces a candidate-duplicate warning with a link, but still allows proceeding. `Jest`
- [ ] The check never blocks — a genuinely new second location can always be created. `Jest`
- [ ] The candidate query is tenant-scoped and bounded, not a full-table scan per keystroke. `Jest`
- [ ] Detection never surfaces a soft-deleted or another tenant's record. `Jest`

#### CRM-A11

- [ ] GET /:id/routes de-duplicates by routeId and names the driver, falling back to username. `Jest`
- [ ] With no delivery addon enabled, the routes section is hidden, not a spinner or error. `Jest`
- [ ] A customer on no route returns an empty array with an empty-state UI. `Jest`
- [ ] Build a territory concept that survives without the routes addon. `manual`

#### CRM-A12

- [ ] PATCH /buyer/me carrying pricingTier/creditLimit/isTaxExempt is rejected and stored values unchanged. `Jest`
- [ ] The same assertion must hold for PATCH /customers/me (currently failing — see CRM-M12). `Jest`
- [ ] A buyer on a PENDING link sees "Pending approval" and never the customer's businessName. `Playwright`
- [ ] GET /customers/me/statement returns only the calling customer's data, using the same credit formula as the operator statement. `Jest`

## How this varies by tenant

| Variation                                                       | Mechanism                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-customer price overrides can be switched off                | `flag.pricing_tiers` — `@RequirePlanFlag('flag.pricing_tiers')` on all `/customers/:id/prices` handlers                                                                                                                                                              |
| Credit-limit enforcement on or off                              | `flag.credit_limits`; also gated by a `PLAN_FLAG_ENFORCEMENT` env kill switch whose code default is "off" — meaning the check currently ALWAYS runs regardless of plan                                                                                               |
| What the five pricing tiers are called                          | tenant SystemConfig key `pricing.tierLabels` → `tierLabel()`, mirrored across api/web/mobile                                                                                                                                                                         |
| How many price tiers exist                                      | **NOT CONFIGURABLE** — hardcoded at 5 (`Product.priceTier2..priceTier5`, `@Min(1) @Max(5)`)                                                                                                                                                                          |
| How many customers a tenant may hold before buying capacity     | `CUSTOMERS` meter + `CUSTOMER_PACK_100` addon + 7-day grace; soft cap, fails open on billing lookup error                                                                                                                                                            |
| Sales-agent attribution and commission dark vs live             | `SALES_AGENTS` addon SKU → `flag.sales_agents`; no plan grants it by default                                                                                                                                                                                         |
| MSRP overrides on a customer's price rows                       | `MSRP` addon SKU → `flag.msrp`, enforced unconditionally (outside the enforcement kill switch)                                                                                                                                                                       |
| Whether customers can be invited to a self-service buyer portal | A `BUYER_PORTAL` flag exists in `plan-catalog.constants.ts` but the SKU was deliberately retired (`publish-plan-catalog-v11.ts:12-23`) — the flag is granted by the plan definition itself, not billed separately, and no route enforces it                          |
| Whether customers carry regulated licences at all               | Mixed — the customer-side authorization endpoints are deliberately ungated ("generic feature"); the product/category side is gated by the `REGULATED_ITEMS`/`tobacco_dealer` addon                                                                                   |
| Default payment terms and deposit policy                        | tenant SystemConfig invoice settings as the default; `Customer.defaultPaymentTerms`/`defaultDepositPercent` win per account, `''` falls back to tenant default                                                                                                       |
| Whether a customer is routed or shipped                         | `Customer.fulfillPath` as the per-customer default; which delivery surfaces exist at all is the `RECURRING_ROUTES_ADDON`/`ORDER_DELIVERY_ADDON` split                                                                                                                |
| What kinds of customer a tenant distinguishes                   | **NOT CONFIGURABLE** — free-text `Customer.customerType` with only `@MaxLength(40)`, no tenant-defined list                                                                                                                                                          |
| Address kinds (billing vs shipping vs warehouse)                | Largely **NOT CONFIGURABLE** for addresses added at customer-create time (silently forced to BILLING); `addAddress()` on an existing customer does honour a passed `addressType`, and `updateAddress()` honours it too — it is a free string with no enum either way |
| Trading currency per customer                                   | **NOT WIRED** — `Customer.currency` is written but has no reader anywhere in the API; invoices/statements/payment requests use the tenant config currency instead                                                                                                    |

## Gaps for a great UX

| Severity | Gap                                                                                                                                                                                        | Impact                                                                                                                                                                                                                                                                             | Suggested direction                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | `PATCH /customers/me` accepts the full `UpdateCustomerDto`, so a CUSTOMER-role login can rewrite creditLimit, pricingTier, isTaxExempt, taxId, defaultPaymentTerms, defaultDepositPercent. | A customer with portal/app credentials can drop themselves to the cheapest tier, raise their own credit limit and mark themselves tax-exempt; every later order prices and taxes off those values. The identical hole was found and fixed on the buyer path (F4-001) but not here. | Introduce `UpdateMyCustomerProfileDto` mirroring `UpdateBuyerProfileDto`'s allowlist, bind it to `PATCH /customers/me`, add a Jest spec per forbidden key plus a reflection spec that fails if the two self-service DTOs diverge again.             |
| CRITICAL | `DELETE /api/v1/customers/all` hard-deletes every customer, including PAID invoices, payments, credit notes, returns, orders and transactions, with no guard, from any OPERATOR token.     | One request destroys the tenant's entire sales and receivables history irrecoverably. `batchDelete()` immediately above has a PAID/SENT pre-flight; this route has none.                                                                                                           | Delete the endpoint, or hold it to the `batchDelete` bar (refuse if any PAID/SENT invoice exists), require an explicit confirmation token, log an audit row, and gate behind SUPER_ADMIN plus `assertTestTenant` per the destructive-script policy. |
| HIGH     | Credit limit is checked only on order edit and change-request approval, never on order create.                                                                                             | A rep can create an unlimited new order for a maxed-out customer; only a subsequent edit trips the guard, defeating the purpose of a credit limit.                                                                                                                                 | Call `assertWithinCreditLimit` inside `orders.service.ts create()` (and `createSale`) using the same exposure derivation; no behaviour change when `creditLimit` is null.                                                                           |
| HIGH     | "Send Portal Invite" sends nothing — the token and URL are only returned in a message string; no email/SMS template exists.                                                                | Operators believe the customer received an invite; adoption silently stalls and the seller blames the buyer. The SMS invite method does nothing at all.                                                                                                                            | Wire the existing EmailService with a portal-invite template, or relabel to "Create invite link" with an explicit copy affordance.                                                                                                                  |
| HIGH     | Customer messaging (WhatsApp/SMS) can never fire — consent flags default false and nothing writes them; the provider is a stub.                                                            | Any feature built on `notify()`/`notifyEvent()` is dark on arrival for every tenant, the same shape as the earlier `addon.ocr` outage.                                                                                                                                             | Add consent capture (operator toggle and/or buyer opt-in) that stamps `consentUpdatedAt` and records the channel before swapping in a real provider.                                                                                                |
| MEDIUM   | `GET /customers/export` uses a different filter than `GET /customers` — it omits `supplierOnly:false` and `deletedAt:null`.                                                                | The CSV handed to a bank or accountant contains deleted customers and vendor-only contacts the screen hides, and never reconciles with the on-screen total.                                                                                                                        | Extract one shared where-builder for `findAll()` and `exportCustomers()`; assert exported row count equals `meta.total`.                                                                                                                            |
| MEDIUM   | No dormancy/churn/at-risk view for customer accounts.                                                                                                                                      | Losing a weekly account is the most expensive silent event in distribution and nothing notices; the only related report is a revenue ranking a fading account can still top.                                                                                                       | Add a report — days since last order, trailing-12mo revenue, frequency trend — sourced from invoiced sales, not the unwritten `StockMovement SALE` type, plus a list filter.                                                                        |
| MEDIUM   | No tenant-visible activity history on a customer; AuditLog is readable only in the platform-admin panel.                                                                                   | When a customer disputes a price or balance, the operator has no way to answer "who changed this and when" beyond free-text comments.                                                                                                                                              | Add a tenant-scoped, read-only activity tab over existing AuditLog rows for `entityType 'customers'` plus child entities, rendering actions not raw bodies.                                                                                         |
| MEDIUM   | No per-customer catalogue/assortment control beyond the regulated licence gate.                                                                                                            | A distributor cannot honour an exclusivity deal, hide a discontinued line from one chain, or restrict a franchise account's SKU list.                                                                                                                                              | Add an optional allow/deny list composing with (never replacing) the regulated gate, applied uniformly across buyer catalogue, search, replenishment and the operator order builder.                                                                |
| MEDIUM   | `Customer.currency` is written but never read anywhere in the API.                                                                                                                         | A tenant that sets a customer to CAD or MXN gets a value that changes nothing — invoices/statements/payment requests still use the tenant default currency.                                                                                                                        | Either remove the field, or make it authoritative for that customer's money surfaces, with a rule for what happens to an account whose currency changes mid-history.                                                                                |
| MEDIUM   | Delivery windows are two unvalidated free-text strings on the customer, not the address, and unsettable at create time.                                                                    | An account with a shop and a warehouse gets one window for both; unparseable values ("25:99", "after 10am") reach downstream routing; the operator must save twice to set one at all.                                                                                              | Move the window to `CustomerAddress`, validate as `HH:mm`, and add the fields to `CreateCustomerDto`, keeping the customer-level value as a fallback.                                                                                               |
| MEDIUM   | No duplicate detection at customer creation; the only defence is a manual two-row merge discovered later.                                                                                  | Phone orders plus a CSV import reliably produce two rows for the same shop; until noticed, prices, credit exposure and statement are split, and the credit-limit guard under-counts exposure.                                                                                      | Add a bounded, tenant-scoped candidate lookup on businessName prefix and phone equality that warns with a link and never blocks, reusing the existing merge path.                                                                                   |
| LOW      | `findOne()` does not exclude soft-deleted customers.                                                                                                                                       | A deleted customer stays reachable by direct URL and renders as a normal, fully editable record.                                                                                                                                                                                   | Add a `deletedAt` guard to `findOne`, or return it flagged as deleted with a read-only restore affordance.                                                                                                                                          |

## Cross-domain handoffs

- **Orders** — `Customer.fulfillPath` seeds `Order.fulfillPath` at create; `pricingTier` + `CustomerPrice` +
  promotions resolve every line price (`resolveBuyerLinePrice()`); `getCustomerPriceHistory()`
  supplies the remembered last-given price when scanning; `assertWithinCreditLimit()` reads
  `Customer.creditLimit`.
- **Invoices** — `defaultPaymentTerms`/`defaultDepositPercent` feed term/deposit resolution;
  `isTaxExempt`/`taxId` drive tax lines; the operator monthly statement PDF is the same
  StatementService/StatementPdfService the buyer portal uses.
- **Routes / Deliveries** — `CustomerAddress.lat/lng` are what `RouteStop`/`RouteRunStop` route to;
  `deleteAddress()` refuses when either references the address. All dispatch surfaces are
  addon-gated, so the customer page must degrade cleanly when they are off.
- **Buyer portal** — `CustomerLink` (`customerId @unique`) is the single link slot between a
  Customer and a BuyerAccount; invite/approve/decline/disconnect all mutate it; `GET/PATCH /buyer/me`
  read and write the same Customer row through `customersService.update()`.
- **Regulated compliance** — `CustomerAuthorization`/`AuthorizationOverride` gate buyer catalogue
  visibility and drive per-stop age/ID POD requirements; `mergeCustomers()` must re-point both
  before deleting the secondary or the licences cascade away.
- **Sales agents & finance** — `AgentAssignment` (one open row per customer) plus
  `CustomerCommissionRate` determine who earns on that customer's invoices; payouts book a
  COMMISSIONS_AND_FEES expense into P&L.
- **Billing & entitlements** — the `CUSTOMERS` meter counts customer rows and gates creation via a
  soft cap plus `CUSTOMER_PACK_100`; `flag.pricing_tiers`, `flag.credit_limits`, `flag.msrp` and
  `flag.sales_agents` each switch a slice of this domain on or off.
- **Import & migration** — `POST /import/contacts` creates customers through the same cap gate as
  single create; `Customer.zohoContactId` is the re-import identity key; `supplierOnly` and the
  orphan-adoption endpoints keep imported vendor contacts out of the Customers list.
- **Analytics & bookkeeping** — `GET /analytics/customers/top`, AR aging, balance summary and
  bad-debts reports all key on `customerId` and must agree with `getStatementForOperator`'s
  outstanding figure — the one authoritative balance derivation.
- **Messaging** — `MessageThread` is per customer; `MessageOptOut` is keyed
  `(tenantId, customerId, channel)`; sends read `Customer.phone/mobile/email` plus the two consent
  booleans (currently unwritable — see CRM-A4).
- **Inventory & replenishment** — `StockAlert` and `ReplenishmentSnooze` hang off Customer;
  `replenishment.service.ts estimates(customerId)` drives the buyer's "usuals" and its own
  catalogue count.

## What we could not verify

- No test suite was run, no UI was exercised, and no database was queried — statuses above are
  based on reading routes, services, Prisma models and screen files, not on execution.
- `apps/web/app/(dashboard)/customers/[id]/page.tsx` is roughly 180 KB; only the tab list, the
  sales-agent card, the portal-invite block and the Special Prices header were read in full, so a
  web-side control marked missing could exist elsewhere in that file.
- Mobile parity (CRM-N14) is inferred from the file listing and navigation targets, not from
  running the app — an absence there means "no screen file and no nav target found," not "proven
  absent."
- The credit-limit-at-create gap, the messaging-consent gap, the unenforced buyer-portal flag, and
  `Customer.currency` having no reader are all grep-based absences and are worth a second pair of
  eyes before anyone acts on them.
- The production value of the `PLAN_FLAG_ENFORCEMENT` env var was not verified — the code default
  is "off," meaning the credit-limit check currently runs for everyone regardless of plan, but a
  deployed "on" would change that.
- It was not verified whether the two CRITICAL findings (open credit-limit-at-create,
  `DELETE /customers/all`) are already tracked in the existing bug register — they match the shape
  of already-registered findings and may be duplicates rather than new discoveries.
- It was not verified whether a caller upstream of `sendPortalInvite` might dispatch the email
  itself — only `apps/api/src/email` was grepped for invite/portal templates and none was found.

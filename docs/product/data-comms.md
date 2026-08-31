# Data Onboarding, Import/Export, Documents & Communications

_How a tenant's existing book of business gets into RouteFlow, and how RouteFlow talks back to
customers and staff once it's live._

> **Note:** This domain's analysis needed heavy correction from an adversarial verification pass
> (three status corrections, one overstated claim downgraded, six understated/missed capabilities
> added) and is worth a second human pass before being treated as final.

## The problem

A wholesale distributor coming onto RouteFlow is carrying its whole business somewhere else:
customers and price lists in an accounting package, stock counts in a spreadsheet, open invoices
on paper, supplier bills in a shoebox. Re-keying that by hand takes weeks, and the moment the new
system restarts invoice numbering at 0001 the customer's statement stops reconciling with what
they already have on file. Once live, the same business still produces documents and messages by
hand — printing an invoice, photographing it into WhatsApp, phoning to say the van is coming,
chasing a payment from memory — so nothing is filed, nothing is provable, and every supplier bill
gets typed into stock twice.

## Why it matters to a tenant

Six CSV importers plus an AI scan queue move a book of business in a working session instead of a
fortnight: 20,000 rows per file, suppliers auto-created from vendor names, and scanned supplier
invoices posted straight through to stock and cost. Branded invoice PDFs and monthly statements
generate on demand from stored totals, so the document a customer sees always matches the ledger.
Email leaves from the tenant's own mailbox or verified domain with replies routed back to them,
and the send is honest — a failed or unconfigured mail server leaves the invoice DRAFT with a 400
rather than silently marking it SENT. Push notifications to customer and driver phones are wired
and live for order status and delivery events, even though the newer WhatsApp/SMS rules matrix
cannot yet deliver on any channel.

## Core use cases

1. **Bring the existing book of business in** — load customers, catalog, stock on hand, open
   invoices and payment history from the previous system, keep the old document numbers, and be
   able to tell what an import created.
2. **Produce and deliver the document the other side needs** — turn stored records into a branded
   invoice PDF, a monthly statement, a packing list, or proof of delivery, store it safely, and
   get it to the customer, the buyer portal, or a regulator.
3. **Tell the customer something happened** — confirm an order, say the van is out, flag a change
   at the door, chase a payment — automatically, on a channel the customer actually reads, with a
   record of what was sent.

## Must have (P0)

| ID      | Capability                                                               | Status     | What it does                                                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ONB-M1  | Customer / contact CSV import                                            | PARTIAL 🟡 | Upload a contacts CSV, get customers, addresses, contact people and portal-ready user rows with per-row skip/error reporting.                   | `POST /api/v1/import/contacts` → `import.service.ts:196`; hardcoded Zoho headers with a tiny fallback list; `parseCsv` does not pass `bom: true`, so an Excel "CSV UTF-8" export breaks the first header key (register B112).                                                                                                                                                                                                                                                                          |
| ONB-M2  | Product catalog + opening stock import                                   | PARTIAL 🟡 | Load the sellable catalog and current stock so the tenant can take orders day one.                                                              | `POST /api/v1/import/products` (`import.service.ts:1378`) drops barcode/unitsPerBox/cost/category/tax; `POST /api/v1/import/inventory` (`:1438`) writes a StockMovement only on UPDATE, not CREATE, and prices new rows at 0.                                                                                                                                                                                                                                                                          |
| ONB-M3  | Open invoices + payment history import (opening AR)                      | PARTIAL 🟡 | Load unpaid/historical invoices with lines and payments already received.                                                                       | `POST /api/v1/import/invoices` (`import.service.ts:513`) and `/import/payments` (`:815`) keep original invoice numbers by design but stamp no batch id and support no rollback.                                                                                                                                                                                                                                                                                                                        |
| ONB-M4  | Document-numbering continuity after migration                            | BROKEN 🔴  | Tenant sets "next invoice = 8842" so numbering doesn't restart mid-relationship.                                                                | Settings surface and `NumberingSequence` store exist (`numbering.controller.ts`, `numbering.service.ts`) but live minting never calls them — `InvoicesService.generateInvoiceNumber` (`invoices.service.ts:2723`) hardcodes `INV-<year>-NNNN` against the unscoped Prisma client.                                                                                                                                                                                                                      |
| ONB-M5  | Import safety net — reversibility and audit                              | PARTIAL 🟡 | See what an import created and undo it; know who ran it.                                                                                        | Only expenses carry `importBatchId` and a rollback endpoint (`import.service.ts:959,1133`; `import.controller.ts:63,82`). No AuditService call anywhere in `apps/api/src/import`. Migration hub has real 24h undo but commits only PRODUCT/SUPPLIER.                                                                                                                                                                                                                                                   |
| ONB-M6  | Branded invoice PDF on demand                                            | SHIPPED ✅ | Any invoice renders as a PDF with tenant logo, colours, address, remittance details and DRAFT/FINAL watermark.                                  | `GET /api/v1/invoices/:id/pdf` → `InvoicePdfService` (`invoice-pdf.service.ts:24,36`); buyer twin at `buyer.controller.ts:223`.                                                                                                                                                                                                                                                                                                                                                                        |
| ONB-M7  | Send an invoice to the customer by email — honestly                      | SHIPPED ✅ | Emailing an invoice either delivers and flips it to SENT, or fails loudly and stays DRAFT.                                                      | `POST /invoices/:id/send-email` / `/send-reminder` → `EmailService.sendInvoice` (`email.service.ts:661`) returning `{delivered, transport, id?, error?}`; pre-flight 400s before the DRAFT→SENT flip.                                                                                                                                                                                                                                                                                                  |
| ONB-M8  | Tenant sending identity — BYO SMTP or verified domain                    | SHIPPED ✅ | Mail goes out from the tenant's own mailbox or verified domain with replies routed to them.                                                     | `/settings/email`, `/settings/email/test`, `/settings/email/domain` (`settings.controller.ts:227-355`); real pre-save SMTP handshake with provider-specific guidance; secrets encrypted via `SECRET_KEYS`.                                                                                                                                                                                                                                                                                             |
| ONB-M9  | Tenant-scoped document storage with time-limited links                   | SHIPPED ✅ | Every uploaded/generated file is stored once and reachable only by someone entitled to it.                                                      | `StorageService` (R2 or local volume with HMAC-signed URLs); `GET /uploads/*path` behind `UploadsAccessGuard` with a seven-entry owner-lookup map (`uploads.controller.ts:61-101`) — note: not eight, as an earlier draft claimed.                                                                                                                                                                                                                                                                     |
| ONB-M10 | Attach documents to a customer record                                    | SHIPPED ✅ | Store a customer's licence, resale certificate or credit application and pull it up later.                                                      | `/customers/:id/documents` and `/customers/:id/tax-documents` (`customers.controller.ts:483,489,539,431,437,474`); strict MIME allowlist; mobile documents and licences screens both exist.                                                                                                                                                                                                                                                                                                            |
| ONB-M11 | Monthly customer statement as a PDF                                      | SHIPPED ✅ | Operator and buyer both pull a month's statement that reconciles to the cent.                                                                   | `StatementService.buildMonthlyStatement` + `StatementPdfService`; web, buyer, and mobile surfaces (`statements/index.tsx`, `customers/[id]/statement.tsx`) plus a browser print view.                                                                                                                                                                                                                                                                                                                  |
| ONB-M12 | Get your data back out                                                   | PARTIAL 🟡 | Export a tenant's own records without a database dump.                                                                                          | `/customers/export` and `/invoices/payments/export` exist server-side; **verified:** invoice and order CSV exports also exist client-side (`apps/web/lib/export.ts`, invoices/orders pages) plus a finance-reports export, but all are capped at 1000 rows (`EXPORT_LIMIT`) and the customers export ignores list filters (register B158) — no product/inventory/supplier export exists.                                                                                                               |
| ONB-M13 | Push notifications to customer and driver devices                        | SHIPPED ✅ | Order-status and delivery events reach the customer's and driver's phone, not just an internal log.                                             | `POST /notifications/register-token`, `/notifications/test`, `/notifications/status` (`notifications.controller.ts:15,23,28,33`); `NotificationsService.sendToUser/sendToCustomer/sendToDriver` fired from `orders.service.ts:2360`, `routes.service.ts:988`, `change-requests.service.ts:413`, `order-templates.service.ts:423`, `stock-alert.service.ts:117`, `authorization-expiry.service.ts:203,207`; mobile registers tokens at `apps/mobile/lib/auth.ts:135`. _(missedCapabilities, tier MUST)_ |
| ONB-M14 | Proof-of-delivery capture (signature + photo)                            | SHIPPED ✅ | A driver captures a signature and/or photo against a stop as delivery evidence.                                                                 | `POST /route-runs/:id/stops/:stopId/pod-artifact` (`routes.controller.ts:225`); driver capture screens `apps/mobile/app/(driver)/route/stop/[stopId]/signature.tsx` and `photo.tsx`. _(missedCapabilities, tier MUST)_                                                                                                                                                                                                                                                                                 |
| ONB-M15 | Import repair / diagnostic and cross-tenant adoption endpoints           | SHIPPED ✅ | Fix up prior imports and re-parent orphaned customer rows into the caller's tenant.                                                             | `POST /import/expense-suppliers`, `/import/expenses/repair-inventory`, `/import/contacts/mark-supplier-only`, `GET /import/contacts/orphans`, `POST /import/contacts/adopt-orphans` (`import.controller.ts:70,101,116,127,138`). `adopt-orphans` re-parents customers across tenants with no dry-run, no batch id, no audit entry — a materially riskier write than the six main importers. _(missedCapabilities, tier MUST)_                                                                          |
| ONB-M16 | Transactional email beyond invoices (auth, buyer identity, provisioning) | SHIPPED ✅ | Password resets, buyer email verification/merge, tenant provisioning and platform billing mail all ride the same honest-by-result EmailService. | `auth.service.ts:434`, `buyer-auth.service.ts:110`, `buyer-merge.service.ts:85,442`, `tenants.service.ts:154,206`, `platform-admin.service.ts:300,1337`, `billing.service.ts:630`. _(missedCapabilities, tier MUST)_                                                                                                                                                                                                                                                                                   |

### Testing criteria

#### ONB-M1

- [ ] Jest (api, import.service.spec): a CSV whose first header carries a UTF-8 BOM must not skip every row on `row["Display Name"] === undefined`. `Jest`
- [ ] Jest (api, import.security.spec.ts:62): a 20,001-row file is rejected with a 400 naming the limit; zero Customer rows written. `Jest`
- [ ] Jest (api): a row whose "Contact Type" is "vendor" increments `skipped` and creates no Customer. `Jest`
- [ ] Jest (api, import-customer-cap.spec.ts:37): a tenant over the CUSTOMERS cap with an expired grace window throws before the first row. `Jest`
- [ ] Playwright (web): uploading the same 3-row CSV twice reports 0 created / 3 skipped the second time, isolated per tenant. `Playwright`

#### ONB-M2

- [ ] Jest (api): STOCK INVARIANT — after `importInventory` creates a new product, Σ StockMovement.quantity equals `Product.currentStock` (today the sum is 0 while stock is set). `Jest`
- [ ] Jest (api): a product created by `importInventory` is never sellable at `pricePerUnit: 0` without `isActive:false`. `Jest`
- [ ] Jest (api): a boxed catalog row imports with `unitsPerBox` set; a null-`unitsPerBox` product never hits the boxed pricing path. `Jest`
- [ ] Jest (api): a legitimate product like "Purchase Pack 6" with no SKU survives the summary-row heuristic (`import.service.ts:1473-1481`). `Jest`
- [ ] Jest (api): TENANT ISOLATION — re-importing the same product names in tenant B creates B's own rows only. `Jest`

#### ONB-M3

- [ ] Jest (api): MONEY INVARIANT — `roundMoney(Σ item.subtotal) + tax − discount === invoice.total` for every imported invoice. `Jest`
- [ ] Jest (api): re-running the same invoice CSV creates zero duplicate Invoice/InvoicePayment rows. `Jest`
- [ ] Jest (api): a row referencing an unknown customer creates exactly one Customer+User; a second row reuses it. `Jest`
- [ ] Jest (api): after importing invoices then payments, the customer statement's outstanding equals Σ invoices − Σ non-VOID payments. `Jest`
- [ ] Jest (api, import.security.spec.ts:44): a malformed row's error message carries no Prisma table/column names. `Jest`

#### ONB-M4

- [ ] Jest (api, invoices.service.spec): setting NumberingSequence prefix/next/padding and creating an invoice must produce that number, not `INV-<year>-0001`. `Jest`
- [ ] Jest (api): TENANT ISOLATION — tenant B's first invoice is `INV-2026-0001` regardless of tenant A's sequence. `Jest`
- [ ] Jest (api, numbering.service.spec): `reserveNext` under concurrent callers issues distinct numbers and throws at the 10k collision cap. `Jest`
- [ ] Jest (api): an imported invoice keeps its original number and does not advance the live sequence. `Jest`
- [ ] Playwright (web): save numbering settings, create an invoice, and read the number off the detail page. `Playwright`

#### ONB-M5

- [ ] Jest (api): an operator can list and reverse the customers a single `importContacts` run created — assert the gap or the fix. `Jest`
- [ ] Jest (api): `rollbackExpenseBatch` is idempotent — a second call rolls back nothing further. `Jest`
- [ ] Jest (api, migration.service.spec): `undoJob` deletes exactly the rows the job created and drops their `ImportExternalRef` entries. `Jest`
- [ ] Jest (api): `confirmJob` on staged CUSTOMER/INVOICE/PAYMENT records marks them SKIPPED "commit-not-wired" rather than reporting them committed. `Jest`
- [ ] Jest (api): every import endpoint writes an AuditLog row naming actor, entity type and row count — currently MISSING. `Jest`

#### ONB-M6

- [ ] Jest (api): MONEY INVARIANT — balance due equals `total − Σ(payments where status ≠ VOID)`, rounded to cents. `Jest`
- [ ] Jest (api): a deposit invoice renders `depositAmount = roundMoney(total × depositPercent / 100)`, or nothing when null. `Jest`
- [ ] Jest (api, invoice-pdf-variant.spec.ts): a DRAFT invoice renders the DRAFT variant/watermark; SENT renders FINAL. `Jest`
- [ ] Jest (api): a missing logo key never causes a 500 — the download failure is swallowed. `Jest`
- [ ] Playwright (web): requesting another tenant's invoice PDF returns 404/403 before any document is produced. `Playwright`

#### ONB-M7

- [ ] Jest (api): with no SMTP/Resend key, send returns 400 `EMAIL_NOT_CONFIGURED` and the invoice stays DRAFT. `Jest`
- [ ] Jest (api): when SMTP and Resend both fail, the response is 400 `EMAIL_SEND_FAILED` with no `sentAt` stamped. `Jest`
- [ ] Jest (api): a `@placeholder.local` sentinel address returns 400 "No email address on file" with no send attempted. `Jest`
- [ ] Jest (api): SMTP failure rescued by Resend still marks the invoice SENT and carries `smtpFallbackReason`. `Jest`
- [ ] Jest (api, recurring-invoices.service.spec): `autoSend` leaves the invoice DRAFT on failure rather than a dishonest SENT. `Jest`

#### ONB-M8

- [ ] Jest (api): changing `smtpHost`/`smtpUser` without a new password clears the stored password rather than replaying it elsewhere. `Jest`
- [ ] Jest (api): a blank password on verify falls back to the saved one only when host/user are unchanged. `Jest`
- [ ] Jest (api): a port-587 host without STARTTLS fails verification without ever sending the password in cleartext. `Jest`
- [ ] Jest (api): a private/link-local SMTP host is refused by `assertSafeSmtpEndpoint`, returned as `delivered:false`, never thrown. `Jest`
- [ ] Playwright (web): Settings → Email shows "ready" for platform-transport-only tenants and the Test button is enabled. `Playwright`

#### ONB-M9

- [ ] Jest (api): a tenant-B JWT fetching a tenant-A key gets 403; a valid signed URL for that key still resolves. `Jest`
- [ ] Jest (api): a key containing `..` or `%2e%2e` is rejected 404 before any owner lookup runs. `Jest`
- [ ] Jest (api): an expired or tampered signature fails via `timingSafeEqual`. `Jest`
- [ ] Jest (api): SVG/HTML files serve with `Content-Disposition: attachment` and `nosniff`, never inline. `Jest`
- [ ] Jest (api): an unknown or deleted owner id 403s rather than falling through to a file read. `Jest`

#### ONB-M10

- [ ] Jest (api): uploading a `.svg`/`.exe` returns 400 naming allowed types and stores nothing. `Jest`
- [ ] Jest (api): listing another tenant's customer documents returns 404/403 with no presigned URL emitted. `Jest`
- [ ] Jest (api): deleting a document removes both the DB row and storage object, idempotently. `Jest`
- [ ] Jest (api, authorization-expiry.service.spec): an expiring licence fires `LICENSE_EXPIRING` exactly once per bucket. `Jest`
- [ ] Playwright (web): a stored PDF opens inline and the URL stops working once the signature expires. `Playwright`

#### ONB-M11

- [ ] Jest (api, statement.service.spec): MONEY INVARIANT — `opening + charges − payments − credits + adjustments === closing` to the cent. `Jest`
- [ ] Jest (api): a VOID payment is excluded from both closing balance and activity lines. `Jest`
- [ ] Jest (api): CREDIT_NOTE/ADVANCE lands in credits, CASH in payments, each counted once. `Jest`
- [ ] Jest (api): a malformed month ("2026-13") returns 400 and generates no PDF. `Jest`
- [ ] Jest (api): a buyer not ACTIVELY linked to a customer gets 403 requesting that customer's statement month. `Jest`

#### ONB-M12

- [ ] Jest (api): `/customers/export` returns exactly the rows the equivalent list returns — soft-deleted and supplier-only rows excluded (B158). `Jest`
- [ ] Jest (api): export → `importContacts` round-trips losslessly and the file is BOM-prefixed UTF-8. `Jest`
- [ ] Jest (api): TENANT ISOLATION — an operator's export contains zero rows from another tenant. `Jest`
- [ ] Manual: exporting invoices/orders past the 1000-row `EXPORT_LIMIT` does not silently truncate without warning the operator. `Manual`
- [ ] Jest (api): a product/inventory/supplier export exists including `unitsPerBox` and line amounts — currently MISSING; assert the gap. `Jest`

#### ONB-M13

- [ ] Jest (api): a status-change push to a customer fires only for the events wired (CONFIRMED / OUT_FOR_DELIVERY / DELIVERED / CANCELLED). `Jest`
- [ ] Jest (api): `NotificationsService.isConfigured()` reflects real Firebase init state rather than being hardcoded true (register B181). `Jest`
- [ ] Jest (api): a driver push fires on route assignment/update and is tenant/driver scoped. `Jest`
- [ ] Playwright (mobile): a registered device token receives a test push from Settings. `Manual`

#### ONB-M14

- [ ] Jest (api): a POD artifact upload is tenant-scoped and rejects a non-image/non-allowed MIME type. `Jest`
- [ ] Jest (api): reopening a stop nulls or preserves POD keys consistently and never orphans the storage object (register B120). `Jest`
- [ ] Playwright (mobile): capturing a signature then a photo both attach to the same stop and are visible on the web dispatch view. `Manual`

#### ONB-M15

- [ ] Jest (api): `adopt-orphans` writes an audit trail of what it re-parented — currently MISSING. `Jest`
- [ ] Jest (api): `adopt-orphans` offers a dry-run before committing — currently MISSING. `Jest`
- [ ] Jest (api): `repair-inventory` is idempotent — re-running it twice produces the same StockMovement state. `Jest`

#### ONB-M16

- [ ] Jest (api): a password-reset email failure surfaces a clear error rather than a 500 or a false "check your email". `Jest`
- [ ] Jest (api): buyer-merge verification rolls back cleanly when the confirmation email fails to send. `Jest`
- [ ] Jest (api): tenant-provisioning email failure does not block tenant creation from completing. `Jest`

## Nice to have (P1)

| ID      | Capability                                                                        | Status     | What it does                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | --------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ONB-N1  | Batch supplier-invoice scan queue (AI OCR)                                        | SHIPPED ✅ | Scan a stack of supplier invoices, review exceptions, post all at once — creating vendor bills and receiving stock/cost.              | `/import/batch*` (`batch.controller.ts`) → `BatchImportService`; reuses `VendorBillsService.scanInvoice` (model claude-haiku-4-5).                                                                                                                                                                                                                                                                   |
| ONB-N2  | Duplicate supplier-bill detection                                                 | SHIPPED ✅ | Catches an already-entered supplier invoice instead of double-counting stock and cost.                                                | `DuplicateMatchService.findVendorBillDuplicate` — exact, legacy-regex, and supplier-scoped fuzzy layers; consumed by both the vendor-bill create path and batch import.                                                                                                                                                                                                                              |
| ONB-N3  | Learned supplier-text → product aliases                                           | PARTIAL 🟡 | Once mapped, a supplier's line text auto-resolves to a product next time.                                                             | `ProductAliasService` + `/import/aliases`; learning wired from batch review, but no UI surface exists to find/edit/delete a wrong alias.                                                                                                                                                                                                                                                             |
| ONB-N4  | Unknown-item resolution and a Finish-setup queue                                  | PARTIAL 🟡 | Resolve a scanned/imported line naming an unknown product as a variant, brand-new item, or match; unfinished items queue for pricing. | **verified:** only the Finish-setup tail (`useIncompleteProducts`/`useCompleteSetup`) is reachable from any UI (`settings/import/page.tsx:29-33`). `useCreateVariant`/`useCreateBrandNew`/`useMatchExisting` have zero UI callers — `BatchItemReviewModal.tsx` uses a different picker/modal instead — so `/import/resolution/variant`, `/brand-new`, `/match` are API-only dead ends.               |
| ONB-N5  | Migration hub — stage, review, confirm, 24h undo                                  | PARTIAL 🟡 | A migration run stages rows, flags duplicates, commits on confirm, reversible for 24h.                                                | `/import/migration*` (gated `flag.import_integrations`); `commit()` handles only PRODUCT and SUPPLIER — CUSTOMER/INVOICE/PAYMENT are marked SKIPPED "commit-not-wired".                                                                                                                                                                                                                              |
| ONB-N6  | Column mapping for an arbitrary CSV                                               | MISSING ⬜ | Upload any CSV, see detected headers, map each to a RouteFlow field.                                                                  | Every importer reads fixed header strings; web page is titled "Import from Zoho"; no mapping model, endpoint or screen exists.                                                                                                                                                                                                                                                                       |
| ONB-N7  | Pre-commit preview / dry run                                                      | MISSING ⬜ | Show created/updated/skipped counts and offending rows before anything is written.                                                    | All six upload endpoints write immediately; only the migration hub has a stage-then-confirm shape, and it commits only PRODUCT/SUPPLIER.                                                                                                                                                                                                                                                             |
| ONB-N8  | Downloadable CSV templates and a per-import error file                            | MISSING ⬜ | Give the exact expected file shape, and hand back just the failed rows to fix and re-upload.                                          | No template download and no error-file download exist; errors are a bare `string[]` with no row numbers.                                                                                                                                                                                                                                                                                             |
| ONB-N9  | Notification rules matrix with editable templates                                 | PARTIAL 🟡 | Choose which events notify customers on which channel, edit `{{variable}}` wording, preview, set quiet hours.                         | **verified:** matrix is real (`/messaging/config`, `/messaging/rules/:id`, `/messaging/templates/:id`) but seeding is lazy/private (only via `GET /messaging/config`, so an unopened tenant fires nothing), quiet hours are computed but discarded, and `usesProvider()` treats EMAIL as a provider channel so the default-ON `INVOICE_SENT × EMAIL` cell dispatches to the stub and records "sent". |
| ONB-N10 | Quiet hours                                                                       | BROKEN 🔴  | Messages are held overnight rather than delivered.                                                                                    | `MessagingSettings` and `isQuietHours` are computed into a `wouldBeQuiet` flag but the message dispatches anyway — no queue, scheduler or retry exists (register B160).                                                                                                                                                                                                                              |
| ONB-N11 | Customer consent capture for SMS / WhatsApp                                       | MISSING ⬜ | A customer opts in/out of text/WhatsApp somewhere in the product.                                                                     | The consent gate fails closed correctly (`waConsent`/`smsConsent`/`MessageOptOut` checked at send time) but no endpoint, DTO or UI writes those fields anywhere (register B183).                                                                                                                                                                                                                     |
| ONB-N12 | The document travels with the email                                               | MISSING ⬜ | The invoice PDF is attached to the email, or a link that still works next week.                                                       | `send()` accepts no attachment; the "Download PDF" link is signed for 1 hour on local storage, and hardcoded to `GET_EXPIRY_SECONDS = 3600` on R2 regardless of the tenant setting; an unset signing secret returns an **unsigned** URL that then 401s behind the JWT gate.                                                                                                                          |
| ONB-N13 | Documents for the rest of the paperwork — estimates, credit notes, delivery notes | PARTIAL 🟡 | Quotes, credit notes and packing slips print/email the same way invoices do.                                                          | **verified:** packing lists ARE shipped — `GET /routes/:id/packing-list` and `/route-runs/:id/packing-list` back a print-styled web dispatch sheet and a mobile packing-list screen. Estimates and credit notes remain genuinely absent: `POST /estimates/:id/send` only flips status to SENT; `CreditNotesController` has no pdf/send route at all.                                                 |
| ONB-N14 | Automated payment reminders (dunning)                                             | MISSING ⬜ | Overdue invoices chase themselves on a schedule, escalating automatically.                                                            | Only a manual one-shot `/invoices/:id/send-reminder` exists; `PAYMENT_REMINDER` has a default template but nothing fires it on a schedule.                                                                                                                                                                                                                                                           |
| ONB-N15 | Customer communication history the operator can see                               | MISSING ⬜ | Open a customer and see every message/document sent, on which channel, whether it landed.                                             | `MessageThread`/`Message` models and thin read endpoints exist; no web or mobile UI consumes them, and the real invoice email is not logged into this feed at all.                                                                                                                                                                                                                                   |
| ONB-N16 | Supplier-statement AI scan, review and one-shot apply                             | SHIPPED ✅ | Scan a supplier statement, review matches, apply in one transaction.                                                                  | `/supplier-statements*` (`@RequireAddon("ocr")`, up to 10 files/25MB each); independent Anthropic call with its own `recordAiUsage`; `StatementApplyService` applies idempotently. _(missedCapabilities, tier NICE)_                                                                                                                                                                                 |
| ONB-N17 | Expense-receipt line extraction (OCR) in bookkeeping                              | SHIPPED ✅ | Extract line items from a scanned expense receipt.                                                                                    | `POST /bookkeeping/expenses/:id/extract-items` (`@RequireAddon("ocr")`); independent Anthropic call with its own `recordAiUsage`. _(missedCapabilities, tier NICE)_                                                                                                                                                                                                                                  |
| ONB-N18 | Per-tenant BYO Anthropic key with platform fallback                               | SHIPPED ✅ | A tenant can supply its own Anthropic key for AI document reading, falling back to the platform key.                                  | `/settings/anthropic` (GET/PATCH); key stored in `SECRET_KEYS`; resolved via `PlatformConfigService.resolveAnthropicKey`. _(missedCapabilities, tier NICE)_                                                                                                                                                                                                                                          |
| ONB-N19 | Manual ad-hoc customer message send and manual event fire                         | SHIPPED ✅ | Send a one-off message to a customer thread, or manually fire a notification event.                                                   | `POST /messaging/threads/:customerId/messages` and `POST /messaging/notify` (`messaging.controller.ts:49,66`), through the same consent/opt-out/metering path. _(missedCapabilities, tier NICE)_                                                                                                                                                                                                     |
| ONB-N20 | Run chat — driver/operator internal messaging                                     | SHIPPED ✅ | Drivers and operators message each other on a run.                                                                                    | `/messages` (`messages.controller.ts:26,31`); mobile screens `(operator)/messages.tsx` and `(driver)/driver-messages.tsx`. _(missedCapabilities, tier NICE)_                                                                                                                                                                                                                                         |
| ONB-N21 | Back-in-stock "notify me" subscriptions                                           | SHIPPED ✅ | A customer subscribes to be told when a product is restocked.                                                                         | `stock-alert.service.ts` — `subscribe()` upserts a `StockAlert`; `fireForProducts()` sends one push per PENDING alert after restock commits. _(missedCapabilities, tier NICE)_                                                                                                                                                                                                                       |
| ONB-N22 | Printable receipt and account-statement views                                     | SHIPPED ✅ | Print a payment receipt or a customer account statement from the browser.                                                             | `finance/payments/[id]/page.tsx:138-141` (window.print); `customers/[id]/page.tsx:3771`. _(missedCapabilities, tier NICE)_                                                                                                                                                                                                                                                                           |
| ONB-N23 | Tenant billing-data export                                                        | SHIPPED ✅ | Export subscription, usage and billing-event history even from a read-only account.                                                   | `GET /settings/billing/export` (`settings-billing.controller.ts:90`) → `SubscriptionService.getExport`, returning subscription, usage, and last 500 BillingEvents/RfInvoices. _(missedCapabilities, tier NICE)_                                                                                                                                                                                      |

### Testing criteria

#### ONB-N1

- [ ] Jest (api): STOCK INVARIANT — `postBatch` on a clean item receives stock exactly once; a second post of the same batch receives nothing further. `Jest`
- [ ] Jest (api): `resolveItem` throws unless every line is matched/reviewed and a detected supplier is linked. `Jest`
- [ ] Jest (api): an Anthropic call failure records `AiUsage{success:false}` and leaves the item FAILED without losing the batch. `Jest`
- [ ] Jest (api): `DUPLICATE_VENDOR_BILL` adopts the existing bill only when `matchedBy === "number"`; a fuzzy match stays DUPLICATE for a human. `Jest`
- [ ] Jest (api): a tenant without the `ocr` addon gets 403 from `POST /import/batch/:id/scan`. `Jest`

#### ONB-N2

- [ ] Jest (api): same invoice number under the same supplier returns `matchedBy: "number"` with the existing bill. `Jest`
- [ ] Jest (api): a bill owned by a different supplier with the same number is excluded. `Jest`
- [ ] Jest (api): a VOIDed prior bill is never returned as a duplicate. `Jest`
- [ ] Jest (api): a fuzzy match with no invoice number requires supplier AND date AND total all present. `Jest`
- [ ] Jest (api): line items are never compared, so an operator's edits during review still surface the flag. `Jest`

#### ONB-N3

- [ ] Jest (api, product-alias.service.spec): an alias learned for supplier S resolves under S; the `""` any-supplier alias applies only otherwise. `Jest`
- [ ] Jest (api): resolving an alias whose product was deleted returns null and self-heals by removing the row. `Jest`
- [ ] Jest (api): TENANT ISOLATION — an alias learned in tenant A never resolves in tenant B. `Jest`
- [ ] Jest (api): picking a product in batch review creates exactly one alias; re-picking creates no duplicate. `Jest`
- [ ] Playwright (web): an operator can find, edit and delete a wrong alias — currently MISSING. `Playwright`

#### ONB-N4

- [ ] Jest (api): `createVariant` inherits the parent family's unit/unitsPerBox/category/tax treatment. `Jest`
- [ ] Jest (api): MONEY INVARIANT — `createBrandNew` sets `pricePerUnit = roundMoney(cost × 1.3)` and `detailsIncomplete: true`. `Jest`
- [ ] Jest (api): `matchExisting` learns an alias so the same raw text auto-resolves next scan. `Jest`
- [ ] Jest (api): `completeSetup` clears `detailsIncomplete` only when a non-zero price is supplied. `Jest`
- [ ] Playwright (web): wire `useCreateVariant`/`useCreateBrandNew`/`useMatchExisting` into `BatchItemReviewModal` — currently no UI caller exists. `Playwright`

#### ONB-N5

- [ ] Jest (api, migration.service.spec): `confirmJob` then `undoJob` within 24h leaves zero created rows and zero `ImportExternalRef` entries. `Jest`
- [ ] Jest (api): `undoJob` past the deadline, or on an already-UNDONE job, is refused. `Jest`
- [ ] Jest (api): a staged PRODUCT whose externalId already has a ref is flagged DUPLICATE, not committed twice. `Jest`
- [ ] Jest (api): staging CUSTOMER rows and confirming returns `skipped > 0` with `commit-not-wired`; the UI must not report them imported. `Jest`
- [ ] Jest (api): a tenant without `flag.import_integrations` gets 403 on `/import/migration/*` while `/import/contacts` still works. `Jest`

#### ONB-N6

- [ ] Jest (api): an import with an explicit `{sourceHeader → field}` map lands its rows — no such parameter exists today. `Jest`
- [ ] Jest (api): an unplaceable header is reported back rather than silently dropped. `Jest`
- [ ] Playwright (web): map "Company"/"E-mail"/"Tel" onto businessName/email/phone and all rows import. `Playwright`
- [ ] Jest (api): a saved mapping is reusable and tenant-scoped. `Jest`

#### ONB-N7

- [ ] Jest (api): a dry-run flag returns the same counts/errors as a live run with zero DB writes. `Jest`
- [ ] Jest (api): the preview reports, per row, update-vs-create. `Jest`
- [ ] Playwright (web): a preview with errors offers a downloadable error file naming row numbers. `Playwright`

#### ONB-N8

- [ ] Playwright (web): each import card offers a "Download template" link that imports cleanly with zero errors. `Playwright`
- [ ] Jest (api): a failed row's error carries its 1-based CSV line number. `Jest`
- [ ] Playwright (web): downloading and re-uploading the error file imports exactly the previously-failed rows. `Playwright`

#### ONB-N9

- [ ] Jest (api): the first `GET /messaging/config` lazily seeds every rule+template pair via `createMany skipDuplicates`; a concurrent second call creates no duplicates. `Jest`
- [ ] Jest (api): matrix seeding runs at tenant provisioning, not only on first settings visit — currently MISSING. `Jest`
- [ ] Jest (api): `INVOICE_SENT × EMAIL` routes through `EmailService`, not the messaging stub. `Jest`
- [ ] Jest (api): an OPERATOR can read the matrix but gets 403 on `PATCH /messaging/rules/:id`. `Jest`

#### ONB-N10

- [ ] Jest (api, messaging.service.spec): with quiet hours 21:00-08:00 and now=23:30, `sendMessage` must not call the provider and must enqueue for the open window. `Jest`
- [ ] Jest (api): a held message dispatches exactly once when the window opens, never twice after a restart. `Jest`
- [ ] Jest (api): quiet hours evaluate in the tenant's timezone, not the server's. `Jest`
- [ ] Jest (api): INTERNAL-channel operator alerts are never held. `Jest`

#### ONB-N11

- [ ] Jest (api): an operator endpoint sets `waConsent`/`smsConsent` with `consentUpdatedAt` stamped — currently MISSING. `Jest`
- [ ] Jest (api): a customer-initiated STOP creates a `MessageOptOut` and subsequent sends on that channel are skipped. `Jest`
- [ ] Jest (api): sending with consent false returns `skipped: NO_CONSENT`, calls no provider, meters nothing. `Jest`
- [ ] Playwright (web): the customer edit form exposes SMS/WhatsApp consent toggles that survive a reload. `Playwright`

#### ONB-N12

- [ ] Jest (api): `sendInvoice` produces a message with a PDF MIME attachment matching the rendered invoice — no attachment path exists today. `Jest`
- [ ] Manual: opening an invoice email 24h after sending still loads the PDF link. `Manual`
- [ ] Jest (api): a configured CC/BCC address receives a copy of every invoice send. `Jest`
- [ ] Jest (api): an unset `storage.urlSigningSecret` never silently returns an unsigned URL that then 401s behind the JWT gate. `Jest`

#### ONB-N13

- [ ] Jest (api): `POST /estimates/:id/send` emails a branded estimate PDF, returning `delivered:false` honestly when mail is unconfigured. `Jest`
- [ ] Jest (api): MONEY INVARIANT — a credit-note PDF total equals the stored credit amount, and applied/remaining equal `amount − amountUsed`. `Jest`
- [ ] Jest (api): a packing list regenerates (not cached) when the underlying order changes. `Jest`
- [ ] Playwright (web): the estimate detail page offers Download PDF and Email, reflecting the current line set. `Playwright`

#### ONB-N14

- [ ] Jest (api): a cron fires `PAYMENT_REMINDER` for invoices N days past due, once per invoice per step, idempotent across re-runs. `Jest`
- [ ] Jest (api): MONEY INVARIANT — the reminder quotes `total − Σ non-VOID payments`, not the full total (register B102). `Jest`
- [ ] Jest (api): a PAID/VOID/WRITTEN_OFF/DRAFT invoice is never chased. `Jest`
- [ ] Jest (api): a reminder respects quiet hours and the customer's opt-out. `Jest`

#### ONB-N15

- [ ] Playwright (web): the customer detail page shows a chronological send feed — currently MISSING. `Playwright`
- [ ] Jest (api): `listThreads` returns only the calling tenant's threads, ordered by `lastMessageAt desc`. `Jest`
- [ ] Jest (api): an `INVOICE_SENT` email logged by `invoices.service` appears in the same feed as engine-sent messages (today they are separate paths). `Jest`

#### ONB-N16

- [ ] Jest (api): a tenant without the `ocr` addon gets 403 from `/supplier-statements/scan`. `Jest`
- [ ] Jest (api): `StatementApplyService.apply` is idempotent within one transaction. `Jest`
- [ ] Jest (api): a scan failure records `AiUsage{success:false}` without losing the queued statement. `Jest`

#### ONB-N17

- [ ] Jest (api): a tenant without the `ocr` addon gets 403 from `extract-items`. `Jest`
- [ ] Jest (api): extracted line items sum to the receipt total within rounding tolerance. `Jest`

#### ONB-N18

- [ ] Jest (api): a tenant-supplied Anthropic key is used in preference to the platform key when present. `Jest`
- [ ] Jest (api): the key is stored under `SECRET_KEYS` and never returned in plaintext by a GET. `Jest`

## Advanced / future (P2)

| ID      | Capability                                                    | Status     | What it does                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ONB-A1  | Real WhatsApp / SMS transport                                 | MISSING ⬜ | Customer notifications actually arrive on WhatsApp or SMS.                              | `MESSAGE_PROVIDER` is bound to `StubProvider`, which logs and returns a synthetic id; `usesProvider()` also misroutes EMAIL through the stub; `MeterKey.MSGS` increments even on a stub send.                                                                                                                                                                           |
| ONB-A2  | Two-way inbound messaging and triage                          | MISSING ⬜ | A customer's reply lands in an inbox, is routed, and can become a task.                 | `MessageThread`/`InboundTriage` models exist; no inbound webhook controller and no inbox UI exist.                                                                                                                                                                                                                                                                      |
| ONB-A3  | Outbound webhooks                                             | MISSING ⬜ | A tenant's own systems get notified on order/invoice/delivery events.                   | No `Webhook`/`WebhookDelivery` model exists; every `/webhook/` route is inbound Stripe only.                                                                                                                                                                                                                                                                            |
| ONB-A4  | Public REST API with tenant API keys (and SSO)                | MISSING ⬜ | A tenant's developers integrate programmatically via a scoped API key.                  | No `ApiKey` model; Swagger disabled in production; `flag.api_sso` is explicitly "RESERVED — no SSO implementation exists".                                                                                                                                                                                                                                              |
| ONB-A5  | Live OAuth connectors to Zoho Books / QuickBooks              | MISSING ⬜ | Connect the old accounting system once and pull records across, no CSV.                 | `SourceConnectorRegistry` maps to `OAuthConnectorStub`, whose fetch throws telling the user to upload a CSV instead.                                                                                                                                                                                                                                                    |
| ONB-A6  | Ongoing accounting sync (not just one-way migration)          | MISSING ⬜ | Invoices/payments/expenses flow to the tenant's accountant's system on a schedule.      | Import is strictly one-way and one-time; only two manual CSV exports exist.                                                                                                                                                                                                                                                                                             |
| ONB-A7  | Background worker for large imports and scan batches          | MISSING ⬜ | A 20k-row import or 50-file scan batch runs in the background with visible progress.    | Every importer runs inline in the HTTP request (web sets a 5-minute timeout); batch posting loops synchronously; Redis exists but is not used as a job queue.                                                                                                                                                                                                           |
| ONB-A8  | AI scan spend control — per-scan metering and cap enforcement | PARTIAL 🟡 | Each AI document read counts against a tenant's allowance, capped with a grace window.  | Cost IS recorded (`recordAiUsage`) and entitlement is boolean-gated by `@RequireAddon("ocr")`, but `MeterKey.SCANS` is never incremented in production code, so `scansIncluded` is inert. **verified:** no single chokepoint exists — vendor-bills, supplier-statements, bookkeeping and route-analysis each make independent Anthropic calls and must each be metered. |
| ONB-A9  | Document retention, storage quota and lifecycle               | MISSING ⬜ | Files age out or archive on a visible policy; no tenant can fill the disk for everyone. | No pruning job exists despite `InvoiceScan.fileKey` being documented as prunable; no per-tenant storage meter or quota check at upload.                                                                                                                                                                                                                                 |
| ONB-A10 | Backup and disaster recovery for uploaded documents           | MISSING ⬜ | If the upload volume is lost, files can be restored.                                    | Nightly backup covers the database only (`apps/db-backup`); the local Railway volume is the fallback storage backend with no replication.                                                                                                                                                                                                                               |
| ONB-A11 | EDI / e-invoicing for chain customers                         | MISSING ⬜ | Larger chains send POs and receive invoices over EDI/PEPPOL rather than PDF-by-email.   | No EDI/X12/EDIFACT/PEPPOL code exists anywhere in `apps/api/src`.                                                                                                                                                                                                                                                                                                       |
| ONB-A12 | A verifiable send log — who received what, when, did it land  | MISSING ⬜ | For any document/message, prove it was sent, to whom, when, and whether it bounced.     | `EmailService.send()` returns a result that nothing persists; no `EmailLog`/`MessageDelivery` model exists; bounce/complaint webhooks are not consumed.                                                                                                                                                                                                                 |

### Testing criteria

#### ONB-A1

- [ ] Jest (api): a real adapter dispatches to the vendor API; a vendor failure maps to `failed` with no Message row and no meter increment. `Jest`
- [ ] Jest (api): EMAIL-channel notifications route through `EmailService` and honour its `{delivered}` result. `Jest`
- [ ] Jest (api): BILLING INVARIANT — `MeterKey.MSGS` increments only after the provider confirms acceptance. `Jest`

#### ONB-A2

- [ ] Jest (api): a signed inbound webhook creates a Message plus an `InboundTriage` row; an invalid signature is rejected 401. `Jest`
- [ ] Jest (api): an inbound "STOP" creates a `MessageOptOut` and is not surfaced as a normal reply. `Jest`
- [ ] Jest (api): redelivery of the same provider message id is idempotent. `Jest`

#### ONB-A3

- [ ] Jest (api): registering an endpoint and firing `order.confirmed` POSTs a signed, replay-resistant payload. `Jest`
- [ ] Jest (api): a 5xx subscriber response retries with backoff and gives up after N attempts. `Jest`
- [ ] Jest (api): TENANT ISOLATION — a webhook never receives another tenant's events. `Jest`

#### ONB-A4

- [ ] Jest (api): a valid tenant API key resolves the same tenant scoping a user JWT would. `Jest`
- [ ] Jest (api): a revoked/expired key is rejected 401. `Jest`
- [ ] Jest (api): a read-only key is refused on any write verb. `Jest`

#### ONB-A5

- [ ] Jest (api): OAuth completion stores an encrypted, tenant-scoped refresh token and fetch returns staged rows. `Jest`
- [ ] Jest (api): a row already carrying an `ImportExternalRef` is flagged DUPLICATE, not re-created. `Jest`
- [ ] Jest (api): a revoked token surfaces a re-connect prompt rather than a 500. `Jest`

#### ONB-A6

- [ ] Jest (api): a nightly export job advances its watermark only on success. `Jest`
- [ ] Jest (api): MONEY INVARIANT — exported totals equal stored invoice totals for the period. `Jest`

#### ONB-A7

- [ ] Integration: a 20,000-row import returns a job id immediately and completes asynchronously with readable progress. `Manual`
- [ ] Integration: killing and restarting the worker mid-job does not re-import committed rows. `Manual`

#### ONB-A8

- [ ] Jest (api): a successful scan increments `MeterKey.SCANS` by 1 in each of the four independent call sites (vendor-bills, supplier-statements, bookkeeping, route-analysis). `Jest`
- [ ] Jest (api): crossing `scansIncluded` opens a grace window rather than failing the in-progress scan. `Jest`
- [ ] Jest (api): a tenant without the `ocr` addon gets 403 from all four scan endpoints and the client hides the scan buttons. `Jest`

#### ONB-A9

- [ ] Jest (api): a scan file older than the retention window is deleted with `fileKey` nulled, `extractedPayload` kept. `Jest`
- [ ] Jest (api): a tenant over quota gets a clear 4xx at upload naming the quota. `Jest`

#### ONB-A10

- [ ] Manual/runbook: a documented restore procedure recovers the upload volume, verified end-to-end at least once. `Manual`
- [ ] Integration: a nightly job replicates new upload keys off-site and reports the count. `Manual`

#### ONB-A11

- [ ] Integration: an inbound 850 creates a draft order mapped by the customer's own item codes. `Manual`
- [ ] Integration: MONEY INVARIANT — an emitted 810 totals exactly the stored invoice total, line for line. `Manual`

#### ONB-A12

- [ ] Jest (api): every send writes a row capturing document, recipient, channel, transport, provider id, timestamp, outcome. `Jest`
- [ ] Jest (api): a bounce webhook flips that row to bounced and surfaces it on the customer record. `Jest`
- [ ] Jest (api): a message the provider never accepted is never recorded as sent. `Jest`

## How this varies by tenant

| Variation                                                          | Mechanism                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI document scanning on or off                                     | `TenantAddon` key `"ocr"` via `@RequireAddon("ocr")`; granted from platform-admin or the `OCR_PACK_250` SKU. Client entry surfaces are NOT hidden for tenants without it — scan buttons remain visible and 403. |
| Migration hub as a paid capability                                 | `@RequirePlanFlag("flag.import_integrations")` on `MigrationController` only; the six CSV importers, batch queue, aliases, numbering and resolution stay ungated for every tenant.                              |
| Included WhatsApp/SMS message volume                               | `PlanDefinition.msgsIncluded` plus the `MSG_BUNDLE_500` addon SKU, read through `MeterService` and surfaced as `msgsMeter`.                                                                                     |
| Included AI scan volume                                            | `PlanDefinition.scansIncluded` and the `OCR_PACK_250` capacity SKU. **NOT CONFIGURABLE in effect** — `MeterKey.SCANS` is never incremented in production, so the cap can never be reached.                      |
| Outbound email identity                                            | `SystemConfig` keys `email.smtpHost`/`smtpUser`/`smtpPassword` (encrypted) or a verified sending domain (`email.sendingDomain`), falling back to the platform Resend transport.                                 |
| Which events notify customers, on which channel, with what wording | Per-tenant `NotificationRule` + `MessageTemplate`, lazily seeded on the first `GET /messaging/config` visit — a tenant nobody has opened Settings for has zero rules.                                           |
| Quiet hours and timezone                                           | `MessagingSettings` singleton per tenant, editable via `/messaging/settings`. Stored and computed but **NOT enforced**.                                                                                         |
| Document number prefix/next/padding per doc type                   | `NumberingSequence` rows per `(tenantId, docType)`. **NOT WIRED** — live invoice minting ignores this entirely and always mints `INV-<year>-NNNN`.                                                              |
| Branding on generated documents                                    | `TenantConfig` columns (logo, colour, business name, address) read by `InvoicePdfService`/`StatementPdfService`.                                                                                                |
| Remittance / how-to-pay block                                      | One JSON document under `SystemConfig` key `"remittance.config"`, buyer-visible by design (excluded from `SECRET_KEYS`).                                                                                        |
| Per-tenant AI key for document scanning                            | `SystemConfig` key `anthropic.apiKey` (encrypted), resolved via `PlatformConfigService.resolveAnthropicKey` with a platform-key fallback.                                                                       |
| Push notification availability                                     | Platform-level env (`FCM_SERVICE_ACCOUNT_JSON`, Expo push). **NOT PER-TENANT**, and effectively **NOT CONFIGURABLE** — `isConfigured()` returns `firebaseInitialized                                            |     | true`, unconditionally true (register B181). |
| The CSV dialect/column names a tenant's old system produces        | **NOT CONFIGURABLE** — hardcoded Zoho-family headers throughout `import.service.ts`; the web page is titled "Import from Zoho".                                                                                 |
| Import size ceiling                                                | **NOT CONFIGURABLE** — `MAX_IMPORT_ROWS = 20_000` const, plus fixed per-endpoint byte caps.                                                                                                                     |
| Lifetime of a document download link                               | **NOT PER-TENANT** — platform env `STORAGE_URL_EXPIRY_SECONDS` (default 3600) on local storage; R2 hardcodes 3600 regardless.                                                                                   |
| Wording/subject line of the invoice email itself                   | **NOT CONFIGURABLE** — hardcoded in `EmailService.sendInvoice`/`buildInvoiceEmail`; the editable notification templates govern the messaging engine only, not the real invoice email.                           |
| Storage backend (R2 vs local volume)                               | **NOT PER-TENANT** — decided at boot by whether R2 credentials are set.                                                                                                                                         |

## Gaps for a great UX

| Severity | Gap                                                                                                                                                                                                                                                                                                                                         | Impact                                                                                                                                                                                              | Suggested direction                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Document-numbering continuity is settable but not connected to live minting.                                                                                                                                                                                                                                                                | Customers see the invoice sequence restart mid-relationship; statements stop reconciling; the setting reports success so nobody discovers it until a customer complains.                            | Wire `NumberingService.reserveNext` into `InvoicesService.nextInvoiceNumber` (and estimate/credit-note/payment mints) under a locking transaction; hide the setting until wired.                        |
| CRITICAL | Five of six CSV importers write straight to live data with no preview, batch id, undo or audit entry.                                                                                                                                                                                                                                       | A wrong file permanently contaminates a live tenant; the only recovery is a database restore.                                                                                                       | Stamp an `importRunId` on every import (mirroring expenses), expose a runs list and reversal endpoint, write an AuditLog entry, add a dry-run flag.                                                     |
| CRITICAL | Customer notifications through the rules matrix do not reach customers: WhatsApp/SMS hit a logging stub, EMAIL is misrouted through the same stub, PORTAL has no reader — yet each send records "sent" and metered channels bill anyway. Note: mobile push notifications are a separate, real, working transport for order/delivery events. | A tenant enables notification rules, sees them ON, and customers get nothing on that matrix — while metered allowance is consumed for undelivered messages.                                         | Bind a real WhatsApp/SMS adapter at `MESSAGE_PROVIDER`; route EMAIL through `EmailService`; make PORTAL either render somewhere or stop claiming delivery; meter only confirmed acceptance.             |
| CRITICAL | The only backup covers the database; the upload volume (POD photos, licences, scanned bills, generated PDFs) has no backup.                                                                                                                                                                                                                 | A volume loss destroys every delivery-evidence and compliance document with no recovery path — the same failure class as a prior production data-loss incident.                                     | Replicate the upload prefix to R2 nightly with checksum verification; cover files in the restore runbook.                                                                                               |
| CRITICAL | Every importer expects exact Zoho headers and the CSV parser drops a UTF-8 BOM.                                                                                                                                                                                                                                                             | A tenant from QuickBooks, Sage, POS or spreadsheet cannot import without hand-renaming headers; even a correct file re-saved by Excel imports zero rows. This is the first thing a new tenant does. | Pass `bom: true` to the CSV parser (register B112); normalise header keys; add a column-mapping step.                                                                                                   |
| HIGH     | The invoice email carries a link signed for one hour, no attachment.                                                                                                                                                                                                                                                                        | A customer opening the email the next morning gets a dead link.                                                                                                                                     | Attach the PDF, or mint a long-lived per-document token and expose expiry as a tenant setting.                                                                                                          |
| HIGH     | Quiet hours are presented as holding messages but the engine sends anyway.                                                                                                                                                                                                                                                                  | A tenant believing they protect customer goodwill will message at 2am once a real provider connects, risking a telecoms/marketing rules breach.                                                     | Implement a hold-and-release queue (Redis is already available) or change the copy to say "recorded, not enforced" until it is.                                                                         |
| HIGH     | SMS/WhatsApp consent fields exist and are enforced at send time, but nothing sets them.                                                                                                                                                                                                                                                     | Every WhatsApp/SMS cell is permanently unfirable, with no consent record to show a regulator.                                                                                                       | Add consent toggles with a timestamp on the customer form (web + mobile) plus a buyer-portal opt-in, and a STOP handler.                                                                                |
| HIGH     | Estimates and credit notes have no document at all — `send` on an estimate only flips a status field.                                                                                                                                                                                                                                       | An operator believes a quote reached the customer; it did not. Credit notes cannot be evidenced to a disputing customer.                                                                            | Reuse `InvoicePdfService`'s template shape for estimate and credit-note variants, routed through the same honest `EmailService` path.                                                                   |
| HIGH     | The operator has nowhere to see what was communicated to a customer, and the real invoice email is not logged at all.                                                                                                                                                                                                                       | "Did we tell them?" is unanswerable — disputes over price changes or missed windows come down to memory.                                                                                            | Build a customer-activity feed reading `/messaging/threads`, and log every `EmailService.send` into the same feed.                                                                                      |
| HIGH     | Data portability is thin: no product/inventory/supplier export, and existing exports are capped at 1000 rows with the customers export ignoring list filters.                                                                                                                                                                               | A tenant cannot hand an accountant a full catalog or invoice file, and hits a silent cap on larger exports — a procurement objection about lock-in.                                                 | Add filtered, uncapped CSV exports for products, inventory and suppliers reusing each list endpoint's own where-clause.                                                                                 |
| HIGH     | Importing stock for a not-yet-existing product creates it with stock set and no StockMovement, at price 0.                                                                                                                                                                                                                                  | Σ(movements) ≠ on-hand from day one, breaking the stock ledger baseline; a $0 product can be sold at zero.                                                                                          | Write an opening-balance StockMovement on the create branch too; require a price or mark the product inactive/incomplete.                                                                               |
| MEDIUM   | Plan allowances for AI scans are inert — `MeterKey.SCANS` never increments across any of the four independent call sites — and OCR entry surfaces aren't hidden for tenants without the addon.                                                                                                                                              | Unbounded AI spend against the platform key with no per-tenant cap, plus a confusing UX where visible buttons 403.                                                                                  | Increment SCANS in each of the four call sites (vendor-bills, supplier-statements, bookkeeping, route-analysis), apply the existing grace-window behaviour, gate client entry points on the addon flag. |
| MEDIUM   | The migration hub stages CUSTOMER/INVOICE/PAYMENT but commits none of them; its Zoho/QuickBooks connectors are stubs.                                                                                                                                                                                                                       | The most valuable half of the migration story (dedup + 24h undo) is unavailable exactly where it matters most.                                                                                      | Route those commits through the existing CSV importers behind the same ExternalRef/undo bookkeeping; label OAuth sources "coming soon".                                                                 |
| MEDIUM   | Large imports and scan batches run inline in the HTTP request with no job record or resumability.                                                                                                                                                                                                                                           | A timed-out or interrupted migration leaves the tenant unsure what landed, with no resume and no reversal.                                                                                          | Move imports and batch posting onto a Redis-backed job queue with status, progress, and an idempotency key.                                                                                             |
| MEDIUM   | No storage retention or quota; `InvoiceScan.fileKey` is documented as prunable but nothing prunes it.                                                                                                                                                                                                                                       | Scanned documents accumulate forever on a fixed-size volume; one heavy tenant can exhaust disk for everyone.                                                                                        | Add a retention cron per tenant and a STORAGE meter key with a friendly quota error at upload.                                                                                                          |
| MEDIUM   | Invoice number generation on the non-transactional path reads with the unscoped Prisma client rather than the tenant-scoped one.                                                                                                                                                                                                            | Possible cross-tenant numbering leakage or gaps in a customer-facing sequence — needs confirming against row-level-security policy.                                                                 | Default to `this.prisma.forTenant()`; add a spec asserting a fresh tenant starts at 0001 regardless of another tenant's volume.                                                                         |
| LOW      | Notification rules only exist once a human opens Settings → Notifications, and some seeded-ON rules point at events no code ever fires.                                                                                                                                                                                                     | Two tenants on the same plan behave differently depending on who visited a settings page; the matrix advertises automation that never happens.                                                      | Seed the matrix at tenant provisioning; wire or remove the unfired events.                                                                                                                              |
| LOW      | Learned product aliases have a full API and no screen.                                                                                                                                                                                                                                                                                      | A wrong alias keeps mis-matching supplier lines to the wrong product, quietly corrupting cost and stock, with no way to fix it.                                                                     | Add an alias list with search/edit/delete to the import settings area — the endpoints already exist.                                                                                                    |
| LOW      | Unknown-item resolution's variant/brand-new/match actions are API-only with no UI caller.                                                                                                                                                                                                                                                   | An operator resolving an unmatched scanned line has no path to the richer resolution options the API supports.                                                                                      | Wire `useCreateVariant`/`useCreateBrandNew`/`useMatchExisting` into `BatchItemReviewModal`.                                                                                                             |

## Cross-domain handoffs

- **Import → Customers & Identity**: `importContacts` creates Customer, CustomerAddress, ContactPerson
  and a login User per customer, and calls `CustomersService.assertCustomerCapNotExceeded` /
  `maybeStartCustomerGrace`. The CUSTOMERS meter and buyer-portal invite flow both depend on those
  rows being well-formed.
- **Import → Finance**: `importInvoices`/`importPayments` feed customer statements, aged debt, and
  the cash-basis bookkeeping split on `settledAt ?? paidAt`. Every imported amount must be
  `roundMoney`'d and never re-derived as `qty × unitPrice` for a boxed line.
- **Import → Inventory**: `importInventory` sets `Product.currentStock` and, on the update branch
  only, writes a StockMovement. The `Σ(movements) == on-hand` invariant is owned by Inventory but is
  broken by the import create branch.
- **OCR batch queue → Purchasing → Inventory & Costing**: `BatchImportService.postBatch` calls
  `VendorBillsService.create + receive` per clean item, moving stock and weighted cost.
  `DuplicateMatchService` is the only thing standing between a re-scanned paper bill and
  double-counted stock and cost.
- **Documents → Buyer portal**: `InvoicePdfService` and `StatementPdfService` produce the artifacts
  the buyer portal serves, reached through the same signed-URL storage gate. A branding or terms
  change nulls cached `pdfUrl` values.
- **Messaging triggers ← Orders, Invoices, Routes, Authorizations**: `MessagingService.notifyEvent`
  is called after the business write commits — never inside a transaction — with every money/date
  variable pre-formatted over stored totals.
- **Uploads ← Routes, Customers, Products, Invoices, Regulated/Tobacco**: POD photos and
  signatures, customer documents and tax certificates, product images, check/payment images, and
  filing CSV/PDFs all depend on `UploadsAccessGuard`'s owner-lookup tenant scoping and on the
  storage volume surviving.
- **Numbering → Invoices, Estimates, Credit notes, Payments**: `NumberingService` is intended as
  the single mint for all four document types; today only imported documents respect it and live
  minting bypasses it entirely.
- **Communications & OCR → Billing**: `MeterService.increment(MSGS)` and
  `PlatformConfigService.recordAiUsage` feed plan caps, the grace-window machinery and platform AI
  cost reporting. The SCANS half of that contract is currently unwired across all four scan call
  sites.
- **Email → Auth & Buyer identity**: `EmailService` is also the transport for password resets,
  buyer email verification, portal invites and account-merge confirmations — its honest-by-result
  contract is what keeps an unconfigured mail server from turning login or merge into a 500.
- **Notifications → Orders, Routes, Stock alerts, Authorizations**: push notifications are a real,
  separate, working transport wired directly into order status changes, route/driver assignment,
  back-in-stock alerts and licence-expiry warnings — independent of the (currently non-delivering)
  messaging rules matrix.

## What we could not verify

- Everything marked SHIPPED / PARTIAL / BROKEN is anchored to code read in this session
  (controllers, services, the Prisma schema, the plan catalog, web/mobile client modules) — no
  tests were run and no endpoints were called, so status reflects code shape, not a live probe.
- Whether Cloudflare R2 is actually configured on production, versus the local Railway volume
  being the live backend — `StorageService` chooses at boot from env vars not readable here.
- Whether Postgres row-level-security policies backstop the unscoped read in
  `InvoicesService.generateInvoiceNumber` — RLS is only set inside `tenantTransaction`, so the
  cross-tenant numbering risk is flagged as needing confirmation, not asserted as proven.
- The actual per-tenant addon and plan-flag state in production (which tenants hold `ocr` or
  `flag.import_integrations`).
- Only the signature list plus targeted bodies of the 58KB `import.service.ts` were read, so a
  secondary column fallback may exist in an importer not opened line by line.
- Mobile coverage is asserted from filenames, an API-module inventory, and targeted greps rather
  than reading every operator screen.
- Severity ratings are product judgement, not the bug register's own ratings. Where an observation
  matches an existing register entry (B102, B112, B120, B145, B158, B160, B180, B181, B182, B183)
  it is cited so the two documents stay consistent.
- The verification pass itself flagged that its own suggestion for ONB-A8 (a single OCR
  "chokepoint") was wrong — the correct picture (four independent call sites) is reflected above,
  but a full audit of every Anthropic call site in the codebase was not performed.

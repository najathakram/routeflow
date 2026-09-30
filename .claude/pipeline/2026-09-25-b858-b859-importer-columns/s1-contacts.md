# S1 Evidence — B859 (customers/contacts CSV importer)

Repo focused-knuth-179e2b@21085bcb. Registry via `git show f97966f6:.claude/campaign/bugs/B859.md`.

## The bug as stated

id B859 · severity medium · state uncampaigned · location `import.service.ts importContacts(~214-533) · settings/import 'Customers (Contacts)' card`.

**Reported evidence** (verbatim): "The contacts importer reads names, phones, email, billing/shipping addresses (+ optional lat/lng) and currency only; defaultPaymentTerms, pricingTier, creditLimit, isTaxExempt, taxId, tobaccoLicenseNo/Expiry, delivery window and consent are never read, so they must be set customer by customer. It also does not geocode: addresses without Latitude/Longitude columns import with no coordinates."

**User impact** (verbatim): "Every onboarding: payment terms, price tier, credit limit (hard order block), tax-exempt status and tobacco licence expiry must be set per customer by hand; a missed tax-exempt flag taxes an exempt retailer and a missed licence skips the regulated warning. No geocoding at import means routes need coordinates fixed per address. Route with B858."

## Code path

`importContacts(buffer,userId)` (214-217) returns `{created,updated,skipped,errors:string[]}`.

Fields read (CSV headers, trimmed): `Contact Type`(232, default "customer"; else⇒`skipped++;continue`, vendors dropped, never `supplierOnly`); `Customer Name`/`Display Name`/`Company Name`(238-243, required, empty⇒skip); `Customer ID`→`zohoContactId`(249); `Salutation`/`First Name`/`Last Name`(252-255); `Phone`/`Billing Phone`(257-259, strips `'`); `MobilePhone`(261-262); `EmailID`/`Email`(263, lower-cased); `Currency Code` default "USD"(264); `Notes`(265); `Billing/Shipping Address+Street2/City/State/Code/Latitude/Longitude`(274-298, lat/lng via `parseFloat`,`NaN→null`); shipping only if present AND differs from billing(300-304). No header for `pricingTier`/`creditLimit`/`isTaxExempt`/`taxId`/`tobaccoLicenseNo/Expiry`/`defaultPaymentTerms`/`defaultDepositPercent`/`deliveryWindowStart/End`/`smsConsent`/`waConsent` exists in 214-533.

Match/dedupe(306-320): `zohoContactId` first, else case-insensitive `businessName`. **Match⇒update**(322-406, no transaction): patches `zohoContactId`(if unset)/`displayName`/`salutation`/`firstName`/`lastName`/`phone`(if none existing)/`mobile`/`email`/`notes`/`currency`(always)/`contactName`(conditional); adds BILLING address if none exists(346-363), SHIPPING likewise(366-383), `contactPerson` only if `existing.contactPersons.length===0`(386-399). `updated++`. **No match⇒create**(408-512, one `tenantTransaction`): unique `username`+placeholder email as needed(409-425); `tx.customer.create`(441-457) writes that same field set, nothing more, plus the same address/contactPerson creates. `created++`; `P2002`⇒silent `skipped++`(519-520); other exception⇒`pushRowError`+`skipped++`(521-524).

`pushRowError` (86-90) pushes only `"${label}: import failed"` (real error goes to `logger.warn` only). Rows skipped for bad contact-type or missing name (234,245) add **no** error entry — bare counter only.

Tenant scoping: all reads/writes via `prisma.forTenant()` or tenant-scoped `tx`. Cap: `assertCustomerCapNotExceeded()` once up front(222); `maybeStartCustomerGrace()` once at end if `created>0`(530, comment: "The import ALWAYS succeeds... Never throws").

## Schema facts

`Customer` model, `sales.prisma:132-245`. None enum-typed (Int/Str/Bool/Decimal/DateTime/Float only) — L-072 N/A. name/type/default/nullable: `defaultPaymentTerms` Str?/-/Y(169) · `pricingTier` Int/1/N(165) · `creditLimit` Decimal(10,2)?/-/Y(163) · `isTaxExempt` Bool/false/N(157) · `taxExemptDocumentKeys` Str[]/[]/N(158) · `taxId` Str?/-/Y(156) · `tobaccoLicenseNo` Str?/-/Y(161) · `tobaccoLicenseExpiry` DateTime?/-/Y(162) · `deliveryWindowStart/End` Str?/-/Y(146-147) · `smsConsent`/`waConsent` Bool/false/N(178-179) · `consentUpdatedAt` DateTime?/-/Y(180) · `orderStatusEmails` Bool/true/N(187) · `creditHoldAt/Reason/ById` -/Y(198-200) · `currency` Str/"USD"/N(164). No lat/lng on `Customer`. `CustomerAddress`(266-299): `lat`/`lng` Float?/-/Y(275-276), `stateCode` Str?@Char(2)/-/Y(286), `stateNeedsReview` Bool/false/N(287), via `addressStateFields()`.

## Service guards

`CustomersService.create`(512-)/`update`(767-) DO write these fields when present(567-578,795-802), gated only by `!==undefined`, no addon/regulated gate. `CreateCustomerDto`: `taxId` `@IsString()@MaxLength(40)`; `isTaxExempt` `@IsBoolean()`; `creditLimit` `@Min(0)@Max(1e9)`(no `@IsNumber()`); `pricingTier` `@IsInt()@Min(1)@Max(5)`; `defaultPaymentTerms` `@IsIn(VALID_CUSTOMER_TERMS)`=`["Due on Receipt","Net 15","Net 30","Net 45","Net 60",""]`(`update-invoice-settings.dto.ts:7`); `defaultDepositPercent` `@IsNumber()@Min(0)@Max(100)`. **Neither DTO has `tobaccoLicenseNo/Expiry` or `smsConsent/waConsent`; only Update has `deliveryWindowStart/End`**(`@IsString()`, no time-format check).

Claim: `grep -rn "tobaccoLicenseNo\s*:\|tobaccoLicenseExpiry\s*:" apps/api/src --include="*.ts" | grep -v spec.ts` → only reads, in `tobacco/tobacco.service.ts:153-154` and `regulated/regulated-report.service.ts:297,313`/`tx-report.ts:101,448`. No write site exists in `apps/api/src`; `PATCH /customers/:id`(`customers.controller.ts:169-172`) binds `UpdateCustomerDto`, which has no such field — no HTTP path sets a Customer's tobacco licence today, importer or not.

## Geocoding

`grep -rn -i "geocod" apps/api/src|head -30` → hits only in `customers.service.ts`(37,105-134,533-538,888-889,948)+specs; `grep -in "geocod" import.service.ts` → no output(exit 1). `CustomersService.geocodeIfPossible`(109-112)→`geocodeAddress()`(`common/geocode.util.ts`), key=`config.get("googleMaps.apiKey")`=env `GOOGLE_MAPS_API_KEY`(`configuration.ts:147`). `create()`/`update()` geocode automatically(533-538,888-889); `importContacts` never calls it — trusts only CSV `Latitude`/`Longitude`.

## Web

`apps/web/.../settings/import/page.tsx`: "Customers (Contacts)" card(56-74) posts `endpoint:"/import/contacts"`(70); only help text is the Zoho export-path string(73) — no per-column mapping help. `handleImport`(146-190) POSTs `FormData` with just `file`(150-151), no dryRun/query params. Shows created/updated/skipped counts(216-229) + up to 20 `errors`+overflow note(304-332). 2nd entry point: `apps/web/.../customers/page.tsx:107`, a modal — same endpoint/body/shape.

## Existing tests

Only 3 specs call `importContacts`(`grep -rln "importContacts" apps/api/src/import/*.spec.ts`): `import-address-state.spec.ts`(F4: addresses carry `stateCode`/`stateNeedsReview`); `import-customer-cap.spec.ts`(soft cap: gate-throws-writes-nothing / opens-grace-after-create / skips-grace-when-nothing-created); `import-robustness.spec.ts`(`REG-B112`: BOM-prefixed buffer imports cleanly). **None assert on the B859 fields/consent — no spec breaks if those columns start being read.** `import.security.spec.ts`/`import-item-tenantid.db.spec.ts` do **not** call it (former: `pushRowError`/`parseCsv` cap only; latter: `InvoiceItem` tenant id, invoice importer only). All 3 use `Test.createTestingModule`+`createMockPrisma()`(generic auto-mock; `tenantTransaction` wraps `$transaction`), `CustomersService` mocked as `{assertCustomerCapNotExceeded,maybeStartCustomerGrace}`.

## History

`git blame -L214,533 import.service.ts` top contributor: 105/2026-04-02/`9faf1f86` "…Zoho contact import maps all fields"; next: 70/2026-04-17/`72069288`(CI fixes), 49/2026-03-30/`d689ab61`(orig feature); remaining ~65 lines are smaller 2026-04/09 fixes incl. `77a457b1`(address-state, 2026-09-20).

Claim: `9faf1f86` says "maps all fields", but its diff (`git show 9faf1f86 -- import.service.ts | grep -iE "^\+.*(pricingTier|creditLimit|isTaxExempt|taxId|tobaccoLicense|defaultPaymentTerms|deliveryWindow|smsConsent|geocod)"`) adds none of them — only `displayName`/`salutation`/`zohoContactId`/`Billing|Shipping Latitude/Longitude`. "All fields" as shipped never included B859's commercial/tax/compliance columns.

## Other callers

`grep -rln "import/contacts\|importContacts" scripts apps/web/e2e apps/mobile` → no hits. Callers: `import.controller.ts:34,36`, `settings/import/page.tsx:70`, `customers/page.tsx:107`.

Controller(25-37): `@Controller("import") @UseGuards(JwtAuthGuard,RolesGuard) @Roles(UserRole.OPERATOR)`; `@Post("contacts") @HttpCode(200) @UseInterceptors(FileInterceptor("file",{limits:uploadLimits(MB(10))}))`; no `@RequireAddon`/`@RequirePlanFlag`; field `"file"`; no query/body params, no `dryRun`; `BadRequestException("No file uploaded")` if absent; returns the service result unwrapped.

## Open unknowns

- Any `tobaccoLicenseNo/Expiry` write path outside `apps/api/src` (scripts,seeds) — not checked.
- Whether `creditLimit`'s missing `@IsNumber()` in `CreateCustomerDto`(55) matters — importer never sets `creditLimit` anyway.
- Whether the update-path's un-transacted multi-call sequence (325-399, no shared `tx`) is in scope here — fact only, not analyzed.
- B858's text wasn't fetched (scoped to B859); B859 says "Route with B858" — S2 should pull it before a joint root-cause call.

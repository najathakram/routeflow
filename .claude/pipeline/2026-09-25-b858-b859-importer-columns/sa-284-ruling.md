# SA-284 — fleet lead ruling on B858/B859 (relayed verbatim by Mac Lead, 2026-09-25 ~19:30Z)

Base: options (1)–(4) as recommended plus the lead's leanings. Name matching is exact after normalization and unique within the tenant; an ambiguous match skips. Consent is set only by an explicit yes; a no revokes it. #2154 (docs/wholesaler-onboarding: playbook) lands first.
(a) ONE write path. Imports go through ProductsService/CustomersService create/update, or their exact guard fns, so these always run: assertCanFlagTobacco, assertMsrpAllowed, the sku/barcode/unitSku collision checks and emitProductChanged. No raw prisma. Source-pin it.
(b) A gated column present without its entitlement (Tobacco without tobacco_dealer, MSRP without the plan flag) REFUSES THE WHOLE FILE at preview, naming the column, before any write. A bad cell (unparseable money, unknown terms/tier, bad date, ambiguous name) skips that ROW with a reason. Never drop the cell, never import a partial row.
(c) Cost writes standardCost only. averageCost is NEVER written, not even for new products; the ledger seeds it (SA-136).
(d) unitsPerBox is written only for a NEW product or when the existing value is null. A differing pack skips the row with "pack changes are made in the product editor" (the B644/B646 class).
(e) Consent literals: yes/true/1 grant, no/false/0 revoke, blank leaves it, anything else is a bad cell. Each write records source=import, userId, file name, row and timestamp, the same evidence shape as the UI; add that shape if it doesn't exist. A past licence expiry imports with a warning.
(f) Fix `parseImportMoney(...) || 0` in the same PR. A present-but-unparseable money cell is a bad cell, not $0. Pin it.
Also: geocoding is OUT (file it separately). Remove the dead importFromZoho JSON path in its own PR.
Pins: file-level gate refusal; one row-skip per bad-cell kind, with its reason; blank-never-clears on every column; a source pin that nothing writes averageCost; the pack-change refusal; the consent evidence row; the money-parse fix; a real-Postgres re-import of an all-columns fixture run twice (idempotent; the second run shows no diffs; that DB spec goes to F2 as a NEED-DB). Heavy slot requests per burst as before.

## Facts gathered after the ruling (orchestrator, 21085bcb)

- No consent write path exists anywhere (only read: messaging.service.ts:121,131); Customer.consentUpdatedAt exists (sales.prisma:180). AuditLog model (platform.prisma:581: tenantId,userId,action,entityType,entityId,meta Json,createdAt) + AuditService.log(dto) (audit/audit.service.ts:22) exist → evidence shape can be an AuditLog row, no migration.
- ProductsService: create(dto: CreateProductDto) :507, update(id, dto, options?{suppressEmit}) :722, private assertMsrpAllowed :112, private assertCanFlagTobacco :143, private emitProductChanged :93 (bulk form used at :1032).
- CustomersService: create(dto) :512 geocodes addresses (:538); update(id,dto) :767 geocodes when address fields present (:889, :949). Geocoding is OUT → import must not trigger it.
- ImportService ctor (import.service.ts:48) injects Prisma, VendorBills, Customers, Numbering, ExternalRef — NOT ProductsService (DI change → compose boot gate).
- UpdateCustomerDto/CreateCustomerDto lack tobaccoLicenseNo/Expiry and smsConsent/waConsent.

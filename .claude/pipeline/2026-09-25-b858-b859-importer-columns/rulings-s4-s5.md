# S4 + S5 rulings — B858/B859 (Fable @ high; reads cause-ruling.md §2)

## S4 — test plan

Red set in `apps/api/src/import/import-commercial-columns.spec.ts` (Nest module + `createMockPrisma()`; mocks:
`ProductsService {create,update,assertCanFlagTobacco,assertMsrpAllowed,emitCatalogBulkChanged}`,
`CustomersService {assertCustomerCapNotExceeded,maybeStartCustomerGrace,update}`, `AuditService {log}`;
`findMany` → []). "Fails TODAY with" is the red gate's exact check.

| T#                                                                                                                                                   | Title                                                     | Fails TODAY with                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| T1                                                                                                                                                   | REG-B858-1 create carries pack/tier/barcode/category/cost | `productsService.create` expected 1 call, received 0       |
| T2                                                                                                                                                   | REG-B858-2 Rate "12abc" skips, never $0                   | `imported` expected 0, received 1                          |
| T3                                                                                                                                                   | REG-B858-3 SKU match updates priceTier2                   | `productsService.update` expected 1 call, received 0       |
| T4                                                                                                                                                   | REG-B859-1 terms/tier/limit/exempt/taxId reach update     | `customersService.update` expected 1 call, received 0      |
| T5                                                                                                                                                   | REG-B859-2 licence+consent write evidence                 | `auditService.log` expected 1 call, received 0             |
| T6                                                                                                                                                   | REG-B859-3 bad tier skips with a reason                   | `result.skippedRows` expected length 1, received undefined |
| Pins (SA-284 → file). `import-columns.spec.ts` (pure): alias/normalization table; one bad-cell case per parser                                       |
| (money/int/bool/terms/tier/date); blank ⇒ undefined for every field; no `averageCost` field; "Average Cost" ⇒                                        |
| unknownColumns. `import-commercial-columns.spec.ts`: gate refusal names the column, zero writes, dryRun+live                                         |
| (Tobacco, MSRP); ambiguous-name + duplicate-row skips; blank-never-clears diff over every field; pack rule                                           |
| null→12 writes / 6≠12 skips `"pack changes are made in the product editor"` / 12=12 no diff; consent meta                                            |
| `{source:"import",userId,fileName,row,channel,value,timestamp}` + `consentUpdatedAt`, none when unchanged; past                                      |
| expiry ⇒ warning, row imports; dryRun ⇒ no create/update/log; one bulk emit per file.                                                                |
| `import-commercial-columns.db.spec.ts` **NEED-DB (F2 runs it, not the engine)**: all-columns fixture twice on                                        |
| real Postgres, tenant `test`: run 2 `updated=0`, all `changes:{}`, `averageCost IS NULL`, one AuditLog per channel.                                  |
| Harness: robustness/address-state/customer-cap/security specs add `ProductsService`+`AuditService` providers and                                     |
| `update` on the customers mock; REG-B98 asserts on `productsService.create`; customers.service.spec adds one                                         |
| `update(id,{},{compliance})` case. Red gate: `npx jest --selectProjects api apps/api/src/import/import-commercial-columns.spec.ts -t "REG-B85[89]"`. |

## S5 — build plan

Waves (files disjoint within a wave; HIGH = money/tenancy, Opus review, radius per cause-ruling §4):

- W1 root-cause (read-only) ‖ repro-tests: the 3 new specs + 4 harness edits; RED proven.
- W2 fix-columns `import/import-columns.ts` + `packages/types/api/import.ts` ‖ fix-products-service HIGH
  `products/products.service.ts` ‖ fix-customers-service HIGH `customers/customers.service.ts` +
  `customers/customer-compliance-input.ts`.
- W3 fix-import HIGH `import/import.service.ts`, `import.controller.ts`, `import.module.ts` (dependsOn W2).
- W4 fix-web `components/import/ImportCsvPanel.tsx` (+ `.test.tsx`), `settings/import/page.tsx`,
  `customers/page.tsx`, dryRun hook (dependsOn W3).
- W5 revert-probes sequential per cause-ruling §7, shared `checksum:after`.
- docs DEFERRED: runbook §5 waits for #2154; registry close + lesson go in the Option B bookkeeping PR.
  Verify: `npx jest --selectProjects api apps/api/src/import apps/api/src/products/products.gateway-emit.spec.ts apps/api/src/products/products.service.spec.ts apps/api/src/customers/customers.service.spec.ts`
  (db spec excluded); `npm run check-types -w apps/api -w apps/web`; `cd apps/web && npx eslint <touched>`;
  `npm test -w apps/web -- ImportCsvPanel`; DI change ⇒ `npm run local:up && npm run local:validate` (L-113)
  before push; Playwright captures 1440/768/390 of preview/refusal/result → `local-assets/proofs/`. Implementer
  verifies `ProductsModule`/`AuditModule` export their services before W3; posts NEED-DB for the F2 spec.

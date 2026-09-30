# Bug test plan — B858 + B859 import-commercial-columns

> Fable @ high writes this from the fix ruling; Sonnet types the tests inside the engine. The red bar is
> BEHAVIORAL: each REG test must fail today on its own exact wrong value — reproduction is the point.
>
> Sources: `cause-ruling.md` §2/§3, `rulings-s4-s5.md` S4, `sa-284-ruling.md` (binding), `s2-refutation.md`.
> Harness: NestJS `Test.createTestingModule` + `createMockPrisma()` (existing helper already used by
> `import-robustness.spec.ts` / `import-address-state.spec.ts` / `import-customer-cap.spec.ts`).

## Red set (REG-tagged; in the red gate)

| T#  | Title (starts with REG-<bug id>)                           | Setup                                                                                                                                                                                | Asserts                                                                                                                                                                       | Fails TODAY with                                                                                                  | File                                                    |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| T1  | REG-B858-1: create carries pack/tier/barcode/category/cost | CSV row with `Item Name, SKU, Rate, Units Per Box, Price Tier 2, Barcode, Category, Standard Cost` set, no existing product match (`findMany` → `[]`); mock `productsService.create` | `productsService.create` called once with a dto containing `unitsPerBox:12, priceTier2:9.5, barcode, category, standardCost`                                                  | `productsService.create` expected 1 call, received 0 (raw `prisma.product.create` used instead)                   | `apps/api/src/import/import-commercial-columns.spec.ts` |
| T2  | REG-B858-2: Rate "12abc" skips, never becomes $0           | CSV row with `Rate` cell literal `"12abc"`, no match                                                                                                                                 | `result.imported === 0`; `result.skippedRows[0].reason` matches `/Rate.*not a number/`                                                                                        | `result.imported` expected 0, received 1 (row written with `pricePerUnit: 0`)                                     | `apps/api/src/import/import-commercial-columns.spec.ts` |
| T3  | REG-B858-3: SKU match updates priceTier2                   | Existing product found by exact SKU match (`findMany` returns one row, differing name), CSV row has `Price Tier 2 = 9.5`                                                             | `productsService.update` called once with `(id, { priceTier2: 9.5 })`                                                                                                         | `productsService.update` expected 1 call, received 0 (name-mismatch causes a silent `skipped; continue`)          | `apps/api/src/import/import-commercial-columns.spec.ts` |
| T4  | REG-B859-1: terms/tier/limit/exempt/taxId reach update     | CSV contact row with `Payment Terms=Net 30, Pricing Tier=3, Credit Limit=1500, Tax Exempt=Yes, Tax ID=12-3456789`, matched by `zohoContactId`                                        | `customersService.update` called once with `(id, { defaultPaymentTerms:"Net 30", pricingTier:3, creditLimit:1500, isTaxExempt:true, taxId:"12-3456789" }, expect.anything())` | `customersService.update` expected 1 call, received 0 (no commercial header is read at all)                       | `apps/api/src/import/import-commercial-columns.spec.ts` |
| T5  | REG-B859-2: licence+consent write evidence                 | CSV contact row with `Tobacco Licence No`, `Tobacco Licence Expiry` (future date), `SMS Consent=Yes`                                                                                 | `auditService.log` called once with `action:"customer.consent.import"`, `meta` containing `{source:"import", channel:"sms", value:true}`                                      | `auditService.log` expected 1 call, received 0 (no consent write path exists anywhere)                            | `apps/api/src/import/import-commercial-columns.spec.ts` |
| T6  | REG-B859-3: bad Pricing Tier skips with a reason           | CSV contact row with `Pricing Tier = "9"` (out of 1-5 range)                                                                                                                         | `result.skippedRows` has length 1; `result.skippedRows[0].reason` matches `/Pricing Tier/`                                                                                    | `result.skippedRows` expected length 1, received `undefined` (contacts importer has no `skippedRows` field today) | `apps/api/src/import/import-commercial-columns.spec.ts` |

"Fails TODAY with" is the exact expected-vs-received the red gate will verify — never merely "throws" or
"undefined" (T6 is the one legitimate `undefined` case: the field does not exist pre-fix, so its absence
_is_ the wrong value).

## Pins (no REG token; outside the red gate)

Per SA-284's pin list and rulings-s4-s5.md S4. Grouped by file.

### `apps/api/src/import/import-columns.spec.ts` (new, pure unit — no Nest, no prisma)

| T#  | Frozen behavior                                                                                                                                                                                                                   | File                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| P1  | `normalizeHeader` alias table: every alias listed in cause-ruling.md §2.A for both `PRODUCT_COLUMNS` and `CUSTOMER_COLUMNS` resolves to its canonical field (one case per alias family, table-driven)                             | `apps/api/src/import/import-columns.spec.ts` |
| P2  | One bad-cell case per parser kind: `money` (non-numeric non-blank), `int` (out of min/max), `bool` (unrecognized literal), `terms` (unknown label), `tier` (out of 1-5), `date` (unparseable) — each returns `{ok:false, reason}` | `apps/api/src/import/import-columns.spec.ts` |
| P3  | Blank cell ⇒ `{ok:true, value:undefined}` for every registered field (table-driven over both registries) — "blank never clears"                                                                                                   | `apps/api/src/import/import-columns.spec.ts` |
| P4  | No `averageCost` field exists in `PRODUCT_COLUMNS` (a source-level assertion the registry object has no such key)                                                                                                                 | `apps/api/src/import/import-columns.spec.ts` |
| P5  | Header `"Average Cost"` resolves to nothing and is reported in `unknownColumns`                                                                                                                                                   | `apps/api/src/import/import-columns.spec.ts` |

### `apps/api/src/import/import-commercial-columns.spec.ts` (new, NestJS + mocks)

| T#  | Frozen behavior                                                                                                                                                                                                                             | File                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| P6  | A file whose header includes a Tobacco column, tenant lacks `tobacco_dealer` addon ⇒ whole-file refusal (`ForbiddenException`) naming the column, in BOTH `dryRun:true` and `dryRun:false`; zero calls to `productsService.create`/`update` | `apps/api/src/import/import-commercial-columns.spec.ts` |
| P7  | Same as P6 for an MSRP column without `flag.msrp`                                                                                                                                                                                           | `apps/api/src/import/import-commercial-columns.spec.ts` |
| P8  | Two rows whose normalized name collides (no SKU/barcode) ⇒ both/either skipped `"ambiguous name (N matches)"`, zero writes for those rows                                                                                                   | `apps/api/src/import/import-commercial-columns.spec.ts` |
| P9  | Two file rows both matching the same existing key ⇒ the second is skipped `"duplicate of row N"`                                                                                                                                            | `apps/api/src/import/import-commercial-columns.spec.ts` |
| P10 | Blank-never-clears verified over every registry field on an UPDATE row (existing non-null value, cell blank ⇒ field absent from `changes`)                                                                                                  | `apps/api/src/import/import-commercial-columns.spec.ts` |
| P11 | Pack rule: `unitsPerBox` null on existing + row value 12 ⇒ written; existing 6 vs row 12 ⇒ row skipped `"pack changes are made in the product editor"`; existing 12 = row 12 ⇒ omitted from `changes` (no diff)                             | `apps/api/src/import/import-commercial-columns.spec.ts` |
| P12 | Consent meta shape exactly `{source:"import", userId, fileName, row, channel, value, timestamp}` plus `consentUpdatedAt` set in the compliance options; no audit call when the consent cell is blank/unchanged                              | `apps/api/src/import/import-commercial-columns.spec.ts` |
| P13 | `tobaccoLicenseExpiry` in the past ⇒ row still imports (create/update called), `result.warnings` contains a "Tobacco licence expired <date>" entry                                                                                          | `apps/api/src/import/import-commercial-columns.spec.ts` |
| P14 | `dryRun:true` ⇒ zero `create`/`update`/`log` calls; returned plan's `action`/`changes` match what a subsequent `dryRun:false` run would do                                                                                                  | `apps/api/src/import/import-commercial-columns.spec.ts` |
| P15 | Exactly one `productsService.emitCatalogBulkChanged()` call per file when `created+updated > 0`; zero calls when nothing changed                                                                                                            | `apps/api/src/import/import-commercial-columns.spec.ts` |

### `apps/api/src/import/import-commercial-columns.db.spec.ts` (NEED-DB — F2 runs it, NOT the engine)

| T#  | Frozen behavior                                                                                                                                                                                                                                                                          | File                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P16 | An all-columns fixture imported twice against real Postgres (tenant `test`): run 2 reports `updated:0`, every row's `changes:{}`, `averageCost IS NULL` on every touched product, and exactly one `AuditLog` row per consent channel actually changed (not duplicated by the second run) | `apps/api/src/import/import-commercial-columns.db.spec.ts` |

**This file is excluded from every engine-run command** (red gate, perRound, final) — it needs a live compose
Postgres and is not runnable inside the pipeline's sandboxed task loop. It runs only under
`npm run local:test:db` per CLAUDE.md's DB-spec lane; post NEED-DB before running it.

## Harness notes (verified by the engine's harness-integrity check)

Existing specs exercising the two importers all use `createMockPrisma()`, none currently provide
`ProductsService`/`AuditService`, and `CustomersService` mocks lack `update`. Each must gain the following in
the SAME edit that adds the new specs (not deferred to the fix task):

- `apps/api/src/import/import-robustness.spec.ts` (REG-B98, REG-B112 assertions live here) — add
  `ProductsService` provider (mock `{ create: jest.fn(), update: jest.fn(), emitCatalogBulkChanged: jest.fn(),
assertCanFlagTobacco: jest.fn(), assertMsrpAllowed: jest.fn() }`) and `AuditService` provider (mock
  `{ log: jest.fn() }`); re-point any assertion that inspected `mockPrisma.product.create` calls onto
  `productsService.create` instead — that call site moved.
- `apps/api/src/import/import-address-state.spec.ts` — same two providers added (module boot fails without
  them once `ImportService`'s constructor gains the dependencies); no assertion changes needed (this spec
  doesn't touch product/customer commercial fields).
- `apps/api/src/import/import-customer-cap.spec.ts` — same two providers, PLUS the existing `CustomersService`
  mock gains `update: jest.fn()` (it already has `assertCustomerCapNotExceeded`/`maybeStartCustomerGrace`).
- `apps/api/src/import/import.security.spec.ts` — same two providers (module boot dependency only; this spec's
  own assertions are unaffected).
- `apps/api/src/customers/customers.service.spec.ts` — add one case: `update(id, {}, { compliance: {...} })`
  writes only the compliance fields and never triggers `geocodeIfPossible` (pin for "update with no address
  fields never geocodes").

A mocked service gaining a method is a one-line addition to its `jest.fn()` map; a fixture whose header row
lacks a required alias is not affected (aliases are additive, not narrowing).

## Commands

- `redGate.commands`: `cd apps/api && npx jest src/import/import-commercial-columns.spec.ts src/import/import-columns.spec.ts -t "REG-B85[89]" --maxWorkers=2 --reporters=default` — expect fail (T1-T6 red; pins not yet applicable pre-fix so they are authored alongside but not part of the red-gate token filter).
- The REG token(s) (`REG-B858-1`, `REG-B858-2`, `REG-B858-3`, `REG-B859-1`, `REG-B859-2`, `REG-B859-3`) double as
  the registry proof lines at close-out.

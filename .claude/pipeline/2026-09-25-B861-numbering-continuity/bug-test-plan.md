# Bug test plan — B861 numbering card → live series (SA-274)

> Red bar is BEHAVIORAL: each REG test fails TODAY on its own wrong value. Pins carry no `REG-` token
> (L-100). One `expect` per `it` wherever a test is in the red set. `<Y>` = `new Date().getFullYear()`.
> Unit/web/controller REG tests are the engine's red gate. DB-lane tests are run ONLY by the F2 prover
> (NEED-DB) — red at the tests-only sha, green at the fix sha.

## Red set — api unit (`apps/api/src/import/numbering.service.spec.ts`, extend; mocked Prisma)

Fixture for A/B/C/J (build it ONCE as a helper): a fake tx whose `numberingSequence.findUnique` answers
by `where.tenantId_docType_year.year` (0 → the saved row or null; `<Y>` → the per-year row or null),
and whose `$queryRaw`/`$executeRaw` model Postgres by inspecting the call: a statement containing
`UPDATE` applies `GREATEST(stored, <the numeric value>) + 1` and returns
`[{ nextNumber, prefix, padding }]`; a statement containing `regexp_match` returns `[{ max }]` computed by
running the `^…` string argument as a JS `RegExp` over a `docs` list; any other `^…` argument is the
"taken" probe → `[{ id }]` when some doc matches, else `[]`. Also give it today's per-year surface
(`findUniqueOrThrow` → `{ prefix: "INV-", padding: 4, nextNumber: 1 }`, `update` increments,
`invoice/estimate/creditNote.findFirst` → null) so TODAY's code runs to its wrong value instead of
erroring. Never assert SQL text.

| T#  | Title                                                                                      | Setup                                                                                              | Asserts                                                                              | Fails TODAY with                                |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------- |
| A   | `REG-B861-A a saved INVOICE row (INV-, 10543, pad 5) is the live series`                   | saved row, no docs                                                                                 | `reserveNext("INVOICE",{year:2026})` → `"INV-10543"`                                 | `Expected "INV-10543" Received "INV-2026-0001"` |
| B   | `REG-B861-B max-first: imported INV-10543..INV-10550 after the save → INV-10551`           | saved {INV-,10543,5}; docs INV-10543…INV-10550                                                     | → `"INV-10551"`                                                                      | `Received "INV-2026-0001"`                      |
| C   | `REG-B861-C empty prefix mints a bare number (Q7)`                                         | saved ESTIMATE {"",7,0}                                                                            | `reserveNext("ESTIMATE",{year:2026})` → `"7"`                                        | `Received "EST-2026-0001"`                      |
| J   | `REG-B861-J with opts.tx the configured mint runs on that client and opens no transaction` | as A; `tenantTransaction` spy                                                                      | value `"INV-10543"` (and, second `it`, `tenantTransaction` not called — pin, no REG) | `Received "INV-2026-0001"`                      |
| D   | `REG-B861-D getSettings previews the true next configured number`                          | saved {INV-,10543,5}; docs to INV-10550                                                            | INVOICE row `preview` = `"INV-10551"`                                                | `Received "INV-10543"`                          |
| E   | `REG-B861-E getSettings previews the per-year next when nothing is saved`                  | no saved rows; per-year INVOICE row `<Y>` nextNumber 414                                           | INVOICE `preview` = `` `INV-${Y}-0414` ``                                            | `Received "INV-0001"`                           |
| F   | `REG-B861-F the card lists INVOICE, ESTIMATE, CREDIT_NOTE only (Q6)`                       | none                                                                                               | `settings.map(s=>s.docType)` equals the three                                        | received array contains `"PAYMENT"`             |
| G   | `REG-B861-G a save at or below an existing number is refused, naming it`                   | docs to INV-10550; `updateSettings("INVOICE",{nextNumber:10549})`                                  | rejects `BadRequestException` whose message contains `INV-10550`                     | resolves; value shows `"INV-10549"`             |
| H   | `REG-B861-H a stale card save (expectedNextNumber) is refused with 409`                    | stored row nextNumber 10560; `updateSettings("INVOICE",{prefix:"ACME-",expectedNextNumber:10543})` | rejects `ConflictException`                                                          | resolves; value shows `"ACME-10560"`            |
| I   | `REG-B861-I a no-year mint with no saved row throws and creates no year-0 row`             | no rows                                                                                            | `reserveNext("INVOICE")` rejects `BadRequestException`                               | resolves `"INV-0001"`                           |

Behavioral `wrongValue` for this task: **`INV-2026-0001`** (A, B, J print it).

## Red set — api controller (`apps/api/src/import/numbering.controller.spec.ts`, NEW)

| K | `REG-B861-K PUT /import/numbering/PAYMENT is a 400 (Q6)` | service mock `updateSettings` → `{docType:"PAYMENT",preview:"PAY-0001"}` | `controller.updateSettings("PAYMENT",{})` throws `BadRequestException` (wrap in a promise so a return is observable) | resolves to `…"PAY-0001"…` |

`wrongValue`: **`PAY-0001`**.

## Red set — web (`apps/web/app/(dashboard)/settings/import/numbering-card.test.tsx`, NEW, RTL)

Render the default export `SettingsImportPage`; mock `@/lib/api/numbering` hooks (keep
`formatDocumentNumber` real via `jest.requireActual`), `@/lib/api/import-resolution`,
`@/lib/page-title-context`; server rows = the three types, INVOICE `{INV-,10543,5, preview "INV-10543",
configured:true}`.

| L | `REG-B861-L a prefix-only edit sends the prefix and the loaded next number, nothing else` | type `ACME-` in the Invoices prefix input, click its Save | `mutate` called with `{docType:"INVOICE", data:{prefix:"ACME-", expectedNextNumber:10543}}` (toEqual) | received `data` has `"nextNumber": 10543` and `"padding": 5` |
| M | `REG-B861-M after a 409 the row re-seeds from the server instead of keeping the stale draft` | type `ACME-`, Save; invoke `onError({response:{status:409,data:{message:"…"}}})` | Invoices prefix input value is `"INV-"` | input value `"ACME-"` |

`wrongValue`: **`"padding": 5`**.

## Red set — DB lane (`apps/api/src/import/numbering-continuity.db.spec.ts`, NEW, prover-run)

Harness: copy `apps/api/src/invoices/invoice-numbering.db.spec.ts`'s module wiring, `qa-b861-<run>-<n>`
tenants via `assertTestTenant`, FK-ordered cleanup of exactly this run's tenants. Saves go through
`numberingService.updateSettings` inside `tenantCtx.run`; mints through `reserveNext` (N also through
the real `InvoicesService.create()`).

| T#  | Title                                                                               | Setup → act                                                                              | Expect                                       | Today                                        |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| N   | `REG-B861-N configure next 10543 → the first live invoice is INV-10543`             | save {INV-,10543,5}; `create()` twice                                                    | `INV-10543`, then `INV-10544`                | `INV-<Y>-0001`                               |
| O   | `REG-B861-O imported padded block after the save → INV-8851`                        | save {INV-,8842,4}; seed INV-08842…INV-08850                                             | `INV-8851`                                   | `INV-<Y>-0001`                               |
| P   | `REG-B861-P a -R sibling takes its base number`                                     | save {INV-,500,4}; seed `INV-0500-R1`                                                    | `INV-0501`                                   | `INV-<Y>-0001`                               |
| Q   | `REG-B861-Q prefix "INV." is literal`                                               | save {"INV.",1,4}; seed `INVX0007`                                                       | `INV.0001`                                   | `INV-<Y>-0001`                               |
| R   | `REG-B861-R prefix "INV(" mints without a regex error`                              | save {"INV(",1,4}                                                                        | `INV(0001`                                   | `INV-<Y>-0001`                               |
| S   | `REG-B861-S empty prefix mints bare numerics only above bare numerics`              | save {"",10543,0}; seed `10540`, `INV-<Y>-0005`                                          | `10543`                                      | `INV-<Y>-0006`                               |
| T   | `REG-B861-T a save at or below an existing number is a 400 naming it`               | seed INV-10550; save {nextNumber:10549}                                                  | rejects, message has `INV-10550`             | resolves                                     |
| U   | `REG-B861-U a stale save is a 409 and changes nothing`                              | save {INV-,10543,5}; one mint; save {prefix:"ACME-",expectedNextNumber:10543}            | rejects 409; stored prefix still `INV-`      | resolves; prefix `ACME-`                     |
| V   | `REG-B861-V the per-year collision re-scan escapes its prefix`                      | no saved row; per-year row {prefix "INV(", year <Y>, next 1, pad 4}; seed `INV(<Y>-0001` | `INV(<Y>-0002`                               | rejects: Postgres invalid regular expression |
| W   | `REG-B861-W the unconfigured preview is the per-year next`                          | seed INV-<Y>-0412; one mint                                                              | `getSettings` INVOICE preview `INV-<Y>-0414` | `INV-0001`                                   |
| Y   | `REG-B861-Y 10 concurrent configured mints are INV-10543..INV-10552, none rejected` | save {INV-,10543,5}; 10 parallel `reserveNext`                                           | sorted set equals the ten                    | ten `INV-<Y>-00NN`                           |

## Pins (no REG token)

| Pin | Frozen behavior                                                                                   | File                               |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| P-1 | unconfigured mint byte-identical: seed INV-<Y>-0412 → `INV-<Y>-0413`; zero year-0 rows afterwards | DB spec                            |
| P-2 | `configured` stays year-0-only (T1i keeps `configured:false`, `nextNumber:1`)                     | `invoice-numbering.db.spec.ts` T1i |
| P-3 | RETURN (non-year-scoped) with no year keeps the year-0 fast path, no year segment (P2 retargeted) | unit spec                          |
| P-4 | not dirty → the row shows the server preview                                                      | web test                           |
| P-5 | configured `tx` mint does not call `tenantTransaction` (J's second `it`)                          | unit spec                          |

## Amended on SA-274's word (assertion changes — the reviewer checks each is exactly this)

- `invoice-numbering.db.spec.ts` T1i: drop `preview: "INV-0001"` from `toMatchObject` (title keeps
  REG-B100-D2b; the new expectation is REG-B861-W). Lands in the tests-only commit.
- `numbering.service.spec.ts` "returns all four doc types…" → three types (F covers the red side);
  "ignores the per-year INVOICE rows" → keep `configured:false`/`nextNumber:1`, drop `preview`.
- Unit P2 → retargeted to `RETURN` (P-3); the INVOICE no-year case becomes REG-B861-I.

## Harness notes

- Every existing reserveNext unit test (P1 ×2, seed log, jump, D7, cap, P3) mocks `findUnique` with one
  value for every call; the fix adds a year-0 `findUnique` first → key those mocks on
  `where.tenantId_docType_year.year` (0 → null). Assertions unchanged.
- getSettings/updateSettings now call `requireTenant()` and run scans in a `tenantTransaction`: the
  getSettings/updateSettings unit tests need the tx fake (the shared mock's `getTenantId` already
  returns `"test-tenant"`).
- `UpdateNumberingDto` gains `expectedNextNumber`; web `UpdateNumberingInput` too. Web
  `DocumentNumberType` loses PAYMENT — `DOC_TYPE_LABELS` follows.

## Commands

- api red (unit + controller): `cd apps/api && npx jest src/import/numbering.service.spec.ts src/import/numbering.controller.spec.ts -t "REG-B861" --runInBand`
- web red: `cd apps/web && npx jest "app/\(dashboard\)/settings/import/numbering-card.test.tsx" -t "REG-B861"`
- DB (prover only): `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- src/import/numbering-continuity.db.spec.ts src/invoices/invoice-numbering.db.spec.ts src/credit-notes/credit-note-numbering.db.spec.ts src/import/import-numbering.db.spec.ts src/import/import-numbering-pins.db.spec.ts"`
- Registry proof lines at close-out: `REG-B861-A…Y`.

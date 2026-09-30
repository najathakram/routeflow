# Wave E — structure (one PR)

Branch `fix/imp-wave-e-structure` from `master` after Wave D lands. Commit type **`fix:`** (10b
corrects three live mobile enum drifts → lesson L-05x required). Subject:
`fix(api,web,mobile): wave E — schema folder split, shared DTOs, enum parity` (72). Loop:
dev-pipeline `major` on `pipeline-v3-c8.js`.

## Items

| Item                                                                  | Brief                                                                     | Risk                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 10a `schema.prisma` → `prisma/schema/` domain folder                  | `../2026-09-03-imp-10a-schema-folder-split/brief.md`                      | MED (every schema-path reference; lossless proof via PR-1's drift gate) |
| 10b shared DTOs (95 names) + Prisma-enum parity + 3 mobile enum fixes | `../2026-09-03-imp-10b-shared-dtos/brief.md` + `sweep.md` (the move list) | LOW per edit, wide surface                                              |

## Order inside the wave

Build **10b first** (it does not depend on 10a and its codemod touches `apps/web|mobile/lib/api/*`
only), then **10a** (touches `apps/api/prisma/**`, `prisma.config.ts`, `Dockerfile:19`,
`schema-drift.mjs`, `scan-signatures.mjs`). The `enum-parity.spec.ts` imports enums from
`@prisma/client` — regenerate the client (`npx prisma generate`) after 10a moves the schema
(L-011) and re-run the spec: it must stay green with the folder.

## Combined ownership

- `pE1` `packages/types/api/*.ts` + `index.ts` (Sonnet high, scripted from `sweep.md`)
- `pE2` `scripts/codemods/shared-dto-rewrite.mjs` + web/mobile `lib/api/*` imports + intra-app dedups/renames (Sonnet low)
- `pE3` mobile enum fixes at their call sites (`VendorBillStatus` "FULL"→`PAID`/+`OVERDUE`, `POStatus`→`PurchaseOrderStatus` values, `BuyerPromotion.type` + `BUY_N_GET_M`) (Opus high — behaviour change)
- `pE4` `apps/api/src/common/enum-parity.spec.ts`, `shared-dto-inventory.spec.ts`, mobile `vendor-bill-status.test.ts` (test packages, authored first)
- `pE5` `apps/api/scripts/split-schema.mjs` + the 7 `.prisma` files + `schema.prisma` deletion (Sonnet medium)
- `pE6` `prisma.config.ts`, `apps/api/Dockerfile:19`, `schema-drift.mjs` `--to-schema` folder, `scan-signatures.mjs` (loud catch), workflow comments (Opus high)
- `pE7` `schema-folder.spec.ts`, `no-single-schema-path.spec.ts` (test packages)
- `pE8` bookkeeping: code map (`packages.md`, `api.md` schema section, `web.md`, `mobile.md`), `_meta.json`, `CLAUDE.md` conventions lines, `docs/IMPROVEMENTS.md` row 10 `shipped (wave E)`, `apps/web/Dockerfile` React-pin comment, lesson L-05x (enum parity), `validate-lessons`.

Red gate: `cd apps/api && npx jest src/common/enum-parity.spec.ts src/common/shared-dto-inventory.spec.ts src/common/schema-folder.spec.ts src/common/no-single-schema-path.spec.ts` + `cd apps/mobile && npx jest __tests__/vendor-bill-status.test.ts` — expect fail.

## Gates and pre-merge prod check

`prisma validate` + `format --check`; generated client `.d.ts` diff vs master empty; `npm run local:drift` no diff (lossless); `npm run scan` + `scan:self-test`; `npm run check-types` (all workspaces; `--check` of the DTO codemod = 0 remaining); `npm run verify`; `local:up` image build (Dockerfile COPY); **before merge:** `railway run --service postgres node apps/api/scripts/schema-drift.mjs` → 23 applied, no drift (the rebuild schema gate won't fire — no new migration). Mutation probe: `roundMoney`-class not relevant; targets: a `.prisma` file with a model duplicated (folder spec), `scan-signatures.mjs` catch made silent (spec), `VendorBillStatus` union re-adding "FULL" (parity spec).

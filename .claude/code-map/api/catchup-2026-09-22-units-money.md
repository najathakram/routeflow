# Catch-up 2026-09-22 — units/money family (api `src/`, api `scripts/`, prisma schema, `packages/pricing`)

Anchor: map was last refreshed at `a76e2e2c` (master `b8765689`). This part covers the **api and
packages** drift through master `87117119`. Web and mobile drift from the same window is NOT
covered here — it is still owed by the bookkeeping catch-up PR.

Scope note: most of this window is one family — selling a line **by a unit** rather than by a
pack, and keeping the regulated ledger's quantity axis honest. Read `packages/pricing` first;
api call sites are thin by design.

## `packages/pricing` — the money choke points

| File                   | Exports                                                                                          | Notes                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `build-line.ts`        | `PackAxis`, `UnitAxis`, `BuildLineInput`, `BuiltLine`, `buildLine(input): BuiltLine`              | PR-1 (#1167). The strict builder — one choke point for a line's two axes. New code builds lines here, not by hand.    |
| `legacy-line-pieces.ts`| `LegacyLine`, `LegacyLinePiecesBasis` (`"split"\|"source-boxes"\|"source-pieces"\|"non-boxed-now"`), `LegacyLinePiecesResult`, `LegacyLinePiecesOptions`, `legacyLinePieces(...)` | #1202 (supersedes #1179). Classifies a **boxes-null** line's true piece count. `basis` names *why*, so callers never re-guess. |
| `po-line.ts`           | `POCaseLineInput`, `POPieceLineInput`, `POLineAmounts`, `buildPOLine(...)`, `derivedCaseCost(...)` | #1199. Exact PO totals from the entered case cost. **`resolvePOLineAmounts(...).totalCost` is the only total** — a UI that re-derives over-charges. |
| `pricing.ts`, `index.ts` | (barrel + existing helpers)                                                                      | `computeLineSubtotal` / `normalizeBoxesPieces` / `roundMoney` unchanged; strict subtotal sibling added in #1167.      |

## `apps/api/src/orders` — units_v1

| File                       | Exports                                                                                                                   | Notes                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `unit-line-build.ts`       | `UnitLineRequest`, `UnitLineProduct`, `requestsUnit(item)`, `isUnitAware(resolved)`, `replayLineKey(...)`, `categoryTaxForLine(...)`, `MAX_LINE_QTY` (9_999_999), `MAX_LINE_SUBTOTAL` (99_999_999.99) | A line is unit-aware iff `resolved.unitLabel != null`. Both caps are hard write-time limits. |
| `unit-line-edit.ts`        | `UnitEditContext`, `assertUnitLabelNamed(...)`, `UnitWriteContext`                                                          | Edit path. A unit line may never be re-saved as a pack line (B641).                        |
| `unit-aware-guard.ts`      | `UNIT_AWARE_LINE`, `isUnitAwareLine(li)`, `ORDER_HAS_NO_UNIT_AWARE_LINE`, `assertNoUnitAwareLines(...)`, `assertChangeTargetAllowed(...)` | Refusal codes are the contract — web/mobile match on them.                                  |
| `order-edit-restrictions.ts`| `EXISTING_LINE_SELECT`, `OrderEditMode` (`{kind:"merge"} \| {kind:"replace";actor}`), `orderEditMode(...)`, `OrderEditRestrictionPlan` | Merge vs replace-all is decided here, not in the service.                                  |
| `order-edit-payload.ts`    | `classifyEditPayload(...)`                                                                                                  | Splits a mixed edit payload before any write.                                               |
| `unit-line-edit`/`unit-line-build` call sites | `orders.service.ts`, `change-requests.service.ts`, `order-lifecycle.ts`, `dto/update-order-items.dto.ts`  | `updateOrderItems` sells/edits by a unit for staff (#1148). **Never thread a transaction into `updateOrderItems`.** |

`createUnitLine` (in `unit-line-edit.ts`) writes a sales-line model, so it must be registered in
the copier contract or `NOT_A_COPIER` — an unregistered writer fails `copier-contract-spec`.

## `apps/api/src/invoices` / `inventory` / `estimates` / `import` / `vendor-bills`

- `invoices/invoice-unit-line.ts` — `buildInvoiceUnitLine(input)`. Unit line → invoice line.
- `invoices/manual-invoice-lines.ts` — `buildManualInvoiceLines(...)`.
- `invoices/invoices.service.ts`, `dto/create-invoice.dto.ts` — unit lines end-to-end; B644 levy
  on a duplicated regulated invoice.
- `inventory/po-line-input.ts` — `poLineFromInput(raw)`; with `dto/update-purchase-order.dto.ts`
  and `inventory.service.ts` carries #1199's exact-totals shape and the B583 re-apply replay.
- `estimates/estimates.service.ts` — box split survives estimate→invoice conversion (B645).
- `import/batch-import.service.ts` — a scanned `packSize` reaches batch-imported bill lines (B666).

## `apps/api/prisma/schema`

- `sales.prisma`, `finance.prisma` — carry the unit/ledger columns this family writes
  (`unitLabel`, `unitsPerBox` snapshots, the `regulatedSalesLedger` quantity axes). Schema is a
  **folder**: add a model to its domain file **and** to `MODEL_DOMAIN` in
  `scripts/split-prisma-schema.mjs`, or `--check` fails.

## `apps/api/scripts`

- `data-questions-report.mjs` + `lib/data-questions.cjs` — read-only report for the units/levy
  findings (#1168, review fixes #1186).
- `t6-null-census.mjs`, `t6-null-rows-report.mjs`, `t6-stamp-null-rows.mjs`,
  `t6-backfill-census.mjs`, `t6-drop-guards.mjs` — the NULL-tenant T6 census/backfill set.
  Read-only or dry-run-first; tenant-scoped entry points call `assertTestTenant`.
- `lib/local-db-target.cjs` — resolves the local compose DB target for the db-spec lane.
- `e2e-seed.js` — fails closed, no production default for setup (#1158).
- `src/common/testing/db-spec.ts` — harness for the `*.db.spec.ts` lane (`npm run local:test:db`).

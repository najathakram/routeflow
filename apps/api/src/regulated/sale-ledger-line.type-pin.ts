import type { SaleLedgerLine } from "./regulated-ledger.service";

/**
 * B661: pins that no caller can pass a precomputed `unitBasisQty` on a `SaleLedgerLine` —
 * `writeSaleEntries` is the ONLY place it's derived (via `regulatedUnitBasis`). This lives in a
 * plain `.ts` file, not a `.spec.ts`: `apps/api/tsconfig.json` excludes every `*.spec.ts` /
 * `*.test.ts` from `check-types`, so a `@ts-expect-error` written inside a spec file is never
 * actually type-checked and silently pins nothing (caught the hard way while writing this one —
 * see the B661 PR). This file has no test runner attached to it at all; its only job is to be
 * part of the normal `tsc --noEmit` program, where `check-types` fails if the line below stops
 * being a real type error (an unused `@ts-expect-error` directive is itself an error).
 */
const _pinsCallerCannotSetUnitBasisQty: SaleLedgerLine = {
  invoiceItemId: "x",
  orderItemId: null,
  trackedCategoryId: null,
  qty: 1,
  // @ts-expect-error — unitBasisQty is not a field of SaleLedgerLine; the ledger derives it itself.
  unitBasisQty: 1,
  netSales: 0,
  categoryTax: 0,
};
void _pinsCallerCannotSetUnitBasisQty;

import * as cas from "../partial-invoice-cas";

// Captured once, at load — before any spy — so a repeated beforeEach never wraps its own spy.
const realBump = cas.bumpInvoicedQtyCas;

/**
 * #2645 / SA-523d — TEST-ONLY. The invoice CAS pins the whole order-line billing basis
 * (`INVOICE_LINE_CAS_FIELDS`) and refuses an `undefined` field (SA-511c). Real rows always carry every
 * column (both callers read lineItems with `include`), but the service specs' hand-built order fixtures
 * predate the basis pin and name only the fields their own assertion needs.
 *
 * For those INCIDENTAL specs (the CAS itself is not what they test) this spy fills each absent basis
 * field with `null` on the way INTO the real `bumpInvoicedQtyCas` — only the CAS's `where` sees the
 * fill; the invoice lines were already built from the untouched fixture, so no money changes. The
 * CAS-focused specs (partial-invoice-cas-2070 / split-invoice-cas-2612) use complete rows instead.
 * Call from a `beforeEach`; jest's `restoreMocks`/`mockRestore` undoes it.
 */
export function fillSparseCasBasis(): jest.SpyInstance {
  if (jest.isMockFunction(cas.bumpInvoicedQtyCas))
    (cas.bumpInvoicedQtyCas as jest.Mock).mockRestore();
  return jest.spyOn(cas, "bumpInvoicedQtyCas").mockImplementation((tx, items, itemById) =>
    realBump(
      tx,
      items,
      new Map(
        [...itemById].map(([id, li]) => [
          id,
          li == null
            ? li
            : {
                ...Object.fromEntries(cas.INVOICE_LINE_CAS_FIELDS.map((f) => [f, null])),
                ...Object.fromEntries(Object.entries(li).filter(([, v]) => v !== undefined)),
              },
        ]),
      ),
    ),
  );
}

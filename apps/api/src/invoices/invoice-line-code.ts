import {
  invoiceLineDisplay,
  printedInvoiceCode,
  type InvoiceCodeChoice,
  type InvoiceLineDisplayInput,
  type LadderView,
  type ProductCodes,
  type UnitRef,
} from "@routeflow/pricing";

/**
 * S19: the code printed under an invoice line, with how the line READS (`invoiceLineDisplay(...).mode`) passed to
 * `printedInvoiceCode` (its `lineMode` is required). A line that reads in the unit sold prints the sold unit's code, even
 * when the tenant's invoice unit is another one. DISPLAY ONLY (G1): nothing here feeds money; the file is listed in
 * invoice-unit-display-only.spec.ts. `choice` `legacy` is today's chain, byte for byte.
 */
export function invoiceLineCode(args: {
  choice: InvoiceCodeChoice;
  codes: ProductCodes;
  view: LadderView;
  legacyCodes: Pick<ProductCodes, "unitSku" | "barcode" | "sku"> | null | undefined;
  /** The level ref of the unit the line was sold in; null when not known (the pack). */
  soldUnit: UnitRef | null | undefined;
  line: InvoiceLineDisplayInput;
}): string | null {
  const { mode } = invoiceLineDisplay(args.line);
  return printedInvoiceCode(
    args.choice,
    args.codes,
    args.view,
    args.legacyCodes,
    args.soldUnit,
    mode,
  );
}

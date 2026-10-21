import { round4 } from "./pricing";
import type { LadderView, UnitRef } from "./price-ladder";
/** What the printed code needs from a resolved invoice unit (`InvoiceUnitChoice` fits). */
export type InvoiceCodeChoice =
  { mode: "legacy" } | { mode: "ordered" } | { mode: "unit"; unit: UnitRef; label?: string };

// Units and prices, pricing core C: the invoice unit on a document (PLAN §1.6, SA-795 fold G1).
//
// G1, the money guard: the invoice unit is DISPLAY ONLY. The 4-decimal unit price shown here (amount / quantity in the
// invoice unit) must never feed money. Line totals, tax and payments use the stored line amount; a credit note from an invoice
// line computes in the UNIT SOLD (`creditedThrough(amount, qty, line qty)`), never from `unitPrice` below. A source pin
// (apps/api/src/common/invoice-unit-display-only.spec.ts) forbids this module in any money writer.

export interface InvoiceLineDisplayInput {
  /** Total base pieces on the line (qty in the unit sold x its pieces). */
  pieces: number;
  /** The stored line amount. Echoed back untouched. */
  amount: number;
  /** The line as stored: quantity, unit and unit price in the unit sold. */
  sold: { label: string; qty: number; unitPrice: number };
  /** The resolved invoice unit; null for legacy and ordered (they show the unit sold). */
  invoiceUnit: { label: string; factor: number } | null;
}

export interface InvoiceLineDisplay {
  mode: "invoice-unit" | "unit-sold";
  qty: number;
  unitLabel: string;
  /** invoice-unit: amount / qty to 4 decimals (display only). unit-sold: the stored unit price. */
  unitPrice: number;
  amount: number;
}

/**
 * How a line reads on an invoice. In the invoice unit only when the line is a whole number of it (T17: 3 Boxes of 24 are
 * 72 Pieces); otherwise it stays in the unit sold (T18: 30 pieces are not a whole number of 24-piece boxes). The amount
 * never changes.
 */
export function invoiceLineDisplay(input: InvoiceLineDisplayInput): InvoiceLineDisplay {
  const { pieces, amount, sold, invoiceUnit } = input;
  const unitSold: InvoiceLineDisplay = {
    mode: "unit-sold",
    qty: sold.qty,
    unitLabel: sold.label,
    unitPrice: sold.unitPrice,
    amount,
  };
  if (!invoiceUnit) return unitSold;
  const factor = invoiceUnit.factor;
  if (!Number.isInteger(factor) || factor < 1 || !Number.isInteger(pieces) || pieces < 1)
    return unitSold;
  if (pieces % factor !== 0) return unitSold;
  const qty = pieces / factor;
  return {
    mode: "invoice-unit",
    qty,
    unitLabel: invoiceUnit.label,
    unitPrice: round4(amount / qty),
    amount,
  };
}

// ─── One code per unit ────────────────────────────────────────────────────────────────────────

export interface ProductCodes {
  sku?: string | null;
  barcode?: string | null;
  unitSku?: string | null;
  /** ProductUnit.sku by unit ref, for the units between the pack and the base. */
  unitCodes?: Readonly<Record<UnitRef, string | null | undefined>>;
}

const nz = (v: string | null | undefined): string | null => (v == null || v === "" ? null : v);

/** Today's invoice code, byte for byte: the unit code, else the barcode, else the SKU (apps/api invoiceItemCode). */
export function legacyInvoiceCode(
  p: Pick<ProductCodes, "unitSku" | "barcode" | "sku"> | null | undefined,
): string | null {
  return p?.unitSku ?? p?.barcode ?? p?.sku ?? null;
}

/**
 * A unit's own code (owner requirement 6: the barcode IS the SKU). The pack: barcode, else SKU. The base: its unit code, else
 * the shared barcode counts as the base's (legacy), else the SKU. Any other unit: its own code, or none.
 */
export function unitCodeOf(codes: ProductCodes, ref: UnitRef): string | null {
  if (ref === "pack") return nz(codes.barcode) ?? nz(codes.sku);
  // SA-809: the 1-piece row's own code is stored under the level ref "base" (never its ProductUnit id).
  if (ref === "base")
    return nz(codes.unitCodes?.base) ?? nz(codes.unitSku) ?? nz(codes.barcode) ?? nz(codes.sku);
  return nz(codes.unitCodes?.[ref]);
}

/**
 * The code printed on an invoice line. `legacy` prints today's chain. `ordered` prints the unit sold's code (the pack when
 * the sold unit is not known). A unit prints its own code, unless the line reads in the unit sold (`lineMode`).
 */
export function printedInvoiceCode(
  choice: InvoiceCodeChoice,
  codes: ProductCodes,
  view: LadderView,
  legacyCodes: Pick<ProductCodes, "unitSku" | "barcode" | "sku"> | null | undefined,
  soldUnit: UnitRef | null | undefined,
  /** How the line reads (`invoiceLineDisplay(...).mode`). Required: a caller that forgets it would print the wrong code. */
  lineMode: InvoiceLineDisplay["mode"],
): string | null {
  if (choice.mode === "legacy") return legacyInvoiceCode(legacyCodes ?? codes);
  // A line that reads in the unit sold (T18: not a whole number of the invoice unit) prints the sold unit's code.
  const ref =
    choice.mode === "unit" && lineMode !== "unit-sold" ? choice.unit : (soldUnit ?? "pack");
  const row = view.rows.find((r) => r.ref === ref);
  const kind = row?.kind;
  return unitCodeOf(codes, kind === "pack" ? "pack" : kind === "base" ? "base" : ref);
}

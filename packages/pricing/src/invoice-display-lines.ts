import type { InvoiceDisplayUnitView } from "@routeflow/types";
import { componentSubLineText } from "./component-pieces";
import { invoiceLineDisplay } from "./invoice-display";
import { prorateComponentCredit } from "./largest-remainder";
import { legacyLinePieces } from "./legacy-line-pieces";
import { isWholeCents, round4 } from "./pricing";
import type { LadderView } from "./price-ladder";
import { resolveInvoiceUnit, type UnitScopes } from "./unit-default";
import { PIECE_LABEL } from "./unit-levels";

// SA-827: how an invoice line READS for a customer who invoices in pieces. DISPLAY ONLY: the stored box line stays authoritative
// for money, tax, the regulated ledger, credits, returns and stock. Nothing here is stored or summed. A source pin
// (apps/api/src/common/invoice-unit-display-only.spec.ts) keeps these names out of every money writer.

export type CustomerInvoiceUnitDefault = "LEGACY" | "PIECES" | "PACK";

const LEGACY_VIEW: InvoiceDisplayUnitView = { kind: "legacy", label: null };

export function invoiceDisplayUnitFor(input: {
  customerDefault?: CustomerInvoiceUnitDefault | null;
  scopes: UnitScopes;
  view: LadderView | null;
}): InvoiceDisplayUnitView {
  try {
    const { customerDefault, scopes, view } = input;
    if (customerDefault === "PIECES") {
      const base = view?.rows.find((r) => r.kind === "base");
      return { kind: "pieces", label: base?.label?.trim() || PIECE_LABEL };
    }
    if (customerDefault === "PACK") return { ...LEGACY_VIEW };
    if (!view) return { ...LEGACY_VIEW };
    const choice = resolveInvoiceUnit(view, scopes);
    if (choice.mode !== "unit") return { ...LEGACY_VIEW };
    const row = view.rows.find((r) => r.ref === choice.unit);
    if (row?.kind === "base") return { kind: "pieces", label: choice.label };
    return { ...LEGACY_VIEW };
  } catch {
    return { ...LEGACY_VIEW };
  }
}

/**
 * The (label, factor) written at first issue: the pieces kind only. A legacy line writes nothing (null): an issued invoice
 * with no snapshot reads legacy, and a stored label+factor 1 would read back as pieces.
 */
export function displayUnitSnapshotOf(
  unit: InvoiceDisplayUnitView,
): { label: string; factor: 1 } | null {
  if (unit.kind !== "pieces") return null;
  return { label: unit.label ?? PIECE_LABEL, factor: 1 };
}

/** The display unit an item renders in. DRAFT: live. Otherwise the snapshot; none (issued before SA-827) is legacy. */
export function displayUnitForItem(
  status: string,
  snap: { label: string | null; factor: number | null },
  live: InvoiceDisplayUnitView | null,
): InvoiceDisplayUnitView {
  if (status === "DRAFT") return live ?? { ...LEGACY_VIEW };
  if (snap.factor === 1 && snap.label) return { kind: "pieces", label: snap.label };
  return { ...LEGACY_VIEW };
}

export interface InvoiceDisplayItemInput {
  description: string;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  unitPrice: number;
  subtotal: number;
  categoryTax?: { name: string; amount: number } | null;
}
export interface InvoiceDisplayComponentInput {
  componentProductId: string;
  name: string;
  qty: number;
  unitSku?: string | null;
  unitBarcode?: string | null;
  displayUnitPrice4?: number | null;
  position: number;
}
export type InvoiceDisplayLines =
  | { layout: "today"; subLines: string[] }
  | { layout: "pieces"; qty: number; unitLabel: string; unitPrice: number; amount: number }
  | {
      layout: "components";
      rows: Array<{
        componentProductId: string;
        name: string;
        qty: number;
        unitLabel: string;
        unitSku: string | null;
        unitBarcode: string | null;
        unitPrice: number;
        amount: number;
      }>;
      groupTotal: { description: string; amount: number };
      categoryTax: { label: string; amount: number } | null;
    };

export function invoiceDisplayLines(
  item: InvoiceDisplayItemInput,
  components: ReadonlyArray<InvoiceDisplayComponentInput> | null | undefined,
  displayUnit: InvoiceDisplayUnitView | null | undefined,
): InvoiceDisplayLines {
  const sorted = [...(components ?? [])].sort((a, b) => a.position - b.position);
  let today: InvoiceDisplayLines = { layout: "today", subLines: [] };
  try {
    today = { layout: "today", subLines: sorted.map((c) => componentSubLineText(c)) };
    if (!displayUnit || displayUnit.kind !== "pieces" || item.unitLabel) return today;
    const lp = legacyLinePieces(item);
    if ("unknown" in lp || lp.basis !== "split") return today;
    const linePieces = lp.pieces;
    if (!Number.isInteger(linePieces) || linePieces <= 0) return today;
    const unitLabel = displayUnit.label ?? PIECE_LABEL;
    const sum = sorted.reduce((a, c) => a + c.qty, 0);
    const compOk =
      sorted.length > 0 &&
      sorted.every((c) => Number.isInteger(c.qty) && c.qty >= 0) &&
      sum === linePieces &&
      Number.isFinite(item.subtotal) &&
      item.subtotal >= 0 &&
      isWholeCents(item.subtotal);
    if (compOk) {
      try {
        const { parts } = prorateComponentCredit({
          storedSubtotal: item.subtotal,
          linePieces,
          priorPieces: 0,
          parts: sorted.map((c) => c.qty),
        });
        const rows = sorted
          .map((c, i) => ({ c, amount: parts[i] }))
          .filter(({ c }) => c.qty > 0)
          .map(({ c, amount }) => ({
            componentProductId: c.componentProductId,
            name: c.name,
            qty: c.qty,
            unitLabel,
            unitSku: c.unitSku ?? null,
            unitBarcode: c.unitBarcode ?? null,
            unitPrice: round4(amount / c.qty),
            amount,
          }));
        return {
          layout: "components",
          rows,
          groupTotal: { description: item.description, amount: item.subtotal },
          categoryTax: item.categoryTax
            ? { label: `${item.categoryTax.name} tax`, amount: item.categoryTax.amount }
            : null,
        };
      } catch {
        // fall through to the pieces layout
      }
    }
    if ((item.unitsPerBox ?? 1) > 1) {
      const d = invoiceLineDisplay({
        pieces: linePieces,
        amount: item.subtotal,
        sold: { label: "", qty: item.qty, unitPrice: item.unitPrice },
        invoiceUnit: { label: unitLabel, factor: 1 },
      });
      if (d.mode === "invoice-unit") {
        return {
          layout: "pieces",
          qty: d.qty,
          unitLabel: d.unitLabel,
          unitPrice: d.unitPrice,
          amount: d.amount,
        };
      }
    }
    return today;
  } catch {
    return today;
  }
}

/**
 * SA-827 rule 3: the line's category/excise tax for the pieces view's "{category} tax" row. ONE mapping for every renderer;
 * the amount is the stored line levy, echoed, never computed.
 */
export function invoiceDisplayCategoryTax(item: {
  categoryTaxAmount?: number | string | null;
  trackedCategory?: { name?: string | null } | null;
}): { name: string; amount: number } | null {
  const amount = Number(item.categoryTaxAmount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { name: item.trackedCategory?.name?.trim() || "Category", amount };
}

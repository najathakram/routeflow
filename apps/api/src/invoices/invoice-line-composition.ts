import { allocateComponentPieces, componentUnitPrice4, roundMoney } from "@routeflow/pricing";

/** The slice of an ORDER line (with its component rows) the invoice carry reads. */
export interface OrderLineWithComponents {
  compositionMode?: string | null;
  recipeId?: string | null;
  recipeVersion?: number | null;
  qty?: unknown;
  components?: Array<{
    componentProductId: string;
    qty: number | { toString(): string };
    name: string;
    unitSku: string | null;
    unitBarcode: string | null;
    barcodeSymbology: string | null;
    position: number;
  }> | null;
}

/**
 * #2717 M3 (SA-579 case 11, SA-589/590): the composition columns of an INVOICE line built from a
 * FIXED order line, or `{}` for every plain line (so the built object is byte-identical to before).
 *
 * The component rows are frozen copies (name, sku, barcode) of the order line's rows for the
 * pieces THIS bill covers (`allocateComponentPieces`, cumulative from `priorBilled`), each priced
 * `componentUnitPrice4(roundMoney(this line's net subtotal), billed pieces)` — per invoice line,
 * display only (I5), never a link back to the order component. `tenantId` is set on every nested
 * row because nested creates are not tenant-injected. When the stored components no longer add up
 * to the order line's pieces (or there is no tenant, or the bill is not whole pieces) the line is
 * carried plain: invoicing is never blocked by display data (Q7).
 */
export function invoiceCompositionFields(
  li: OrderLineWithComponents,
  pieces: number,
  priorBilled: number,
  netSubtotal: number,
  tenantId: string | null,
) {
  if (li.compositionMode !== "FIXED") return {};
  const stamp = {
    compositionMode: "FIXED" as const,
    recipeId: li.recipeId ?? null,
    recipeVersion: li.recipeVersion ?? null,
  };
  const comps = [...(li.components ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ ...c, qty: Number(c.qty) }));
  const total = comps.reduce((a, c) => a + c.qty, 0);
  if (
    !tenantId ||
    comps.length === 0 ||
    total !== Number(li.qty) ||
    !Number.isInteger(pieces) ||
    !Number.isInteger(priorBilled) ||
    pieces <= 0 ||
    priorBilled + pieces > total
  ) {
    return stamp;
  }
  const parts = allocateComponentPieces({
    comps: comps.map((c) => ({ componentProductId: c.componentProductId, qty: c.qty })),
    prior: priorBilled,
    bill: pieces,
  });
  const displayUnitPrice4 = componentUnitPrice4(roundMoney(netSubtotal), pieces);
  const create = comps.flatMap((c, i) =>
    parts[i].qty > 0
      ? [
          {
            tenantId,
            componentProductId: c.componentProductId,
            qty: parts[i].qty,
            name: c.name,
            unitSku: c.unitSku,
            unitBarcode: c.unitBarcode,
            barcodeSymbology: c.barcodeSymbology as never,
            displayUnitPrice4,
            position: c.position,
          },
        ]
      : [],
  );
  return create.length > 0 ? { ...stamp, components: { create } } : stamp;
}

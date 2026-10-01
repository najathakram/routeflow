import type { LineComponentView } from "@routeflow/types";

interface ComponentRowLike {
  id?: string;
  componentProductId: string;
  name: string;
  qty: number | { toString(): string };
  unitSku?: string | null;
  unitBarcode?: string | null;
  barcodeSymbology?: string | null;
  displayUnitPrice4?: { toString(): string } | number | string | null;
  position?: number | null;
}

/**
 * #2717 M3: the ONE read mapper of a frozen component row (order or invoice side) for clients. A
 * Decimal price becomes a number, null stays null; tenant and parent keys are dropped. This and the
 * PDF sub-line mapper are the only readers of `displayUnitPrice4` (display-unit-price-i5.spec.ts).
 */
export function toLineComponentView(row: ComponentRowLike): LineComponentView {
  const price = row.displayUnitPrice4;
  return {
    ...(row.id !== undefined ? { id: row.id } : {}),
    componentProductId: row.componentProductId,
    name: row.name,
    qty: Number(row.qty),
    unitSku: row.unitSku ?? null,
    unitBarcode: row.unitBarcode ?? null,
    barcodeSymbology: row.barcodeSymbology ?? null,
    displayUnitPrice4: price == null ? null : Number(price),
    position: row.position ?? 0,
  };
}

export function toLineComponentViews(
  rows: ComponentRowLike[] | null | undefined,
): LineComponentView[] {
  return [...(rows ?? [])]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(toLineComponentView);
}

/**
 * The findOne wiring (order `lineItems`, invoice `items`): every line that carries a `components`
 * list gets it as views; a line without the key (a plain line, a mocked read) is returned as is.
 */
export function withComponentViews<T extends { components?: ComponentRowLike[] | null }>(
  lines: T[] | null | undefined,
): T[] | null | undefined {
  if (!lines) return lines;
  return lines.map((l) =>
    l.components ? { ...l, components: toLineComponentViews(l.components) } : l,
  );
}

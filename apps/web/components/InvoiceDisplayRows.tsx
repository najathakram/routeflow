import * as React from "react";
import { plural, type InvoiceDisplayLines } from "@routeflow/pricing";

/** SA-827: the component rows (and category-tax row) of a composed box line. Every figure comes from
 * invoiceDisplayLines (packages/pricing); this only formats and lays them out. The box line's OWN
 * row (notes, promo, MSRP, amount, every staff field) is passed as `children` and renders between
 * the component rows and the tax row; the pieces layout is that same row with two cells swapped,
 * built by the page. */
export type InvoiceDisplayComponents = Extract<InvoiceDisplayLines, { layout: "components" }>;

interface Props {
  lines: InvoiceDisplayComponents;
  itemId: string;
  /** The box line's own row, rendered after the component rows. */
  children: React.ReactNode;
  /** The page's own money formatter (amounts). */
  fmt: (n: number) => string;
  variant: "staff" | "buyer";
}

export function formatUnitPrice4(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(n);
}

/** "30 Pieces" / "1 Piece" via the repo's unit-word plural helper. */
export function displayQtyText(qty: number, unitLabel: string): string {
  return `${qty} ${plural(unitLabel, qty)}`;
}

const CELL = {
  staff: {
    tr: "hover:bg-surface-raised",
    first: "px-8 py-3 font-medium text-navy",
    qty: "px-4 py-3 text-right mono text-navy/70",
    price: "px-4 py-3 text-right text-navy/70",
    amount: "px-4 py-3 text-right font-medium text-navy",
  },
  buyer: {
    tr: "block space-y-1 px-4 py-3 hover:bg-surface-raised/50 sm:table-row sm:space-y-0 sm:p-0",
    first: "block text-sm font-medium text-navy sm:table-cell sm:px-4 sm:py-3",
    qty: "flex items-baseline justify-between gap-3 text-sm before:text-xs before:uppercase before:tracking-wider before:text-navy/70 before:content-[attr(data-label)] sm:before:hidden sm:table-cell sm:px-4 sm:py-3 sm:text-right text-navy",
    price:
      "flex items-baseline justify-between gap-3 text-sm before:text-xs before:uppercase before:tracking-wider before:text-navy/70 before:content-[attr(data-label)] sm:before:hidden sm:table-cell sm:px-4 sm:py-3 sm:text-right tabular-nums text-navy/70",
    amount:
      "flex items-baseline justify-between gap-3 text-sm before:text-xs before:uppercase before:tracking-wider before:text-navy/70 before:content-[attr(data-label)] sm:before:hidden sm:table-cell sm:px-4 sm:py-3 sm:text-right tabular-nums font-medium text-navy",
  },
} as const;

const LABELS = { qty: "Qty", price: "Unit Price", amount: "Subtotal" } as const;

export function InvoiceDisplayRows({ lines, itemId, fmt, variant, children }: Props) {
  const c = CELL[variant];
  const lab = (k: keyof typeof LABELS) => (variant === "buyer" ? LABELS[k] : undefined);
  return (
    <>
      {lines.rows.map((r) => (
        <tr
          key={r.componentProductId}
          className={c.tr}
          data-testid={`display-row-${itemId}-${r.componentProductId}`}
        >
          <td className={c.first}>
            {r.name}
            {(r.unitSku || r.unitBarcode) && (
              <p className="mt-0.5 text-xs font-normal text-navy/60">
                {[r.unitSku ? `SKU ${r.unitSku}` : null, r.unitBarcode].filter(Boolean).join(" | ")}
              </p>
            )}
          </td>
          <td className={c.qty} data-label={lab("qty")}>
            {displayQtyText(r.qty, r.unitLabel)}
          </td>
          <td className={c.price} data-label={lab("price")}>
            {formatUnitPrice4(r.unitPrice)}
          </td>
          <td className={c.amount} data-label={lab("amount")}>
            {fmt(r.amount)}
          </td>
        </tr>
      ))}
      {children}
      {lines.categoryTax && (
        <tr className={c.tr} data-testid={`display-category-tax-${itemId}`}>
          <td className={c.first}>{lines.categoryTax.label}</td>
          <td className={c.qty} />
          <td className={c.price} />
          <td className={c.amount} data-label={lab("amount")}>
            {fmt(lines.categoryTax.amount)}
          </td>
        </tr>
      )}
    </>
  );
}

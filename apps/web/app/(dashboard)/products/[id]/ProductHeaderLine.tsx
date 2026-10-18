import * as React from "react";
import Link from "next/link";
import { stockCountLabel } from "../_components/product-status";
import { UNITS_V2_TESTIDS } from "./units-v2-testids";

/** The page header's provenance line: SKU · Category (or Variant of …) · on-hand count. */
export function ProductHeaderLine({
  product,
  currentStock,
  pricesV2,
}: {
  product: {
    sku?: string | null;
    category?: string | null;
    parent?: { name: string } | null;
    kind?: string | null;
  };
  currentStock: number;
  pricesV2?: boolean;
}) {
  const v2 = pricesV2 === true;
  const origin = product.parent ? `Variant of ${product.parent.name}` : product.category;
  const parts: React.ReactNode[] = [];
  if (product.sku) parts.push(<span className="font-mono">{product.sku}</span>);
  if (origin) parts.push(origin);
  // A family is a non-stocked container, so it carries no count.
  if (v2) {
    // Units v2: counts live on the Inventory page; a family cannot be sold.
    if (product.kind === "FAMILY")
      parts.push(
        <span data-testid={UNITS_V2_TESTIDS.familyHeader}>
          Family. Can&apos;t be sold. Choose a variant.
        </span>,
      );
    else
      parts.push(
        <>
          Stock:{" "}
          <Link
            href="/inventory"
            aria-label="Stock: see Inventory"
            data-testid={UNITS_V2_TESTIDS.headerStockLink}
            className="font-medium text-brand-600 hover:underline"
          >
            see Inventory
          </Link>
        </>,
      );
  } else if (product.kind !== "FAMILY")
    parts.push(<span className="font-medium tabular-nums">{stockCountLabel(currentStock)}</span>);
  return (
    <p className="mt-1.5 text-sm text-navy/70">
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 ? " · " : ""}
          {part}
        </React.Fragment>
      ))}
    </p>
  );
}

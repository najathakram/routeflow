import * as React from "react";
import { stockCountLabel } from "../_components/product-status";

/** The page header's provenance line: SKU · Category (or Variant of …) · on-hand count. */
export function ProductHeaderLine({
  product,
  currentStock,
}: {
  product: {
    sku?: string | null;
    category?: string | null;
    parent?: { name: string } | null;
    kind?: string | null;
  };
  currentStock: number;
}) {
  const origin = product.parent ? `Variant of ${product.parent.name}` : product.category;
  const parts: React.ReactNode[] = [];
  if (product.sku) parts.push(<span className="font-mono">{product.sku}</span>);
  if (origin) parts.push(origin);
  // A family is a non-stocked container, so it carries no count.
  if (product.kind !== "FAMILY")
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

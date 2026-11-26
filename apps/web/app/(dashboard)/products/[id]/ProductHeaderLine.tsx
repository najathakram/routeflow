import * as React from "react";
import Link from "next/link";
import { pricedPerLabel } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { stockCountLabel } from "../_components/product-status";
import { UNITS_V2_TESTIDS } from "./units-v2-testids";

/**
 * Open the page's own Units and prices section through the jump strip's link (its scroll clearance, focus and settle
 * rules); with no strip on the page the plain hash link does the jump.
 */
function openUnitsAndPrices(e: React.MouseEvent<HTMLAnchorElement>) {
  const strip = document.querySelector<HTMLAnchorElement>('nav a[href="#h-units"]');
  if (!strip || strip === e.currentTarget) return;
  e.preventDefault();
  strip.click();
}

/** The page header's provenance line: SKU · Category (or Variant of …) · on-hand count. */
export function ProductHeaderLine({
  product,
  currentStock,
  pricesV2,
}: {
  product: {
    name?: string | null;
    sku?: string | null;
    category?: string | null;
    parent?: { name: string } | null;
    kind?: string | null;
    unit?: string | null;
    unitsPerBox?: number | null;
    pricePerUnit?: number | string | null;
  };
  currentStock: number;
  pricesV2?: boolean;
}) {
  const v2 = pricesV2 === true;
  // F5: the Inventory page reads ?search= (useUrlSearch), so the link lands on this product, not the whole list.
  const find = product.sku || product.name;
  const inventoryHref = find ? `/inventory?search=${encodeURIComponent(find)}` : "/inventory";
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
    else {
      // F11: the product opens with no price in view, so the header says it and links to Units and prices.
      const price = Number(product.pricePerUnit);
      if (product.pricePerUnit != null && product.pricePerUnit !== "" && Number.isFinite(price))
        parts.push(
          <>
            Price:{" "}
            <a
              href="#h-units"
              data-testid={UNITS_V2_TESTIDS.headerPriceLink}
              onClick={openUnitsAndPrices}
              className="font-medium text-brand-600 hover:underline"
            >
              {formatMoney(price)}
              {product.unit
                ? ` / ${pricedPerLabel({ unit: product.unit, unitsPerBox: product.unitsPerBox }).word}`
                : ""}
            </a>
          </>,
        );
      parts.push(
        <>
          Stock:{" "}
          <Link
            href={inventoryHref}
            aria-label="Stock: see Inventory"
            data-testid={UNITS_V2_TESTIDS.headerStockLink}
            className="font-medium text-brand-600 hover:underline"
          >
            see Inventory
          </Link>
        </>,
      );
    }
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

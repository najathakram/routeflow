"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@routeflow/ui/web";

/**
 * F10: a product's name as a real link to its page, so Tab reaches it and Enter opens it (the card and
 * the list row were click-only, so a keyboard user could not open a product from /products).
 *
 * `stretched` (grid card): the link's `::after` covers the whole card (the card is `relative`), so the
 * mouse still clicks anywhere on it. Other controls on the card sit above with `relative z-10`.
 * Its focus ring is drawn on that overlay, so the whole card shows where focus is.
 *
 * The click stops here: the card and the table row also have their own click-to-open handler for mouse
 * users, and one click must open the product once.
 */
export function ProductNameLink({
  id,
  stretched,
  children,
}: {
  id: string;
  stretched?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={`/products/${id}`}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "hover:underline focus-visible:outline-none",
        stretched
          ? "after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-brand-500"
          : "rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500",
      )}
    >
      {children}
    </Link>
  );
}

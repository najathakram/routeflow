"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Scissors } from "lucide-react";
import { Button } from "@routeflow/ui/web";

/** Title of the legacy Add/Edit variant modal (sentence case). */
export const variantModalTitle = (editing: boolean) => (editing ? "Edit variant" : "Add variant");

/**
 * The legacy (parent product) variants card's action row: Assign to variants / Link existing / Add
 * variant, plus a pointer to the family grid for adding many at once. OPERATOR only; a FAMILY product
 * renders its own editor instead, so this renders nothing for one.
 */
export function LegacyVariantsActions({
  product,
  isOperator,
  onSplit,
  onLinkExisting,
  onAddVariant,
}: {
  product: { kind?: string | null; parentProductId?: string | null };
  isOperator: boolean;
  onSplit: () => void;
  onLinkExisting: () => void;
  onAddVariant: () => void;
}) {
  if (!isOperator || product.kind === "FAMILY") return null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Scissors className="h-3.5 w-3.5" />}
          onClick={onSplit}
        >
          Assign to variants
        </Button>
        <Button size="sm" variant="secondary" onClick={onLinkExisting}>
          Link existing
        </Button>
        <Button size="sm" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={onAddVariant}>
          Add variant
        </Button>
      </div>
      <p className="text-xs text-navy/60">
        Adding many at once?{" "}
        <Link href="/products?newFamily=1" className="text-brand-600 underline underline-offset-2">
          Create a family
        </Link>{" "}
        with a grid.
      </p>
    </div>
  );
}

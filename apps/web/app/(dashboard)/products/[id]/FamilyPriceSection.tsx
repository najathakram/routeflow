"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { MoneyFigure } from "./MoneyFigure";

/**
 * K11-25 P23: on a family page the price block (Price each + Pricing Tiers) is not the product's selling price: a
 * family cannot be sold. It still feeds new variants, the family editor and the CSV export, so nothing is hidden
 * for good: the section says what the price is for, shows its value at a glance, and opens to the same editable
 * fields. Edit opens it and keeps it open, so editing never costs an extra tap.
 */
export function FamilyPriceSection({
  price,
  isEditing,
  children,
}: {
  price: number;
  isEditing: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const expanded = open || isEditing;
  const regionId = React.useId();
  return (
    <div className="mt-5 border-t border-surface-border pt-4">
      <p className="text-sm text-navy/70">New variants start from the family price.</p>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => {
          if (!isEditing) setOpen((o) => !o);
        }}
        className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded text-sm font-medium text-navy hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <span>
          Family price <MoneyFigure value={price} />
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 text-navy/60 transition-transform duration-200 ease-out motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </button>
      {/* Height opens with a grid-row transition (no animation under reduced motion); collapsed content is
          invisible, so it is out of the tab order and the accessibility tree. */}
      <div
        id={regionId}
        className={cn(
          "grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none",
          expanded ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]",
        )}
      >
        <div className="-mx-1 overflow-hidden px-1">
          <div className="pt-3">{children}</div>
        </div>
      </div>
    </div>
  );
}

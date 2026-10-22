"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";

/**
 * Buyer merchandising (P5-01): three display flags that put a product on the buyer catalogue's shelves. K11-23
 * moved the card to the END of the Details body (it used to sit above the SKU row and pushed the price a whole
 * phone screen down); nothing about it was removed. Each switch saves at once, in view and edit mode alike.
 */

export type MerchFlag = "isFeatured" | "isNew" | "isDeal";

function MerchFlagToggle({
  label,
  description,
  active,
  disabled,
  onToggle,
}: {
  label: string;
  description: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
        active
          ? "border-brand-300 bg-brand-50"
          : "border-surface-border bg-white hover:bg-surface-raised",
      )}
    >
      <span className="min-w-0">
        <span className={cn("block text-sm font-medium", active ? "text-brand-700" : "text-navy")}>
          {label}
        </span>
        <span className="block text-[11px] text-navy/60">{description}</span>
      </span>
      <span
        className={cn(
          "relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors",
          active ? "bg-brand-500" : "bg-navy/20",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
            active ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

const FLAGS: Array<{ flag: MerchFlag; label: string; description: string }> = [
  { flag: "isFeatured", label: "Featured", description: "Pin to the featured shelf" },
  { flag: "isNew", label: "New", description: 'Show a "New" badge' },
  { flag: "isDeal", label: "Deal", description: 'Show a "Deal" badge' },
];

export function ProductMerchandising({
  product,
  isEditing,
  pending,
  onToggle,
}: {
  product: Record<MerchFlag, boolean | null | undefined>;
  isEditing: boolean;
  pending: boolean;
  onToggle: (flag: MerchFlag, next: boolean) => void;
}) {
  return (
    <div className="mt-5 rounded-lg border border-surface-border bg-white p-4">
      <div className="mb-2.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Buyer merchandising
        </h3>
      </div>
      {isEditing && (
        <p className="mb-2 text-xs font-medium text-navy/60">
          These switches apply immediately, without Save.
        </p>
      )}
      <p className="mb-3 text-xs text-navy/60">
        Highlight this product on the buyer catalogue with badges and smart collections. These are
        display flags only — they don&apos;t change price.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {FLAGS.map(({ flag, label, description }) => (
          <MerchFlagToggle
            key={flag}
            label={label}
            description={description}
            active={!!product[flag]}
            disabled={pending}
            onToggle={() => onToggle(flag, !product[flag])}
          />
        ))}
      </div>
    </div>
  );
}

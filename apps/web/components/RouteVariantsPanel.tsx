"use client";

import * as React from "react";
import { AlertTriangle, Check } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type { RouteVariant } from "@/lib/api/routes";

const VARIANT_LABELS: Record<RouteVariant["key"], string> = {
  FASTEST: "Fastest",
  SHORTEST: "Shortest",
  NO_TOLLS: "Avoids tolls",
};

export interface RouteVariantsPanelProps {
  variants: RouteVariant[];
  selectedKey?: RouteVariant["key"] | null;
  onSelect: (variant: RouteVariant) => void;
  loading?: boolean;
  className?: string;
  /** Mobile deliveries/new sheet: a horizontal snap-scrolling row instead of
   *  the desktop's wrapping flex row. Default false — every existing caller
   *  keeps today's wrap layout. */
  scrollX?: boolean;
}

function VariantSkeletonCard() {
  return (
    <div className="min-w-[140px] flex-1 animate-pulse rounded-lg border border-surface-border bg-surface-raised p-3">
      <div className="h-4 w-16 rounded bg-navy/10" />
      <div className="mt-2 h-3 w-24 rounded bg-navy/10" />
    </div>
  );
}

/**
 * One card per route variant (Fastest / Shortest / Avoids tolls) — same
 * stops, different settings (Google's alternative-routes API doesn't support
 * intermediate waypoints, so this is the deliberate design). Click a card to
 * select it; the caller wires that into the map overlays and the "Use this
 * route" action.
 */
export function RouteVariantsPanel({
  variants,
  selectedKey,
  onSelect,
  loading,
  className,
  scrollX,
}: RouteVariantsPanelProps) {
  if (loading) {
    return (
      <div className={cn(scrollX ? "flex gap-2 overflow-x-auto" : "flex gap-2", className)}>
        <VariantSkeletonCard />
        <VariantSkeletonCard />
        <VariantSkeletonCard />
      </div>
    );
  }

  if (!variants.length) return null;

  return (
    <div
      className={cn(
        scrollX ? "flex gap-2 overflow-x-auto pb-1 snap-x snap-mandatory" : "flex flex-wrap gap-2",
        className,
      )}
    >
      {variants.map((variant) => {
        const selected = selectedKey === variant.key;
        const minutes = Math.round(variant.durationSec / 60);
        const miles = (variant.distanceMeters / 1609.34).toFixed(1);
        return (
          <button
            key={variant.key}
            type="button"
            onClick={() => onSelect(variant)}
            className={cn(
              "rounded-lg border p-3 text-left transition-colors",
              scrollX ? "w-[150px] shrink-0 snap-start" : "min-w-[140px] flex-1",
              selected
                ? "border-brand-500 bg-brand-50 ring-2 ring-brand-500"
                : "border-surface-border bg-white hover:border-brand-300",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-navy">
                {VARIANT_LABELS[variant.key] ?? variant.key}
              </span>
              {selected && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
            </div>
            <p className="mt-1 text-xs text-navy/70">
              {minutes} min &middot; {miles} mi
            </p>
            {variant.hasTolls && (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                <AlertTriangle className="h-3 w-3" />
                Tolls
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

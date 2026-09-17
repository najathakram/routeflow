"use client";

import * as React from "react";
import type { TripStopGroup } from "@routeflow/types";
import type { RouteVariant } from "@/lib/api/routes";
import { RouteVariantsPanel } from "@/components/RouteVariantsPanel";
import {
  TemplateRouteMap,
  type TemplateRouteMapProps,
  type VariantOverlay,
} from "../../routes/templates/[id]/TemplateRouteMap";
import {
  DeliveryBottomSheet,
  type DeliverySheetOverflowAction,
  type SheetDetent,
} from "./DeliveryBottomSheet";
import { TripStopList, type TripStopOrderInfo } from "./TripStopList";
import { TripSkippedPanel, type TripSkippedRow } from "./TripSkippedPanel";
import { OrderPickerPanel } from "./OrderPickerPanel";
import { useReducedMotion } from "./useReducedMotion";

export interface DeliveryMobileLayoutProps {
  phase: "PICKING" | "BUILT";

  // ── Map (mounted once for the lifetime of this layout; props change with phase) ──
  mapStops: TemplateRouteMapProps["stops"];
  depotLat?: number | null;
  depotLng?: number | null;
  depotAddress?: string | null;
  plannedPolyline?: string | null;
  variantOverlays?: VariantOverlay[];

  // ── Stops / skipped ──
  groups: TripStopGroup[];
  orderLookup: Record<string, TripStopOrderInfo>;
  skipped: TripSkippedRow[];
  onRemoveCustomer?: (customerId: string) => void;
  onRemoveOrder?: (orderId: string) => void;
  stopsLoading?: boolean;
  stopsError?: boolean;
  onRetryStops?: () => void;

  // ── Order picker (PICKING only) ──
  orderIds: string[];
  onAddOrder: (orderId: string) => void;
  orderPickerHint?: string;

  // ── Route variants (BUILT only) ──
  variants: RouteVariant[];
  selectedVariantKey: RouteVariant["key"] | null;
  onSelectVariant: (variant: RouteVariant) => void;
  variantsLoading: boolean;
  onUseVariant: () => void;
  useVariantDisabled: boolean;
  useVariantPending: boolean;

  // ── Sheet chrome ──
  summary: string;
  primary: { label: string; onClick: () => void; disabled?: boolean; loading?: boolean };
  overflow?: DeliverySheetOverflowAction[];

  // ── Phase-specific slots the page already builds (avoids duplicating that JSX) ──
  planningSlot?: React.ReactNode;
  builtSummarySlot?: React.ReactNode;
}

/**
 * `/deliveries/new` below `lg` (owner-requested phone UX, 2026-09-17): the
 * map fills the viewport as a background canvas, mounted once, with a
 * draggable bottom sheet (`DeliveryBottomSheet`) over it. See this
 * component's parent (`deliveries/new/page.tsx`) for why it — not CSS —
 * decides desktop vs. mobile: exactly one `TemplateRouteMap` (a real,
 * billable Google Maps instance) may ever be mounted at a time.
 *
 * Interplay (owner spec item 4, ambiguity resolved per this session's final
 * report): tapping the empty map background collapses the sheet to peek;
 * tapping a MARKER highlights it, recenters the map, lifts the sheet to
 * half, and scrolls the list to that stop; tapping a STOP in the list
 * highlights its marker and recenters the map (same `selectedStopId`
 * mechanism, no sheet/scroll change since the list is already where the
 * user is looking).
 */
export function DeliveryMobileLayout({
  phase,
  mapStops,
  depotLat,
  depotLng,
  depotAddress,
  plannedPolyline,
  variantOverlays,
  groups,
  orderLookup,
  skipped,
  onRemoveCustomer,
  onRemoveOrder,
  stopsLoading,
  stopsError,
  onRetryStops,
  orderIds,
  onAddOrder,
  orderPickerHint,
  variants,
  selectedVariantKey,
  onSelectVariant,
  variantsLoading,
  onUseVariant,
  useVariantDisabled,
  useVariantPending,
  summary,
  primary,
  overflow,
  planningSlot,
  builtSummarySlot,
}: DeliveryMobileLayoutProps) {
  const reducedMotion = useReducedMotion();
  const [detent, setDetent] = React.useState<SheetDetent>("half");
  const [selectedStopId, setSelectedStopId] = React.useState<string | null>(null);

  function scrollListToCustomer(customerId: string) {
    requestAnimationFrame(() => {
      // jsdom (RTL) doesn't implement scrollIntoView — every real browser
      // does, so this is a test-environment guard, not a feature check.
      document.getElementById(`trip-stop-${customerId}`)?.scrollIntoView?.({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "nearest",
      });
    });
  }

  function handleMarkerSelect(stopId: string) {
    // Safe to always run alongside `onMapClick` below: an AdvancedMarker tap
    // dispatches its own `gmp-click`, a channel the underlying Google Maps
    // JS API deliberately keeps separate from the Map's own `click` event —
    // so this never also triggers `handleMapClick` for the same tap.
    setSelectedStopId(stopId);
    const stop = mapStops.find((s) => s.id === stopId);
    if (!stop) return;
    setDetent((d) => (d === "peek" ? "half" : d));
    scrollListToCustomer(stop.customerId);
  }

  function handleMapClick() {
    setSelectedStopId(null);
    setDetent("peek");
  }

  function handleListRowSelect(customerId: string) {
    const stop = mapStops.find((s) => s.customerId === customerId);
    setSelectedStopId(stop?.id ?? null);
  }

  const selectedCustomerId = selectedStopId
    ? (mapStops.find((s) => s.id === selectedStopId)?.customerId ?? null)
    : null;

  return (
    <div data-testid="delivery-mobile-layout" className="relative min-h-0 flex-1 overflow-hidden">
      <div className="absolute inset-0">
        <TemplateRouteMap
          stops={mapStops}
          depotLat={depotLat}
          depotLng={depotLng}
          depotAddress={depotAddress}
          plannedPolyline={plannedPolyline}
          variantOverlays={variantOverlays}
          selectedStopId={selectedStopId}
          onSelectStop={handleMarkerSelect}
          onMapClick={handleMapClick}
          panToSelectedStop
        />
      </div>

      <DeliveryBottomSheet
        detent={detent}
        onDetentChange={setDetent}
        summary={summary}
        primary={primary}
        overflow={overflow}
      >
        {phase === "PICKING" ? planningSlot : builtSummarySlot}

        {/* Order picker only at "full" — owner spec item 2: half stays to
            route options + the stop list; full adds the picker + skipped panel. */}
        {phase === "PICKING" && detent === "full" && (
          <div className="mt-4">
            <OrderPickerPanel
              excludeIds={orderIds}
              onAdd={onAddOrder}
              defaultOpen={orderIds.length === 0}
              hint={orderPickerHint}
            />
          </div>
        )}

        {phase === "BUILT" && (variantsLoading || variants.length > 0) && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                Compare routes
              </h3>
              {variants.length > 0 && (
                <button
                  type="button"
                  onClick={onUseVariant}
                  disabled={useVariantDisabled || useVariantPending}
                  className="rounded-lg border border-surface-border px-2.5 py-1 text-xs font-semibold text-navy transition-colors hover:bg-surface-raised disabled:opacity-50"
                >
                  {useVariantPending ? "Applying…" : "Use this route"}
                </button>
              )}
            </div>
            <RouteVariantsPanel
              variants={variants}
              selectedKey={selectedVariantKey}
              onSelect={onSelectVariant}
              loading={variantsLoading}
              scrollX
            />
          </div>
        )}

        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-navy/70">
            Stops ({groups.length})
          </h3>
          {stopsLoading ? (
            <div className="h-24 animate-pulse rounded-lg border border-surface-border bg-surface-raised" />
          ) : stopsError ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2">
              <span className="text-xs text-danger">Failed to check eligibility.</span>
              <button
                type="button"
                onClick={onRetryStops}
                className="text-xs font-medium text-danger underline"
              >
                Retry
              </button>
            </div>
          ) : (
            <TripStopList
              groups={groups}
              orderLookup={orderLookup}
              onRemoveCustomer={phase === "PICKING" ? onRemoveCustomer : undefined}
              onRemoveOrder={phase === "PICKING" ? onRemoveOrder : undefined}
              onSelectGroup={phase === "BUILT" ? handleListRowSelect : undefined}
              selectedCustomerId={selectedCustomerId}
              emptyMessage="No eligible stops selected."
            />
          )}
        </div>

        {detent === "full" && (
          <div className="mt-4">
            <TripSkippedPanel rows={skipped} />
          </div>
        )}
      </DeliveryBottomSheet>
    </div>
  );
}

"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, Card, useToast } from "@routeflow/ui/web";
import { useInventorySettings, useUpdateInventorySettings } from "@/lib/api/inventory-settings";
import { MiniSwitch } from "./MiniSwitch";

/**
 * Settings → Out-of-stock ordering. One switch over the tenant-level `orders.buyerOversell`
 * policy: ON lets a customer's order take an item's stock below zero (the order is a backorder);
 * OFF (the default) refuses it. Staff can always order items that are out of stock, whatever this
 * says. A TENANT_ADMIN edits; anyone else sees it read-only.
 *
 * Fail-closed: the switch only exists once the setting has loaded. While loading, or when the load
 * failed, there is no switch (never a guessed "on"); only the exact value "backorder" reads as on.
 * No raw server text is ever shown: the toasts are fixed copy.
 */
export const OVERSELL_COPY = {
  title: "Out-of-stock ordering",
  label: "Let customers order items that are out of stock",
  description:
    "When this is on, a customer's order can take an item's stock below zero and the order is a " +
    "backorder. Staff can always order items that are out of stock, whatever this says.",
  readOnly: "Only an admin can change this setting.",
  loadFailed: "Couldn't load the out-of-stock ordering setting.",
  saveFailed: "Couldn't save the out-of-stock ordering setting",
  savedOn: "Customers can now order items that are out of stock",
  savedOff: "Customers can no longer order items that are out of stock",
  // OOS PR2: what a buyer is told about a backordered item (the seller's choice).
  visibilityTitle: "What customers see about backordered items",
  visibilityShow: 'Show it: the item says "Ships when restocked" and the order is tagged',
  visibilityHide: "Hide it: the item looks in stock and customers see nothing about backorders",
  visibilityNeedsSwitch: "This applies when out-of-stock ordering is on for a customer.",
  savedShow: "Customers will see that backordered items ship when restocked",
  savedHide: "Customers will no longer see anything about backorders",
  visibilitySaveFailed: "Couldn't save what customers see about backordered items",
} as const;

export function BuyerOversellCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = useInventorySettings();
  const update = useUpdateInventorySettings();
  const on = data?.buyerOversell === "backorder";

  function onToggle() {
    if (!canEdit || !data) return;
    const next = on ? "off" : "backorder";
    update.mutate(
      { buyerOversell: next },
      {
        onSuccess: () =>
          toast({
            variant: "success",
            title: next === "backorder" ? OVERSELL_COPY.savedOn : OVERSELL_COPY.savedOff,
          }),
        onError: () => toast({ variant: "error", title: OVERSELL_COPY.saveFailed }),
      },
    );
  }

  // The choice is tenant-wide: it stays editable while the switch is off if customers have their own
  // (on) setting, so it can still be managed. The server accepts it either way.
  const overrides = data?.customerOverrides ?? 0;
  const canEditVisibility = canEdit && (on || overrides > 0);

  // Only the exact value "hide" hides; an unknown value reads as the default, "show".
  const visibility = data?.buyerBackorderVisibility === "hide" ? "hide" : "show";

  function onVisibility(next: "show" | "hide") {
    if (!canEditVisibility || !data || next === visibility) return;
    update.mutate(
      { buyerBackorderVisibility: next },
      {
        onSuccess: () =>
          toast({
            variant: "success",
            title: next === "show" ? OVERSELL_COPY.savedShow : OVERSELL_COPY.savedHide,
          }),
        onError: () => toast({ variant: "error", title: OVERSELL_COPY.visibilitySaveFailed }),
      },
    );
  }

  return (
    <Card title={OVERSELL_COPY.title}>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-navy/60">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data ? (
        <div className="flex items-center justify-between gap-3 text-sm text-navy/70">
          <span>{OVERSELL_COPY.loadFailed}</span>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-navy">{OVERSELL_COPY.label}</div>
              <div className="text-xs text-navy/55">{OVERSELL_COPY.description}</div>
            </div>
            {/* The switch is 36x20: the label gives it a 44x44 touch target (a tap on it toggles). */}
            <label
              data-testid="oversell-switch-target"
              className="-m-1 flex min-h-[44px] min-w-[44px] flex-none cursor-pointer items-center justify-center"
            >
              <MiniSwitch
                checked={on}
                disabled={!canEdit || update.isPending}
                onToggle={onToggle}
                ariaLabel={OVERSELL_COPY.label}
              />
            </label>
          </div>
          <fieldset
            className="space-y-1.5 border-t border-surface-border pt-3"
            disabled={!canEditVisibility || update.isPending}
          >
            <legend className="text-sm font-medium text-navy">
              {OVERSELL_COPY.visibilityTitle}
            </legend>
            {(
              [
                ["show", OVERSELL_COPY.visibilityShow],
                ["hide", OVERSELL_COPY.visibilityHide],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex cursor-pointer items-start gap-2 text-sm text-navy"
              >
                <input
                  type="radio"
                  name="buyer-backorder-visibility"
                  value={value}
                  checked={visibility === value}
                  onChange={() => onVisibility(value)}
                  className="mt-1"
                />
                <span>{label}</span>
              </label>
            ))}
            <p className="text-xs text-navy/55">{OVERSELL_COPY.visibilityNeedsSwitch}</p>
          </fieldset>
          {!canEdit && <p className="text-xs text-navy/55">{OVERSELL_COPY.readOnly}</p>}
          {overrides > 0 && (
            <p className="text-xs text-navy/55">
              {overrides === 1
                ? "1 customer has their own setting and ignores this default."
                : `${overrides} customers have their own setting and ignore this default.`}{" "}
              Change it on that customer&apos;s page.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

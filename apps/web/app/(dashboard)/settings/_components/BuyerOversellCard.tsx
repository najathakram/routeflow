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

  const overrides = data?.customerOverrides ?? 0;

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
            <MiniSwitch
              checked={on}
              disabled={!canEdit || update.isPending}
              onToggle={onToggle}
              ariaLabel={OVERSELL_COPY.label}
            />
          </div>
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

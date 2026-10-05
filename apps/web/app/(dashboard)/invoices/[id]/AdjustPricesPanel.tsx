"use client";

import * as React from "react";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { Button, Card, useToast } from "@routeflow/ui/web";
import { useAdjustInvoicePrices, type Invoice } from "@/lib/api/invoices";
import { fmt } from "@/lib/formatting";

/** The invoice page's "Adjust Prices" card (moved verbatim out of page.tsx so it can be tested on its own). */
export function AdjustPricesPanel({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const { toast } = useToast();
  const adjust = useAdjustInvoicePrices();

  const items = invoice.items ?? [];
  const [prices, setPrices] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((it) => [it.id, String(Number(it.unitPrice).toFixed(2))])),
  );
  const [scope, setScope] = React.useState<"SINGLE" | "ALL_CUSTOMER_SINCE">("SINGLE");
  const [sinceDate, setSinceDate] = React.useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  });

  function handleSave() {
    const dto = {
      id: invoice.id,
      items: items.map((it) => ({
        itemId: it.id,
        newUnitPrice:
          parseFloat(prices[it.id] ?? String(Number(it.unitPrice))) || Number(it.unitPrice),
      })),
      scope,
      ...(scope === "ALL_CUSTOMER_SINCE" ? { sinceDate } : {}),
    };
    adjust.mutate(dto, {
      onSuccess: () => {
        toast({
          title: "Prices updated",
          description:
            scope === "SINGLE"
              ? "Invoice prices have been adjusted."
              : "Prices updated across matching invoices.",
          variant: "success",
        });
        onClose();
      },
      onError: (err: any) => {
        toast({
          title: "Failed to adjust prices",
          description: err?.response?.data?.message ?? "Please try again.",
          variant: "error",
        });
      },
    });
  }

  return (
    <Card title="Adjust Prices">
      <p className="mb-4 text-sm text-navy/70">
        Override unit prices on this invoice. Totals will be recalculated and an audit note
        appended.
      </p>

      {/* Per-item price inputs */}
      <div className="mb-5 divide-y divide-surface-border rounded-lg border border-surface-border">
        {items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-navy">{item.description}</p>
              <p className="text-xs text-navy/70">
                Qty: {item.qty} · Current:{" "}
                <span className="money">{fmt(Number(item.unitPrice))}</span>
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-navy/70">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={prices[item.id] ?? ""}
                onChange={(e) => setPrices((p) => ({ ...p, [item.id]: e.target.value }))}
                className="w-28 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>
        ))}
      </div>

      {/* Scope */}
      <div className="mb-5 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">Scope</p>
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="radio"
            name="adjust-scope"
            checked={scope === "SINGLE"}
            onChange={() => setScope("SINGLE")}
            className="accent-brand-500"
          />
          <span className="text-sm text-navy">This invoice only</span>
        </label>
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="radio"
            name="adjust-scope"
            checked={scope === "ALL_CUSTOMER_SINCE"}
            onChange={() => setScope("ALL_CUSTOMER_SINCE")}
            className="accent-brand-500"
          />
          <span className="text-sm text-navy">
            All invoices for <strong>{invoice.customer?.businessName ?? "this customer"}</strong>{" "}
            from:
          </span>
        </label>
        {scope === "ALL_CUSTOMER_SINCE" && (
          <div className="ml-6 mt-1">
            <input
              type="date"
              value={sinceDate}
              onChange={(e) => setSinceDate(e.target.value)}
              className="h-9 w-36 rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-navy/70">
              All matching invoices created on or after this date will be updated.
            </p>
          </div>
        )}
      </div>

      {scope === "ALL_CUSTOMER_SINCE" && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          Bulk update will modify all open invoices for this customer from the selected date. This
          cannot be undone.
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={adjust.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          loading={adjust.isPending}
          leftIcon={<SlidersHorizontal className="h-3.5 w-3.5" />}
        >
          Apply Price Changes
        </Button>
      </div>
    </Card>
  );
}

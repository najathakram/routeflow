"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import type { InvoiceUnitDefault } from "@routeflow/types";
import { useUpdateCustomer } from "@/lib/api/customers";

/**
 * Staff-only "Invoice in" choice for one customer (SA-827 G7): how this customer's invoices list
 * mixed boxes. Same inline-edit as Default Payment Terms (the select saves on change); disabled
 * while saving; a failed save shows the page's error toast.
 */
const OPTIONS: { value: InvoiceUnitDefault; label: string; hint: string }[] = [
  { value: "LEGACY", label: "Default", hint: "Follows the product and business setting." },
  {
    value: "PIECES",
    label: "Pieces",
    hint: "Mixed boxes list each item; boxes show their pieces.",
  },
  { value: "PACK", label: "Packs", hint: "Always the unit sold." },
];

export function CustomerInvoiceUnitControl({
  customerId,
  value,
}: {
  customerId: string;
  value?: InvoiceUnitDefault | null;
}) {
  const { toast } = useToast();
  const updateCustomer = useUpdateCustomer();
  const id = React.useId();
  const current = value ?? "LEGACY";
  const hint = OPTIONS.find((o) => o.value === current)?.hint;

  return (
    <div className="mt-3 flex items-center justify-between gap-4 border-t border-surface-border pt-3">
      <div>
        <label htmlFor={id} className="text-sm font-medium text-navy">
          Invoice in
        </label>
        <p className="mt-0.5 text-[11px] leading-snug text-navy/70">{hint}</p>
      </div>
      <select
        id={id}
        value={current}
        disabled={updateCustomer.isPending}
        onChange={(e) => {
          updateCustomer.mutate(
            { id: customerId, invoiceUnitDefault: e.target.value as InvoiceUnitDefault },
            {
              onError: (err: any) => {
                toast({
                  title: "Couldn't save invoice unit",
                  description: err?.response?.data?.message ?? "",
                  variant: "error",
                });
              },
            },
          );
        }}
        className="rounded border border-surface-border bg-white px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
      >
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import type { InvoiceUnitDefault } from "@routeflow/types";
import { useUpdateCustomer } from "@/lib/api/customers";

/**
 * "Invoice in" choice for one customer (SA-827 G7): how this customer's invoices list
 * mixed boxes. Same inline-edit as Default Payment Terms (the select saves on change); disabled
 * while saving; a failed save shows the page's error toast. Non-operators
 * (`canEdit` false) see the current value read-only, like Default Payment Terms.
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

function saveErrorMessage(err: unknown): string {
  const message = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data
    ?.message;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.join(", ");
  return "";
}

export function CustomerInvoiceUnitControl({
  customerId,
  value,
  canEdit = true,
}: {
  customerId: string;
  value?: InvoiceUnitDefault | null;
  canEdit?: boolean;
}) {
  const { toast } = useToast();
  const updateCustomer = useUpdateCustomer();
  const id = React.useId();
  const current = value ?? "LEGACY";
  const currentOption = OPTIONS.find((o) => o.value === current);
  const hint = currentOption?.hint;

  return (
    <div className="mt-3 flex items-center justify-between gap-4 border-t border-surface-border pt-3">
      <div>
        {canEdit ? (
          <label htmlFor={id} className="text-sm font-medium text-navy">
            Invoice in
          </label>
        ) : (
          <p className="text-sm font-medium text-navy">Invoice in</p>
        )}
        <p className="mt-0.5 text-[11px] leading-snug text-navy/70">{hint}</p>
      </div>
      {canEdit ? (
        <select
          id={id}
          value={current}
          disabled={updateCustomer.isPending}
          onChange={(e) => {
            updateCustomer.mutate(
              { id: customerId, invoiceUnitDefault: e.target.value as InvoiceUnitDefault },
              {
                onError: (err: unknown) => {
                  toast({
                    title: "Couldn't save invoice unit",
                    description: saveErrorMessage(err),
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
      ) : (
        <p className="text-sm font-semibold text-navy">{currentOption?.label}</p>
      )}
    </div>
  );
}

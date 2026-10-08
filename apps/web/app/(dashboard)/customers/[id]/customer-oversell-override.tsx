"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import {
  customerOversellView,
  usePolicies,
  useSetCustomerOversell,
  type OversellOverride,
} from "@/lib/api/customer-oversell";

/**
 * This customer's own out-of-stock-ordering setting (the CUSTOMER row of `orders.buyerOversell`):
 * inherit the business setting, always allow, or never allow. A TENANT_ADMIN changes it; an
 * operator reads it. When the customer's own setting exists and differs from the business setting
 * it says so, so staff are never surprised by an order that went through (or was refused).
 * Fail-closed like the rest: no select until the policies have loaded; fixed copy only.
 */
export const OVERRIDE_COPY = {
  title: "Out-of-stock ordering",
  inherit: "Use the business setting",
  allow: "Allow this customer",
  deny: "Don't allow this customer",
  loadFailed: "Couldn't load this customer's out-of-stock ordering setting.",
  saveFailed: "Couldn't save the out-of-stock ordering setting",
  saved: "Out-of-stock ordering updated for this customer",
  differs: (override: "allow" | "deny", tenant: "allow" | "deny") =>
    `This customer's own setting (${
      override === "allow" ? "allowed" : "not allowed"
    }) differs from the business setting (${tenant === "allow" ? "allowed" : "not allowed"}).`,
  tenant: (tenant: "allow" | "deny") =>
    `Business setting: customers ${tenant === "allow" ? "can" : "cannot"} order items that are out of stock.`,
} as const;

export function CustomerOversellOverride({ customerId }: { customerId: string }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEdit = user?.role === "TENANT_ADMIN";
  const { data, isLoading, isError } = usePolicies();
  const set = useSetCustomerOversell();
  const view = customerOversellView(data, customerId);

  function onChange(override: OversellOverride) {
    set.mutate(
      { customerId, override },
      {
        onSuccess: () => toast({ variant: "success", title: OVERRIDE_COPY.saved }),
        onError: () => toast({ variant: "error", title: OVERRIDE_COPY.saveFailed }),
      },
    );
  }

  return (
    <div className="mt-5 border-t border-surface-border pt-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
        {OVERRIDE_COPY.title}
      </p>
      {isLoading ? (
        <p className="mt-1 text-sm text-navy/60">Loading…</p>
      ) : isError || !view ? (
        <p className="mt-1 text-sm text-navy/60">{OVERRIDE_COPY.loadFailed}</p>
      ) : (
        <div className="mt-1 space-y-1">
          {canEdit ? (
            <select
              aria-label={OVERRIDE_COPY.title}
              value={view.override}
              disabled={set.isPending}
              onChange={(e) => onChange(e.target.value as OversellOverride)}
              className="rounded border border-surface-border bg-white px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
            >
              <option value="inherit">{OVERRIDE_COPY.inherit}</option>
              <option value="allow">{OVERRIDE_COPY.allow}</option>
              <option value="deny">{OVERRIDE_COPY.deny}</option>
            </select>
          ) : (
            <p className="text-sm font-semibold text-navy">{OVERRIDE_COPY[view.override]}</p>
          )}
          <p className="text-xs text-navy/55">{OVERRIDE_COPY.tenant(view.tenant)}</p>
          {view.differs && view.override !== "inherit" && (
            <p
              role="note"
              className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800"
            >
              {OVERRIDE_COPY.differs(view.override, view.tenant)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import * as React from "react";
import NextLink from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { STAFF_ORDERS_SWITCH_LABEL } from "@/lib/unknown-state";
import {
  twoStepNotice,
  useRestrictionsSettings,
  useUpdateRestrictionsSettings,
} from "@/lib/api/restrictions-settings";
import { CustomersWithoutState } from "./_components/CustomersWithoutState";

const PRECEDENCE = [
  {
    value: "BILLING_FIRST",
    label: "Billing address first",
    hint: "Use the customer's default billing address; fall back to shipping.",
  },
  {
    value: "SHIPPING_FIRST",
    label: "Shipping address first",
    hint: "Use the customer's default shipping address; fall back to billing.",
  },
] as const;

/** Selling restrictions: the tenant switch and which customer address decides the state. */
export default function RestrictionsSettingsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => setTitle("Selling restrictions"), [setTitle]);
  const role = useAuth().user?.role;
  const isAdmin = role === "TENANT_ADMIN";
  // Owner ruling 10-07: operators are near-admins, so they may fix customer data too (the server decides).
  const canFix = isAdmin || role === "OPERATOR";
  const { toast } = useToast();
  const { data, isLoading, isError } = useRestrictionsSettings();
  const update = useUpdateRestrictionsSettings();
  const [notice, setNotice] = React.useState<string | null>(null);

  const save = (dto: {
    enabled?: boolean;
    governingAddress?: "BILLING_FIRST" | "SHIPPING_FIRST";
  }) =>
    update.mutate(dto, {
      onSuccess: () => {
        setNotice(null);
        toast({ title: "Saved", variant: "success" });
      },
      onError: (e) => {
        // Only the guided case toasts here (it is in providers.tsx's HANDLED_CODES so the global
        // handler skips it). Any other error is toasted once, with the server message, by that
        // global handler — a second toast here would double it (B594 class).
        const twoStep = twoStepNotice(e);
        if (twoStep) {
          setNotice(twoStep);
          toast({ title: "Do this in two steps", variant: "error" });
        }
      },
    });

  if (isLoading)
    return <Loader2 className="mx-auto my-10 h-6 w-6 animate-spin" aria-label="Loading" />;
  if (isError || !data)
    return <p className="p-6 text-sm text-danger">Couldn&apos;t load settings.</p>;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <NextLink
        href="/settings"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-navy/60 hover:text-brand-600"
      >
        <ArrowLeft className="h-4 w-4" /> All settings
      </NextLink>
      <h2 className="text-2xl font-bold text-navy">Selling restrictions</h2>
      <p className="mb-2 mt-1 text-sm text-navy/70">
        Portal limits always apply. These settings decide what else is checked.
        {!isAdmin && " Only a workspace admin can change these settings."}
      </p>
      <p className="mb-5 text-sm">
        <NextLink
          href="/settings/restrictions/rules"
          className="font-medium text-brand-600 hover:underline"
        >
          Portal limits &amp; rules
        </NextLink>
      </p>

      {notice && (
        <p
          role="alert"
          className="mb-5 rounded-lg border border-surface-border bg-surface-raised/40 px-3 py-2 text-sm text-navy"
        >
          {notice}
        </p>
      )}

      <section className="mb-5 rounded-xl border border-surface-border bg-white p-4">
        <label className="flex items-center justify-between gap-3">
          <span className="font-medium text-navy">{STAFF_ORDERS_SWITCH_LABEL}</span>
          <input
            type="checkbox"
            role="switch"
            aria-label={STAFF_ORDERS_SWITCH_LABEL}
            checked={data.enabled}
            disabled={!isAdmin || update.isPending}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
        </label>
        <p className="mt-1 text-xs text-navy/60">
          Portal limits always apply. Turn this on for legal bans your staff must not sell.
        </p>
      </section>

      <section className="mb-5 rounded-xl border border-surface-border bg-white p-4">
        <p className="mb-2 font-medium text-navy">Which address decides the state</p>
        {PRECEDENCE.map((p) => (
          <label key={p.value} className="mb-2 flex items-start gap-2 text-sm text-navy">
            <input
              type="radio"
              name="precedence"
              checked={data.governingAddress === p.value}
              disabled={!isAdmin || update.isPending}
              onChange={() => save({ governingAddress: p.value })}
            />
            <span>
              {p.label}
              <span className="block text-xs text-navy/60">{p.hint}</span>
            </span>
          </label>
        ))}
      </section>

      <CustomersWithoutState canFix={canFix} staffOrdersChecked={data.enabled} />
    </div>
  );
}

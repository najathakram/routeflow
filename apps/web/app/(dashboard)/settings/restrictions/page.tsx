"use client";

import * as React from "react";
import NextLink from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { RESTRICTIONS_BUSINESS_STATE_MISSING_LINE } from "@routeflow/types";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import {
  friendlySettingsError,
  notReadyReadiness,
  twoStepNotice,
  useRestrictionsReadiness,
  useRestrictionsSettings,
  useUpdateRestrictionsSettings,
  type RestrictionsEnableReadiness,
} from "@/lib/api/restrictions-settings";

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

/** Plain-language fix list for the readiness counts (only the non-zero ones). */
function fixes(r: RestrictionsEnableReadiness): string[] {
  const out: string[] = [];
  if (r.truncated)
    out.push("This workspace is too large to check in one pass; ask support before enabling.");
  if (r.customersWithoutAddress)
    out.push(`${r.customersWithoutAddress} customer(s) have no address.`);
  if (r.customersAmbiguousNoDefault)
    out.push(
      `${r.customersAmbiguousNoDefault} customer(s) have several addresses and none marked as default.`,
    );
  if (r.addressesMissingStateCode)
    out.push(`${r.addressesMissingStateCode} address(es) have no usable state.`);
  if (r.addressesNeedingReview)
    out.push(`${r.addressesNeedingReview} address(es) need a state review.`);
  // Counter sales (the walk-in) are judged by the business's own state: without one every state rule is undecided.
  if (r.businessStateMissing) out.push(RESTRICTIONS_BUSINESS_STATE_MISSING_LINE);
  return out;
}

/** Selling restrictions: the tenant switch and which customer address decides the state. */
export default function RestrictionsSettingsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => setTitle("Selling restrictions"), [setTitle]);
  const isAdmin = useAuth().user?.role === "TENANT_ADMIN";
  const { toast } = useToast();
  const { data, isLoading, isError } = useRestrictionsSettings();
  const check = useRestrictionsReadiness();
  const update = useUpdateRestrictionsSettings();
  const [refused, setRefused] = React.useState<RestrictionsEnableReadiness | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const readiness = refused ?? check.data ?? null;

  const save = (dto: {
    enabled?: boolean;
    governingAddress?: "BILLING_FIRST" | "SHIPPING_FIRST";
  }) =>
    update.mutate(dto, {
      onSuccess: () => {
        setRefused(null);
        setNotice(null);
        toast({ title: "Saved", variant: "success" });
      },
      onError: (e) => {
        // Only the guided cases toast here (and are in providers.tsx's HANDLED_CODES so the global
        // handler skips them). Any other error is toasted once, with the server message, by that
        // global handler — a second toast here would double it (B594 class).
        const r = notReadyReadiness(e);
        if (r) {
          setRefused(r);
          toast({ title: "Can't enable yet — see what to fix below", variant: "error" });
          return;
        }
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
  const problems = readiness && !readiness.ready ? fixes(readiness) : [];

  return (
    <div className="mx-auto max-w-2xl p-6">
      <NextLink
        href="/settings"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-navy/60 hover:text-brand-600"
      >
        <ArrowLeft className="h-4 w-4" /> All settings
      </NextLink>
      <h2 className="text-2xl font-bold text-navy">Selling restrictions</h2>
      <p className="mb-5 mt-1 text-sm text-navy/70">
        Block products that are restricted where the customer is. Off by default.
        {!isAdmin && " Only a workspace admin can change these settings."}
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
          <span className="font-medium text-navy">Enforce selling restrictions</span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Enforce selling restrictions"
            checked={data.enabled}
            disabled={!isAdmin || update.isPending}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
        </label>
        <p className="mt-1 text-xs text-navy/60">
          {data.enabled
            ? "On: orders that meet an active rule are checked against the customer's state."
            : "Off: nothing is blocked."}
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

      <section className="rounded-xl border border-surface-border bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="font-medium text-navy">Is your customer data ready?</p>
          {isAdmin && (
            <Button
              size="sm"
              variant="secondary"
              loading={check.isFetching}
              onClick={() => {
                setRefused(null);
                check.refetch();
              }}
            >
              Check readiness
            </Button>
          )}
        </div>
        {readiness?.ready && (
          <p role="status" className="mt-2 text-sm text-navy">
            Ready: every customer&apos;s state can be worked out.
          </p>
        )}
        {check.isError && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {friendlySettingsError(check.error) ?? "Couldn't run the check. Try again."}
          </p>
        )}
        {problems.length > 0 && (
          <ul role="alert" className="mt-2 list-disc pl-5 text-sm text-danger">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

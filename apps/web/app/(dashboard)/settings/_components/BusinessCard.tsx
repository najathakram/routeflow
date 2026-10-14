"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge, Button, cn } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useTenant } from "@/components/tenant-provider";
import { useBillingPortal, useSubscription } from "@/lib/api/billing";
import { bannerRoleOf } from "@/lib/subscription-banner-state";
import { RailBoundary } from "./RailBoundary";
import { businessStatus, type BusinessStatus } from "./settings-values";

/** The plan and its status from the same subscription read the Billing page and the shell strip use. */
export function useBusinessStatus(): BusinessStatus | null {
  const { user } = useAuth();
  const role = bannerRoleOf(user?.role);
  const sub = useSubscription({ enabled: !!role, staleTime: 60_000 });
  return React.useMemo(() => businessStatus(sub.data, role), [sub.data, role]);
}

type Variant = "rail" | "list" | "pane";

/**
 * Apple-ID-row pattern: logo (or an initial), business name, plan + status pill. The whole card opens Plan &
 * billing; "Pay $X" is a sibling button (never a button inside a link) and only shows when payment is due.
 * A throw while reading the plan hides the card; the screen and the rest of the list stay.
 */
export function BusinessCard(props: { variant: Variant; active?: boolean }) {
  return (
    <RailBoundary>
      <BusinessCardInner {...props} />
    </RailBoundary>
  );
}

function BusinessCardInner({ variant, active }: { variant: Variant; active?: boolean }) {
  const { branding } = useTenant();
  const status = useBusinessStatus();
  const portal = useBillingPortal();
  const name = branding?.businessName?.trim() || "Your business";
  const big = variant === "pane";

  const pay = status?.pay;
  const onPay = () => {
    if (pay?.url?.startsWith("https://")) window.open(pay.url, "_blank", "noopener,noreferrer");
    else portal.mutate({ intent: "pay" });
  };

  return (
    <div className="relative">
      <Link
        href="/settings/billing"
        data-testid={variant === "rail" ? "business-card-rail" : "business-card"}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--paper)] shadow-[var(--sh-card)] transition-colors [transition-duration:120ms] hover:bg-[var(--sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary motion-reduce:transition-none",
          big ? "p-5" : "p-3",
          pay && variant !== "rail" && "pr-32",
          active && "bg-[var(--accent-soft)] hover:bg-[var(--accent-soft)]",
        )}
      >
        {branding?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={branding.logoUrl}
            alt=""
            className={cn("flex-none rounded-lg object-contain", big ? "h-14 w-14" : "h-10 w-10")}
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "flex flex-none items-center justify-center rounded-lg bg-[var(--accent)] font-semibold text-[var(--primary-foreground)]",
              big ? "h-14 w-14 text-2xl" : "h-10 w-10 text-lg",
            )}
          >
            {name.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate font-[family-name:var(--font-display)] text-[var(--ink-900)]",
              big ? "text-3xl leading-9" : "text-xl leading-6",
            )}
          >
            {name}
          </span>
          {status && (
            <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-[var(--ink-500)]">
              <span>
                {status.plan}
                {status.price && <span className="tabular-nums"> · {status.price}</span>}
              </span>
              {status.pill && <Badge variant={status.pill.tone} label={status.pill.label} />}
            </span>
          )}
        </span>
        {!pay && (
          <ChevronRight aria-hidden="true" className="h-4 w-4 flex-none text-[var(--ink-400)]" />
        )}
      </Link>
      {pay && (
        <Button
          size="sm"
          className={
            variant === "rail"
              ? "mt-2 w-full"
              : "absolute right-3 top-1/2 min-h-11 -translate-y-1/2 xl:min-h-0"
          }
          onClick={onPay}
          loading={portal.isPending}
        >
          {pay.label}
        </Button>
      )}
    </div>
  );
}

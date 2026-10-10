"use client";

import * as React from "react";
import { Info, X } from "lucide-react";
import type { SubscriptionView } from "@routeflow/types";
import { Button, Modal, cn } from "@routeflow/ui/web";
import { useBillingPortal } from "@/lib/api/billing";
import { dismissBanner, isBannerDismissed } from "@/lib/banner-dismiss";
import {
  subscriptionBannerState,
  type BannerRole,
  type BannerState,
} from "@/lib/subscription-banner-state";

// ─── SubscriptionStrip (SA-733r6 / B4) ───────────────────────────────────────
// The billing strip in the dashboard shell's existing compact slot (where ReadOnlyBanner sits). One line:
// <= 36 px at >= 768 and <= 32 px at 390 (fixed height, so nothing reflows when it truncates); the text truncates
// and a tap opens a sheet with the full sentence. Never over the counter's cart or total bar (it is in the normal
// flow above the page, not fixed). Neutral for grace, amber for the last day and read-only, never red.
// All copy, tone, action and dismiss rules come from `subscriptionBannerState` - nothing is decided here.

/** Contrast >= 4.5:1 (blue-900 on blue-50, amber-900 on amber-50). */
const TONE: Record<"neutral" | "amber", string> = {
  neutral: "bg-blue-50 text-blue-900 ring-blue-200",
  amber: "bg-amber-50 text-amber-900 ring-amber-200",
};

/**
 * role=alert is claimed ONCE per session per state (the first time the last-day / read-only strip appears); a later
 * mount (another page load, the poll remounting it) is a quiet status, so a screen reader is not re-interrupted.
 */
function claimAlert(kind: string): boolean {
  try {
    const key = `rf.billing.alerted.${kind}`;
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, "1");
    return true;
  } catch {
    return true;
  }
}

export function SubscriptionStrip({
  view,
  role,
  state: given,
}: {
  view: SubscriptionView;
  role: BannerRole;
  /** A caller that already computed the state passes it. */
  state?: BannerState;
}) {
  const state = React.useMemo(
    () => given ?? subscriptionBannerState(view, role),
    [given, view, role],
  );
  const portal = useBillingPortal();
  const announceKind = state.live === "alert" ? state.kind : null;
  const [announced, setAnnounced] = React.useState<{ kind: string; alert: boolean } | null>(null);
  const alertNow =
    announceKind !== null &&
    (announced?.kind === announceKind ? announced.alert : claimAlert(announceKind));
  React.useEffect(() => {
    if (announceKind && announced?.kind !== announceKind) {
      setAnnounced({ kind: announceKind, alert: alertNow });
    }
  }, [announceKind, announced, alertNow]);
  const [sheet, setSheet] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const dismissKey = state.dismiss?.key;
  const dismissed = React.useMemo(
    () => (state.dismiss ? isBannerDismissed(state.dismiss) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the dismissal's identity + our own tick
    [dismissKey, tick],
  );

  if (!state.inShell || state.tone === "none" || dismissed) return null;

  const action = state.action;
  return (
    <>
      <div
        data-testid="subscription-strip"
        data-state={state.kind}
        role={alertNow ? "alert" : "status"}
        className={cn(
          "flex h-8 shrink-0 items-center gap-2 px-3 text-[13px] ring-1 md:h-9 md:px-4 md:text-sm",
          TONE[state.tone],
        )}
      >
        <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
        {/* The text is a button: a tap opens the full sentence (the strip truncates to one line at 390). */}
        <button
          type="button"
          onClick={() => setSheet(true)}
          className="min-w-0 flex-1 truncate text-left"
          title={state.copy}
        >
          {state.copy}
        </button>
        {action && action.intent === "open-billing" && (
          <a
            href="/settings/billing"
            className="shrink-0 rounded-ctl border border-line-strong bg-paper px-2.5 text-[12.5px] font-medium leading-6 text-navy"
          >
            {action.label}
          </a>
        )}
        {action && action.intent !== "open-billing" && (
          <Button
            size="sm"
            variant="secondary"
            className="h-6 shrink-0 md:h-7"
            loading={portal.isPending}
            onClick={() => portal.mutate({ intent: action.intent as "pay" | "update-payment" })}
          >
            {action.label}
          </Button>
        )}
        {state.dismiss && (
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 rounded p-1 hover:bg-black/5"
            onClick={() => {
              dismissBanner(state.dismiss!);
              setTick((n) => n + 1);
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <Modal
        open={sheet}
        onClose={() => setSheet(false)}
        title="Billing"
        footer={
          action && action.intent !== "open-billing" ? (
            <Button
              loading={portal.isPending}
              onClick={() => portal.mutate({ intent: action.intent as "pay" | "update-payment" })}
            >
              {action.label}
            </Button>
          ) : undefined
        }
      >
        <p className="text-sm text-slate-700">{state.copy}</p>
      </Modal>
    </>
  );
}

"use client";

import * as React from "react";
import { Info, X } from "lucide-react";
import type { SubscriptionView } from "@routeflow/types";
import { Button, cn } from "@routeflow/ui/web";
import { useBillingPortal } from "@/lib/api/billing";
import { useGuardedRouter } from "@/lib/use-guarded-router";
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
  const router = useGuardedRouter();
  // The session claim is made in an effect, ONCE per state (a ref remembers it across StrictMode's double effect), never
  // during render: StrictMode's second render must not find the claim already taken and downgrade the first alert.
  const announceKind = state.live === "alert" ? state.kind : null;
  const claimed = React.useRef<{ kind: string; alert: boolean } | null>(null);
  const [alertKind, setAlertKind] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!announceKind) {
      claimed.current = null;
      setAlertKind(null);
      return;
    }
    if (claimed.current?.kind !== announceKind) {
      claimed.current = { kind: announceKind, alert: claimAlert(announceKind) };
    }
    setAlertKind(claimed.current.alert ? announceKind : null);
  }, [announceKind]);
  const alertNow = announceKind !== null && alertKind === announceKind;
  // SA-777: a Pay action that carries the oldest owed invoice's hosted page opens it directly (new tab); any
  // other action (or a Pay with no link) goes through the portal route exactly as before.
  const runAction = (a: { intent: string; url?: string }) => {
    if (a.intent === "pay" && a.url && a.url.startsWith("https://")) {
      window.open(a.url, "_blank", "noopener,noreferrer");
      return;
    }
    portal.mutate({ intent: a.intent as "pay" | "update-payment" });
  };
  const [tick, setTick] = React.useState(0);
  const dismissKey = state.dismiss?.key;
  const dismissed = React.useMemo(
    () => (state.dismiss ? isBannerDismissed(state.dismiss) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the dismissal's identity + our own tick
    [dismissKey, tick],
  );

  if (!state.inShell || state.tone === "none" || dismissed) return null;

  const action = state.action;
  // UX QA: no fixed height and no truncation: the sentence wraps (read-only stacks its 3 lines), the controls sit
  // on their own row at 390 (>= 44 px hit areas, the action full width) and beside the text from 640.
  const HIT = "min-h-[44px] min-w-[44px]";
  return (
    <div
      data-testid="subscription-strip"
      data-state={state.kind}
      role={alertNow ? "alert" : "status"}
      className={cn(
        "flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-[13px] ring-1 md:min-h-9 md:px-4 md:text-sm",
        TONE[state.tone],
      )}
    >
      <Info className="h-4 w-4 shrink-0 self-start mt-0.5" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-[12rem] space-y-1">
        {(state.lines ?? [state.copy]).map((line, i, all) => (
          <p key={i} data-testid="strip-line" className="break-words">
            {line}
            {i < all.length - 1 ? " " : ""}
          </p>
        ))}
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        {action && action.intent === "open-billing" && (
          <a
            href="/settings/billing"
            onClick={(e) => {
              e.preventDefault();
              router.push("/settings/billing"); // guarded: never drops an open cart silently
            }}
            className={cn(
              HIT,
              "inline-flex w-full items-center justify-center rounded-ctl border border-line-strong bg-paper px-3 text-[13px] font-medium text-navy sm:w-auto",
            )}
          >
            {action.label}
          </a>
        )}
        {action && action.intent !== "open-billing" && (
          <Button
            size="sm"
            variant="secondary"
            className={cn(HIT, "w-full shrink-0 sm:w-auto")}
            loading={portal.isPending}
            onClick={() => runAction(action)}
          >
            {action.label}
          </Button>
        )}
        {state.dismiss && (
          <button
            type="button"
            aria-label="Dismiss"
            className={cn(
              HIT,
              "inline-flex shrink-0 items-center justify-center rounded hover:bg-black/5",
            )}
            onClick={() => {
              dismissBanner(state.dismiss!);
              setTick((n) => n + 1);
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

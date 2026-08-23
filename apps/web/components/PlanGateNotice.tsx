"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import { registerPlanGateListener } from "@/lib/api-client";
import type { PlanGateBody } from "@/lib/plan-gate";

/** Repeat gates on the same flag are swallowed for this long — a little longer
 *  than the 4s toast duration, so a burst never stacks. */
const DEDUP_WINDOW_MS = 5_000;

/**
 * Mount once near the app root (mirrors ReAuthProvider's relationship to
 * session-expiry.ts) to turn a 403 PLAN_GATE on a gated GET into a friendly
 * toast instead of a query failing silently. Registers with the bridge in
 * api-client.ts on mount; renders nothing itself.
 *
 * Mutations already surface a message toast via `MutationCache.onError` in
 * app/providers.tsx, so api-client.ts only notifies this listener for GETs —
 * see the bridge comment there for why. Full LOCKED_PAGE / INLINE_RESOLVE
 * page states (components/gates/PlanGates.tsx) are a separate, larger
 * per-page treatment and out of scope here.
 */
export function PlanGateNotice(): null {
  const { toast } = useToast();
  // One gated page fires many gated requests at once (the analytics page alone
  // fires 12 GETs, all behind flag.analytics) and every failure reaches the
  // bridge. The notice is about the plan, not the request, so collapse a burst
  // on the same flag into one toast instead of burying the page under N.
  const lastNotified = React.useRef<{ key: string; at: number } | null>(null);

  React.useEffect(() => {
    return registerPlanGateListener((gate) => {
      const key = gate.flag ?? gate.message;
      const now = Date.now();
      const prev = lastNotified.current;
      if (prev && prev.key === key && now - prev.at < DEDUP_WINDOW_MS) return;
      lastNotified.current = { key, at: now };
      toast({
        title: gate.message,
        description: upgradeHint(gate) ?? undefined,
        variant: "warning",
      });
    });
  }, [toast]);

  return null;
}

/** "Add {addonSku}" / "Upgrade to {planKey}" hint text, or null when the gate
 *  body carries no upgrade suggestion. Prices are shown when present. */
function upgradeHint(gate: PlanGateBody): string | null {
  const u = gate.upgrade;
  if (!u) return null;
  if (u.addonSku) {
    return `Add ${u.addonSku}${u.addonMonthlyPrice ? ` · $${u.addonMonthlyPrice}/mo` : ""}`;
  }
  if (u.planKey) {
    return `Upgrade to ${u.planKey}${u.planMonthlyPrice ? ` · $${u.planMonthlyPrice}/mo` : ""}`;
  }
  return null;
}

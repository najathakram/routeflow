"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useToast } from "@routeflow/ui/web";
import { registerPlanGateListener } from "@/lib/api-client";
import { isRouteLocked } from "@/lib/plan-gate-lock";
import type { PlanGateBody } from "@/lib/plan-gate";

/** Repeat gates for one navigation are swallowed for this long — a little
 *  longer than the 4s toast duration, so a burst never stacks. */
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
  const pathname = usePathname();
  // A single navigation can fire several gated requests at once — one page
  // firing many GETs behind the SAME flag (the analytics page alone fires 12,
  // all behind flag.analytics), or, for a tenant licensed for some but not all
  // of a page's features, several DIFFERENT flags failing together (B449: a
  // LITE tenant hitting a locked route saw up to three toasts stack, naming
  // contradictory tiers). Either way it's one navigation and one notice — key
  // the dedup by pathname, not by flag, so it coalesces regardless of which
  // query happened to fail first.
  const lastNotified = React.useRef<{ pathname: string; at: number } | null>(null);

  // Explicit reset on navigation — a stale dedup entry from the PREVIOUS path must
  // never suppress (or be mistaken for) a notice on this one; keying by pathname
  // already implies this, but make it an actual invariant rather than an emergent one.
  React.useEffect(() => {
    lastNotified.current = null;
  }, [pathname]);

  React.useEffect(() => {
    return registerPlanGateListener((gate) => {
      // B449 fix-round finding 2: while `PlanGateBoundary` has this exact path locked,
      // it already fired the ONE deterministic notice for this navigation, naming the
      // route's own gate tier. A 403 from some other widget (e.g. a header/dashboard
      // fetch that isn't fully suppressed) must never add a second, possibly
      // contradictory one.
      if (isRouteLocked(pathname)) return;
      const now = Date.now();
      const prev = lastNotified.current;
      if (prev && prev.pathname === pathname && now - prev.at < DEDUP_WINDOW_MS) return;
      lastNotified.current = { pathname, at: now };
      toast({
        title: gate.message,
        description: upgradeHint(gate) ?? undefined,
        variant: "warning",
      });
    });
  }, [toast, pathname]);

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

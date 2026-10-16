"use client";

import type { PricePlan } from "@routeflow/pricing";

/**
 * PLACEHOLDER until K4 merges: K4's real units-v2/plan/AlsoUpdatePanel.tsx replaces this file at
 * integration (same export and props, SPRINT-CONTRACT §4). Renders nothing visible.
 */
export function AlsoUpdatePanel({ plan }: { plan: PricePlan }) {
  return (
    <div data-testid="units-v2-also-update-placeholder" data-changes={plan.changes.length} hidden />
  );
}

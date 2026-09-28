import Link from "next/link";
import type { TenantOnboardingView } from "@routeflow/types";
import { tenantOnboardingSummary } from "@routeflow/types";
import { STAGE_LABEL } from "../getting-started/GettingStartedView";

/**
 * #2159 S4: while this workspace is being onboarded, the dashboard points staff at the
 * "Getting started" checklist. Hidden once the case is LIVE (or when there is none).
 * Stateless, so it is pinned directly without mounting the dashboard's hooks.
 */
export function GettingStartedBanner({
  onboarding,
}: {
  onboarding: TenantOnboardingView | null | undefined;
}) {
  const summary = tenantOnboardingSummary(onboarding);
  if (!summary || !onboarding) return null;
  return (
    <div
      role="status"
      data-testid="getting-started-banner"
      className="flex flex-col gap-1 rounded-lg border border-surface-border bg-surface-raised px-4 py-3 text-sm text-navy sm:flex-row sm:items-center sm:justify-between"
    >
      <span>
        <span className="font-medium">Onboarding: {STAGE_LABEL[onboarding.stage]}.</span> {summary}
      </span>
      <Link
        href="/getting-started"
        className="inline-flex min-h-[44px] items-center font-medium text-[#0B6E6B] hover:underline sm:min-h-0"
      >
        Getting started →
      </Link>
    </div>
  );
}

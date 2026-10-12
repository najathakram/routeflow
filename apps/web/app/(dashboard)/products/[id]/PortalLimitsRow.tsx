"use client";

import * as React from "react";
import { Ban } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useProductLimits } from "@/lib/api/portal-limits";
import { LiftLimitsDialog } from "@/components/portal-limits/LiftLimitsDialog";
import { limitChipText, limitViaText } from "@/lib/portal-limits";

/**
 * "Portal limits" on the product page (spec §1, secondary 2): where limits are SEEN and LIFTED, not created. A chip per
 * rule that binds this product ("Not offered in TX", "Hidden from all portal customers"), "via Vapes" when it is
 * inherited from a category or parent, and Lift. TENANT_ADMIN and OPERATOR may lift (the server is the authority).
 */
export function PortalLimitsRow({ productId }: { productId: string }) {
  const role = useAuth().user?.role;
  const canLift = role === "TENANT_ADMIN" || role === "OPERATOR";
  const { data, isLoading, isError } = useProductLimits(productId);
  const [lifting, setLifting] = React.useState<string | null>(null);

  if (isLoading) return null;
  const limits = data ?? [];
  return (
    <div className="mt-4 border-t border-surface-border pt-3" data-testid="portal-limits-row">
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-navy">
        <Ban className="h-4 w-4 text-brand-600" aria-hidden /> Portal limits
      </h4>
      {isError ? (
        <p className="text-sm text-danger">Couldn&apos;t load portal limits.</p>
      ) : limits.length === 0 ? (
        <p className="text-sm text-navy/60">Offered to every portal customer.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="Portal limits on this product">
          {limits.map((l) => {
            const via = limitViaText(l);
            return (
              <li
                key={l.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-surface-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-navy"
              >
                <span>{limitChipText(l)}</span>
                {via && <span className="font-normal text-navy/60">{via}</span>}
                {canLift && (
                  <button
                    type="button"
                    className="text-[11px] font-medium text-brand-600 hover:underline"
                    onClick={() => setLifting(l.id)}
                  >
                    Lift
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <LiftLimitsDialog ids={lifting ? [lifting] : []} onClose={() => setLifting(null)} />
    </div>
  );
}

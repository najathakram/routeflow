"use client";

import * as React from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Ban } from "lucide-react";
import type { ProductLimitDto } from "@routeflow/types";
import { useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useReadOnlyGate } from "@/lib/read-only-gate";
import { useProductLimits } from "@/lib/api/portal-limits";
import { addRuleTargetsRequest, useRemoveFromRule } from "@/lib/api/rule-targets";
import { LiftLimitsDialog } from "@/components/portal-limits/LiftLimitsDialog";
import { RuleChooserDialog } from "@/components/restrictions/RuleChooserDialog";
import { limitChipText, limitViaText, UNDO_VISIBLE_MS } from "@/lib/portal-limits";
import {
  FEDERAL_ADMIN_ONLY,
  RESTRICT_UNDO_FAILED,
  coverageCount,
  coverageText,
  ruleHref,
} from "@/lib/rule-chooser";

/**
 * "Portal limits" on the product page (spec §1, secondary 2; row 509 PR5): the rules this product is in. A chip per
 * rule that binds it ("Not offered in TX", "Hidden from all portal customers"), "via Vapes" when it is inherited from
 * a category or parent, "· 12 products" when the rule covers many, and a link to the rule. A rule that covers only this
 * product keeps Lift; a MANY-product rule this product is directly in gets "Remove from rule" (it takes out only this
 * product, Undo puts it back), and lifting lives on the rule. Inherited chips keep Lift. "Add to a rule…" puts this
 * product in an existing rule. TENANT_ADMIN and OPERATOR may act (the server is the authority).
 */
export function PortalLimitsRow({ productId }: { productId: string }) {
  const role = useAuth().user?.role;
  const canLift = role === "TENANT_ADMIN" || role === "OPERATOR";
  const { data, isLoading, isError } = useProductLimits(productId);
  const readOnly = useReadOnlyGate().readOnly;
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  // The global handler toasts a refused remove (no local error surface here).
  const removeFromRule = useRemoveFromRule({ localErrorToast: false });
  const [lifting, setLifting] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  if (isLoading) return null;
  const limits = data ?? [];

  const isMany = (l: ProductLimitDto) => coverageCount(l.targetSummary) > 1;
  const removable = (l: ProductLimitDto) =>
    l.via === "PRODUCT" && l.directTarget === true && isMany(l);

  const remove = (l: ProductLimitDto) =>
    removeFromRule.mutate(
      { ruleId: l.id, productIds: [productId] },
      {
        onSuccess: (res) => {
          toast({
            title: "Removed from the rule",
            variant: "success",
            duration: UNDO_VISIBLE_MS,
            secondaryAction: { label: "View rule", onClick: () => router.push(ruleHref(l.id)) },
            ...(res.removed > 0
              ? {
                  action: {
                    label: "Undo",
                    onClick: () => {
                      addRuleTargetsRequest(l.id, { productIds: [productId] })
                        .then(() => {
                          qc.invalidateQueries({ queryKey: ["selling-restrictions"] });
                          toast({ title: "Undone", variant: "success" });
                        })
                        .catch(() => toast({ title: RESTRICT_UNDO_FAILED, variant: "error" }));
                    },
                  },
                }
              : {}),
          });
        },
      },
    );

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
            const many = isMany(l);
            const adminOnly = l.jurisdiction === "FEDERAL" && role !== "TENANT_ADMIN";
            return (
              <li
                key={l.id}
                className="inline-flex flex-wrap items-center gap-1.5 rounded-full border border-surface-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-navy"
              >
                {canLift ? (
                  <NextLink href={ruleHref(l.id)} className="hover:underline">
                    {limitChipText(l)}
                  </NextLink>
                ) : (
                  <span>{limitChipText(l)}</span>
                )}
                {many && (
                  <span className="font-normal text-navy/60">
                    {`· ${coverageText(l.targetSummary)}`}
                  </span>
                )}
                {via && <span className="font-normal text-navy/60">{via}</span>}
                {canLift &&
                  (removable(l) ? (
                    <button
                      type="button"
                      disabled={readOnly || adminOnly || removeFromRule.isPending}
                      title={adminOnly ? FEDERAL_ADMIN_ONLY : undefined}
                      className="text-[11px] font-medium text-brand-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => remove(l)}
                    >
                      Remove from rule
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={readOnly}
                      className="text-[11px] font-medium text-brand-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => setLifting(l.id)}
                    >
                      Lift
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {canLift && !isError && (
        <button
          type="button"
          disabled={readOnly}
          className="mt-2 min-h-11 text-xs font-medium text-brand-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
          onClick={() => setAdding(true)}
        >
          Add to a rule…
        </button>
      )}
      <LiftLimitsDialog
        ids={lifting ? [lifting] : []}
        inheritedFrom={
          limits.find((l) => l.id === lifting && l.via !== "PRODUCT")?.viaLabel ?? null
        }
        onClose={() => setLifting(null)}
      />
      <RuleChooserDialog
        open={adding}
        mode="add"
        productIds={[productId]}
        alreadyInRuleIds={limits.filter((l) => l.directTarget === true).map((l) => l.id)}
        onClose={() => setAdding(false)}
      />
    </div>
  );
}

"use client";

import * as React from "react";
import type { BusinessProfilePlan } from "@routeflow/types";
import { INCLUDED_FREE_COPY } from "./profile-plain-copy";
import { keyLabel } from "./setup-copy";

/** The part of a preview the sections read; both the capabilities preview and the profile preview fit it. */
export interface PlanSectionsSource {
  plan?: BusinessProfilePlan;
  changes?: string[];
}

/** The billing a plan really stops: comp rows switched off have nothing to bill. */
export function billingStops(
  source: PlanSectionsSource,
): { featureKey: string; manual: boolean }[] {
  return (source.plan?.billing ?? []).filter((b) => !b.comp);
}

/** True when the plan has nothing to bill, comp or change. */
export function isEmptyPlan(source: PlanSectionsSource): boolean {
  return (
    (source.plan?.billing ?? []).length === 0 &&
    (source.plan?.comps ?? []).length === 0 &&
    (source.changes ?? []).length === 0
  );
}

/**
 * The preview's three sections, shared by the Setup card's inline panel and the create form's review dialog so they
 * cannot drift. One verb pattern per line (BO-05 F14): "Turn off X. Billing stops." / "Turn on X. Included free."
 * Billing is built from `plan.billing` (never by slicing `summary`); a manually billed module says to remove it from
 * their manual invoice. Amber is for billing only; comps are emerald; everything else is slate.
 */
export function CapabilityPlanSections({
  source,
  idPrefix,
}: {
  source: PlanSectionsSource;
  idPrefix: string;
}) {
  const allBilling = source.plan?.billing ?? [];
  const stops = billingStops(source);
  const stripe = stops.filter((b) => !b.manual);
  const manual = stops.filter((b) => b.manual);
  const compsOff = allBilling.filter((b) => b.comp);
  const comps = source.plan?.comps ?? [];
  const changeLines = source.changes ?? [];

  return (
    <div className="flex flex-col gap-3">
      {stops.length > 0 && (
        <section
          data-testid="profile-preview-billing"
          aria-labelledby={`${idPrefix}-billing-title`}
          className="rounded-lg bg-amber-900/20 p-3 ring-1 ring-amber-500/30"
        >
          <h4 id={`${idPrefix}-billing-title`} className="text-sm font-semibold text-amber-300">
            Billing that stops
          </h4>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-slate-200">
            {stripe.map((b) => (
              <li key={b.featureKey} data-testid="profile-preview-billing-stops">
                Turn off {keyLabel(b.featureKey)}. Billing stops.
              </li>
            ))}
            {manual.map((b) => (
              <li key={b.featureKey} data-testid="profile-preview-billing-manual">
                Turn off {keyLabel(b.featureKey)}. Remove it from their manual invoice.
              </li>
            ))}
          </ul>
        </section>
      )}
      {comps.length > 0 && (
        <section
          data-testid="profile-preview-comps"
          aria-labelledby={`${idPrefix}-comps-title`}
          className="rounded-lg bg-emerald-900/20 p-3 ring-1 ring-emerald-500/30"
        >
          <h4 id={`${idPrefix}-comps-title`} className="text-sm font-semibold text-emerald-300">
            Turned on for this business
          </h4>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-slate-200">
            {comps.map((c) => (
              <li key={c.featureKey}>
                Turn on {keyLabel(c.featureKey)}.{" "}
                <span className="font-medium text-emerald-300">{INCLUDED_FREE_COPY}</span>.
              </li>
            ))}
          </ul>
        </section>
      )}
      {(changeLines.length > 0 || compsOff.length > 0) && (
        <section
          data-testid="profile-preview-changes"
          aria-labelledby={`${idPrefix}-changes-title`}
          className="rounded-lg bg-slate-900/40 p-3 ring-1 ring-white/10"
        >
          <h4 id={`${idPrefix}-changes-title`} className="text-sm font-semibold text-slate-200">
            Changes
          </h4>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-slate-200">
            {compsOff.map((b) => (
              <li key={`comp-off-${b.featureKey}`}>
                Turn off {keyLabel(b.featureKey)}. It was included free.
              </li>
            ))}
            {changeLines.map((line, i) => (
              <li key={`change-${i}`}>{line}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

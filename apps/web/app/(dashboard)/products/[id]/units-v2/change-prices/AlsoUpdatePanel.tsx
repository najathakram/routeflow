"use client";

import * as React from "react";
import type { PricePlan } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { usePriceDraft } from "../edit/usePriceDraft";
import { PlanView } from "./PlanView";
import { customerKeepKey, followerKey, keepMove } from "./selection";
import { usePlanNames } from "./usePlanNames";

/**
 * V02 / SA-799: the "this also changes / also update" panel under an edited cell. K3 mounts it as
 * `<AlsoUpdatePanel plan={draft.plan.plan} />`; the ticks and Keeps live in the shared draft, which Save commits.
 */
export function AlsoUpdatePanel({ plan }: { plan: PricePlan }) {
  const draft = usePriceDraft();
  const { tierName, customerName } = usePlanNames();
  const open = draft.plan;
  const selection = React.useMemo(
    () => ({
      ticked: open?.ticked ?? [],
      keeps: new Set((open?.keeps ?? []).map(followerKey)),
      customerKeeps: new Set((open?.customerKeeps ?? []).map(customerKeepKey)),
    }),
    [open],
  );
  const cell = open?.cell;
  const edited = cell
    ? plan.changes.find((c) => c.ref === cell.ref && c.tier === cell.tier)
    : undefined;
  return (
    <PlanView
      plan={plan}
      selection={selection}
      heading={
        edited
          ? `${tierName(edited.tier)} ${edited.label}: ${formatMoney(edited.from)} to ${formatMoney(edited.to)}`
          : undefined
      }
      tierName={tierName}
      customerName={customerName}
      onToggleOffer={draft.setOfferTicked}
      onToggleKeep={(f, on) => (on ? draft.keep(f.keep) : draft.unkeep(f.keep))}
      onToggleCustomerKeep={(c, on) => draft.keepCustomer(keepMove(c), on)}
    />
  );
}

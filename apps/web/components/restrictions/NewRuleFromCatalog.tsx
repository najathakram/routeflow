"use client";

import * as React from "react";
import type { PickedTarget } from "@/lib/rule-targets";
import { RuleFormDialog } from "@/app/(dashboard)/settings/restrictions/rules/_components/RuleFormDialog";

/**
 * "New rule with N products…" from the catalog (row 509 PR5): the rule editor, opened with the selected products
 * already in it. This wrapper owns the catalog's side of the seam.
 *
 * It seeds PR4's `RuleFormDialog` with one PRODUCT pick per selected id, named from the catalog page. An id the
 * page does not hold (selected through "Select all matching") has no name here: its chip reads "Selected product"
 * and the rule is still created with it (the server resolves every id; RULE_TARGETS_NOT_FOUND if one is gone).
 *
 * Mounted only while open (the rules page does the same), so the form starts fresh.
 */
export function NewRuleFromCatalog({
  productIds,
  names,
  onClose,
  onCreated,
}: {
  productIds: string[];
  names: Record<string, string>;
  onClose: () => void;
  /** After the rule is created (the catalog clears its selection). */
  onCreated?: () => void;
}) {
  const initialTargets = React.useMemo<PickedTarget[]>(
    () =>
      productIds.map((id) => ({
        kind: "PRODUCT" as const,
        id,
        name: names[id] ?? "Selected product",
      })),
    [productIds, names],
  );
  return (
    <RuleFormDialog
      open
      onClose={onClose}
      initialTargets={initialTargets}
      onCreated={() => onCreated?.()}
    />
  );
}

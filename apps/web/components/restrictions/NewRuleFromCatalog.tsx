"use client";

import * as React from "react";
import { RuleFormDialog } from "@/app/(dashboard)/settings/restrictions/rules/_components/RuleFormDialog";

/**
 * "New rule with N products…" from the catalog (row 509 PR5): the rule editor, opened with the selected products
 * already in it. This wrapper owns the catalog's side of the seam.
 *
 * PROP CONTRACT for PR4's `RuleFormDialog` (the integrator connects it):
 *   initialTargets?: { productIds: string[]; names: Record<string, string> }
 * When present the form opens with "Applies to: Products" and one chip per id, labelled from `names` (an id with no
 * name is a product the catalog page does not hold, e.g. selected through "Select all matching"; the picker resolves
 * those). It applies on every open, so a reopened dialog does not carry the last rule's products.
 *
 * Mounted only while open (the rules page does the same), so the form starts fresh.
 */
export function NewRuleFromCatalog({
  productIds,
  names,
  onClose,
}: {
  productIds: string[];
  names: Record<string, string>;
  onClose: () => void;
}) {
  return (
    <RuleFormDialog
      open
      onClose={onClose}
      // @ts-expect-error until PR4 lands: RuleFormDialog does not declare `initialTargets` yet (remove this line then).
      initialTargets={{ productIds, names }}
    />
  );
}

import * as React from "react";
import { billedChargeLines, invoiceTaxSplit, type ChargeLine } from "@routeflow/pricing";
import { useTrackedCategories } from "@/lib/api/tracked-categories";

/** An invoice line as the tax split reads it: its billed levy and its category (the name comes from the categories list). */
interface SplitLine {
  categoryTaxAmount?: number | string | null;
  trackedCategoryId?: string | null;
  categoryTaxType?: string | null;
  /** the category row the payload already carries (name, type): used until / unless the categories list answers */
  trackedCategory?: { id?: string | null; name?: string | null; taxType?: string | null } | null;
}

/**
 * Row 398 / CQ-03: the invoice's header `taxAmount` holds the regular tax PLUS the levy (deposit, excise). Every staff
 * screen shows them apart, as the PDF does: Tax is the regular tax and each regulated category is its own named
 * charge. Names come from ALL tracked categories (an inactive one still bills); an unnamed charge falls back to its
 * tax-type word ("Deposit", "Excise") until the list loads. ONE helper, `invoiceTaxSplit` in @routeflow/pricing.
 */
export function useInvoiceTaxSplit(
  invoice: { taxAmount?: number | string | null; items?: readonly SplitLine[] | null } | undefined,
  enabled = true,
): { tax: number; charges: ChargeLine[] } {
  const { data } = useTrackedCategories({}, { enabled: enabled && !!invoice });
  return React.useMemo(() => {
    const byId = new Map((Array.isArray(data) ? data : []).map((c) => [c.id, c]));
    return invoiceTaxSplit(
      invoice?.taxAmount,
      (invoice?.items ?? []).map((it) => ({
        categoryTaxAmount: it.categoryTaxAmount,
        trackedCategoryId: it.trackedCategoryId,
        categoryTaxType: it.categoryTaxType,
        trackedCategory: it.trackedCategoryId
          ? (byId.get(it.trackedCategoryId) ?? it.trackedCategory ?? null)
          : null,
      })),
    );
  }, [invoice, data]);
}

/** The named levy charges of an ORDER's lines (its `tax` is already the regular tax only). */
export function useOrderCharges(
  lines: readonly SplitLine[] | undefined,
  enabled = true,
): ChargeLine[] {
  const { data } = useTrackedCategories({}, { enabled: enabled && !!lines });
  return React.useMemo(() => {
    const byId = new Map((Array.isArray(data) ? data : []).map((c) => [c.id, c]));
    return billedChargeLines(
      (lines ?? []).map((l) => ({
        categoryTaxAmount: l.categoryTaxAmount,
        trackedCategoryId: l.trackedCategoryId,
        categoryTaxType: l.categoryTaxType,
        trackedCategory: l.trackedCategoryId
          ? (byId.get(l.trackedCategoryId) ?? l.trackedCategory ?? null)
          : null,
      })),
    );
  }, [lines, data]);
}

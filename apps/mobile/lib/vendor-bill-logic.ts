import type { VendorBillStatus } from "./api/vendor-bills";

/**
 * Pure (screen-free, testable) vendor-bill status → pill mapping. Extracted
 * 2026-09-03 (wave E / imp-10b, L-072) from three byte-identical copies that
 * had drifted from the schema (`"FULL"` instead of `"PAID"`, no `"OVERDUE"`
 * branch — see `apps/mobile/__tests__/vendor-bill-status.test.ts`). Kept out
 * of the RN screens so `__tests__/*.test.ts` (pure-logic, node env) can lock it.
 * Mirrored by `apps/mobile/app/(operator)/{(tabs)/finance,vendor-bills/{index,[id]}}.tsx`.
 */
export type VendorBillPillVariant = "gray" | "orange" | "green" | "red";

export interface VendorBillPill {
  variant: VendorBillPillVariant;
  label: string;
}

export function vendorBillPillFor(status: VendorBillStatus): VendorBillPill {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "RECEIVED":
      return { variant: "orange", label: "Received" };
    case "PARTIAL":
      return { variant: "orange", label: "Partial" };
    case "PAID":
      return { variant: "green", label: "Paid" };
    case "OVERDUE":
      return { variant: "red", label: "Overdue" };
    case "VOID":
      return { variant: "gray", label: "Void" };
    default:
      // Total return (X4, review F5): mirrors estimatePillFor's default in
      // this app — an unrecognized/future status gets a neutral pill instead
      // of an undefined crash at the call site.
      return { variant: "gray", label: status };
  }
}

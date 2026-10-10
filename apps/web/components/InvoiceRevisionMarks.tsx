import * as React from "react";
import { overpaidText, revisedBadgeText } from "@/lib/invoice-revision";
import { useTenantTimeZone } from "@/lib/tenant-timezone";

/** P-4: "Revised {date}" badge and "Overpaid by $X" line. Both come from optional API fields; absent = nothing renders. */
export function InvoiceRevisionMarks({
  revisedAt,
  overpaidBy,
  timeZone,
}: {
  revisedAt?: string | null;
  overpaidBy?: number | null;
  /** The business's IANA zone; the revised day is read in it, not in the browser's zone. */
  timeZone?: string;
}) {
  const revised = revisedBadgeText(revisedAt, timeZone);
  const overpaid = overpaidText(overpaidBy);
  if (!revised && !overpaid) return null;
  return (
    <>
      {revised && (
        <span
          data-testid="invoice-revised-badge"
          className="inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-navy ring-1 ring-black/5"
        >
          {revised}
        </span>
      )}
      {overpaid && (
        <span
          data-testid="invoice-overpaid"
          className="inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-navy ring-1 ring-black/5"
        >
          {overpaid}
        </span>
      )}
    </>
  );
}

/** Staff screens: the same marks, with the revised day read in the tenant's zone (GET /settings `timezone`). */
export function TenantInvoiceRevisionMarks(
  props: Omit<React.ComponentProps<typeof InvoiceRevisionMarks>, "timeZone">,
) {
  const timeZone = useTenantTimeZone();
  return <InvoiceRevisionMarks {...props} timeZone={timeZone} />;
}

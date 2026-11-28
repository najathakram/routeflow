import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { tenantTimeZone } from "../common/tenant-time-zone";
import { calendarFieldStamp } from "./invoice-due-dates";
import { statusFromPayments } from "./invoice-status";
import { sumConfirmed } from "./payment-predicates";

/** The collaborator the terms edit needs, bound by the caller (InvoicesService passes its own). */
export interface InvoiceTermsDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaService and its test mock both fit
  prisma: any;
}

/**
 * WP3: narrow post-issue correction for exactly `{ dueDate?, paymentTermsLabel?,
 * referenceNumber?, subject? }` — NEVER items/discount/shipping/deposit, which
 * still require a credit note (money already sent to the customer) or a DRAFT
 * edit. Allowed on any status EXCEPT VOID/WRITTEN_OFF — unlike
 * applyPriceAdjustment, which also blocks PAID; a paid invoice's label/reference
 * can still be corrected without touching its money.
 *
 * A dueDate change can flip SENT↔OVERDUE, so recomputeStatus re-runs on every
 * call (a no-op when dueDate is unchanged) — the SAME status contract used
 * everywhere else in this file, byte-identical, never re-derived here.
 *
 * Deliberately does NOT call recomputeOrderFromInvoices: this edit never
 * changes subtotal/tax/fee (the order's total is defined off those), so there
 * is nothing for the linked order to resync — pinned by a spec.
 *
 * Audit trail: an internalNotes breadcrumb (mirrors applyPriceAdjustment's
 * convention) is the only audit record. Wiring the global AuditService was
 * considered and IS mechanically easy — it needs no InvoicesModule change
 * (AuditModule is @Global(), exports AuditService) — but every existing
 * `audit.log()` call site in this codebase attributes to a real caller
 * (`userId: user.sub`, never null), and this method's signature is fixed by
 * the plan at exactly (id, dto) with no user/JwtPayload parameter to supply
 * one. Logging with a null actor would be a new, weaker kind of audit entry
 * that breaks that house convention rather than extending it, and the
 * signature isn't mine to change (the controller — WP3, a different file —
 * calls exactly this shape). The internalNotes breadcrumb alone is the
 * reported choice; see this package's report for the full reasoning.
 */
export async function updateInvoiceTerms(
  deps: InvoiceTermsDeps,
  id: string,
  dto: {
    dueDate?: string;
    paymentTermsLabel?: string;
    referenceNumber?: string;
    subject?: string;
  },
) {
  const tz = await tenantTimeZone(deps.prisma); // SA-495a: the tenant's due day, once per call
  const inv = await deps.prisma.forTenant().invoice.findUnique({
    where: { id },
    include: { payments: true },
  });
  if (!inv) throw new NotFoundException("Invoice not found");
  if (inv.status === InvoiceStatus.VOID || inv.status === InvoiceStatus.WRITTEN_OFF) {
    throw new BadRequestException(`Cannot edit terms on a ${inv.status} invoice.`);
  }

  const asDate = (d: unknown): Date | null =>
    d == null ? null : d instanceof Date ? d : new Date(d as string);
  const oldDueDate = asDate(inv.dueDate);
  const oldDueDateStr = oldDueDate ? oldDueDate.toISOString().slice(0, 10) : "none";
  const newDueDate = dto.dueDate ? calendarFieldStamp(dto.dueDate, "dueDate") : oldDueDate; // #2256
  const newDueDateStr = newDueDate ? newDueDate.toISOString().slice(0, 10) : "none";

  // F03/R1: CONFIRMED (PAID) payments only — same predicate every other status
  // computation in this file uses.
  const totalPaid = sumConfirmed(inv.payments);
  const newStatus = statusFromPayments(
    totalPaid,
    Number(inv.total),
    newDueDate,
    inv.status,
    tz,
    "NOT_PAID",
  );

  const auditLine = `[${new Date().toLocaleDateString()} — Terms updated: ${oldDueDateStr} → ${newDueDateStr}]`;
  const existingInternal = (inv as any).internalNotes ?? "";

  return deps.prisma.forTenant().invoice.update({
    where: { id },
    data: {
      ...(dto.dueDate !== undefined && { dueDate: newDueDate }),
      // "" is how the Edit Terms modal CLEARS a field (an operator who blanks
      // a mislabeled "Net 45" or a stale PO number) — store null, never an
      // empty string; same convention as `update()` above and the customer /
      // supplier default-terms fields. Absent (undefined) still means
      // "leave unchanged".
      ...(dto.paymentTermsLabel !== undefined && {
        paymentTermsLabel: dto.paymentTermsLabel || null,
      }),
      ...(dto.referenceNumber !== undefined && {
        referenceNumber: dto.referenceNumber || null,
      }),
      ...(dto.subject !== undefined && { subject: dto.subject || null }),
      status: newStatus,
      internalNotes: existingInternal ? `${existingInternal}\n${auditLine}` : auditLine,
    },
    include: {
      customer: { select: { id: true, businessName: true } },
      items: true,
      payments: true,
    },
  });
}

import { UserRole } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { overdueCutoff } from "../common/calendar-date";
import { customerInvoiceList } from "../common/staff-only-fields";
import type { ListInvoicesDto } from "./dto/list-invoices.dto";
import { computeDepositFields } from "./deposit-fields";
import { revisedAtByInvoice } from "./invoice-detail-read";
import { classifyInvoiceBalance } from "./invoice-balance-classify";
import { listRowFlags } from "./invoice-row-flags";
import { splitConfirmed } from "./payment-predicates";
import { overpaidByOf } from "./invoice-status";
import {
  applyInvoiceSearchAndDateFilters,
  applyInvoiceStatusFilters,
  applyOverdueBalanceFilter,
  invoiceListOrderBy,
} from "./invoice-list-query";

/**
 * Moved verbatim out of `invoices.service.ts` (size ratchet, SA-065). `InvoicesService.findAll` is a one-line delegate,
 * so its controller and specs are unchanged. The tenant-defaults lookup is passed in (it stays a private service method
 * shared with create/update).
 */
export interface InvoiceListDeps {
  prisma: PrismaService;
  resolveTenantInvoiceDefaults: () => Promise<{ timezone: string | null }>;
}

/** The invoices list page: filters, one page of rows, and each row's balance, overdue and deposit fields. */
export async function listInvoices(
  deps: InvoiceListDeps,
  query: ListInvoicesDto,
  user?: JwtPayload,
) {
  const { customerId, sortBy, sortOrder, page = 1, limit = 20 } = query;
  const skip = (page - 1) * limit;
  const where: any = {};
  // SA-488 / row 308: the tenant's zone, read ONCE per request: the isOverdue filter and every row's
  // isOverdue flag end the due day in it (one cutoff, so the list and its filter always agree).
  const tz = (await deps.resolveTenantInvoiceDefaults()).timezone;
  applyInvoiceStatusFilters(where, query, tz, user?.role);
  if (user?.role === UserRole.CUSTOMER) {
    const customer = await deps.prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub } });
    if (!customer) return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    where.customerId = customer.id;
    // Buyers must not see DRAFT invoices (not yet issued to them)
    if (!where.status) {
      where.status = { not: "DRAFT" };
    } else if (where.status?.in) {
      where.status.in = where.status.in.filter((s: string) => s !== "DRAFT");
    } else if (where.status === "DRAFT") {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }
  } else if (customerId) {
    where.customerId = customerId;
  }
  applyInvoiceSearchAndDateFilters(where, query);
  // SA-770: overdue = past due AND a balance is owed (the one SQL predicate); no tenant, no list.
  if (!(await applyOverdueBalanceFilter(where, query, deps.prisma, deps.prisma.getTenantId())))
    return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
  const orderBy = invoiceListOrderBy(sortBy, sortOrder);

  const [data, total] = await Promise.all([
    deps.prisma.forTenant().invoice.findMany({
      where,
      include: {
        customer: { select: { id: true, businessName: true } },
        payments: { orderBy: { createdAt: "desc" } },
        // Shipments lists hide the shipped date of an unmarked order (status only, no column).
        // counterSale: the paid-at-sale flag below (row 401), so a till sale's list row shows no due date.
        order: { select: { status: true, counterSale: true } },
      },
      skip,
      take: limit,
      orderBy,
    }),
    deps.prisma.forTenant().invoice.count({ where }),
  ]);

  // Compute balanceDue server-side so the client always gets the right value
  // regardless of whether InvoicePayment records exist (e.g. Zoho-imported invoices)
  //
  // RF-202: isOverdue uses ISO date-string comparison (YYYY-MM-DD) so that an
  // invoice due *today* is NOT considered overdue.  Comparing Date objects
  // directly would treat a due date of "2026-05-01" (midnight UTC) as overdue
  // any time after midnight UTC on that date, regardless of local timezone.
  // Business rule: grace period extends through the end of the due date.
  const revisedAt = await revisedAtByInvoice(
    deps.prisma.forTenant(),
    data.map((i) => i.id),
  );
  const overdueBy = overdueCutoff(new Date(), tz);
  const todayIso = overdueBy.toISOString().slice(0, 10); // the tenant's day, like isOverdue (and the deposit check)
  const computedData = data.map((inv) => {
    // F03/R1/T-B11s: CONFIRMED (PAID) payments only. An unconfirmed DRAFT
    // payment (e.g. a bulk bank-reconciliation entry an operator hasn't
    // confirmed yet) must not be folded into the list's own balance-due number
    // any more than a VOID (bounced check, P5-12) one is — both must match
    // findOne's paidAmount/balanceDue.
    //
    // B421: paidAmount is now CASH-ONLY (a CREDIT_NOTE application is not
    // money the tenant received, and rendered/counted as "Paid" it looked
    // like one) — creditApplied/advanceApplied are separate fields. The
    // customer's OBLIGATION is still reduced by any confirmed method, so
    // balanceDue and the deposit check both use the full confirmed total.
    const { cash: paidAmount, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
    const totalConfirmed = paidAmount + creditApplied + advanceApplied;
    // SA-770: balanceDue + isOverdue come from the ONE classifier (B421 F3's roundMoney-before->0 rule and
    // RF-202's "due today is not overdue" live there), judged on the tenant's day (row 308; UTC when it has no zone).
    const { balanceDue, isOverdue } = classifyInvoiceBalance(inv, overdueBy);
    const { depositAmount, depositOverdue } = computeDepositFields(
      inv as any,
      totalConfirmed,
      todayIso,
    );
    return {
      ...inv,
      balanceDue,
      overpaidBy: overpaidByOf(inv.total, paidAmount), // SA-763r P-3
      revisedAt: revisedAt.get(inv.id) ?? null,
      paidAmount,
      creditApplied,
      advanceApplied,
      isOverdue,
      depositAmount,
      depositOverdue,
      ...listRowFlags(inv),
    };
  });

  return {
    data: customerInvoiceList(computedData, user?.role === UserRole.CUSTOMER),
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

import { BadRequestException } from "@nestjs/common";
import { InvoiceStatus, Prisma, UserRole } from "@prisma/client";
import type { InvoiceKpiSummary } from "@routeflow/types";
import type { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { roundMoney } from "@routeflow/pricing";
import { addCalendarDays, overdueCutoff } from "../common/calendar-date";
import { KPI_SUMMARY_EXCLUDED } from "./invoice-status-sets";
import { classifyInvoiceBalance } from "./invoice-balance-classify";

/**
 * Moved verbatim out of `invoices.service.ts` (size ratchet, SA-065). `InvoicesService.getKpiSummary`
 * is a one-line delegate, so its controller and specs are unchanged. The tenant-defaults lookup is
 * passed in (it stays a private service method shared with create/update).
 */
export interface InvoiceKpiDeps {
  prisma: PrismaService;
  resolveTenantInvoiceDefaults: () => Promise<{ timezone: string | null }>;
}

/**
 * B12: the invoices page's six KPI tiles, computed by the DATABASE over the
 * whole OPEN set — never a client `useInvoices({ limit: 999 })`
 * fetch-all-then-reduce, which silently drops whichever rows page 1000+
 * would have held (exactly the oldest, most delinquent invoices).
 *
 * `today` is the VIEWER's calendar day (`YYYY-MM-DD`), passed by the client. SA-488 (#2493):
 * when the tenant's zone is known the buckets use the TENANT's today instead, so the tiles agree
 * with the overdue cron, list filter and bookkeeping aging; the viewer's day is the fallback.
 */
export async function computeInvoiceKpiSummary(
  deps: InvoiceKpiDeps,
  viewerToday: string,
  user: JwtPayload,
): Promise<InvoiceKpiSummary> {
  let today = viewerToday;
  // The DTO's regex pins the SHAPE; this pins the CALENDAR. `2026-13-01`
  // matches the regex and would blow up on `.toISOString()` below — after
  // three queries had already run — and `2026-02-30` would silently roll to
  // Mar 2 and bucket the tiles against a day the caller never asked for.
  const todayInstant = new Date(`${today}T00:00:00.000Z`);
  if (Number.isNaN(todayInstant.getTime()) || todayInstant.toISOString().slice(0, 10) !== today) {
    throw new BadRequestException("today must be a real calendar date (YYYY-MM-DD)");
  }
  const { timezone } = await deps.resolveTenantInvoiceDefaults();
  if (timezone) today = overdueCutoff(new Date(), timezone).toISOString().slice(0, 10);

  const tenantId = deps.prisma.getTenantId();
  // No tenant context (SUPER_ADMIN / unset): `forTenant()` would read UNSCOPED
  // while the raw query's `"tenantId" = NULL` matches nothing — one response
  // mixing all-tenant totals with a zeroed average. Return the zeroed summary
  // instead, the same guard `resolveTenantInvoiceDefaults` uses.
  if (!tenantId) {
    return {
      totalOutstanding: 0,
      overdue: 0,
      dueToday: 0,
      dueIn30: 0,
      avgDays: 0,
      awaitingConfirmationCount: 0,
    };
  }

  // A CUSTOMER sees only their OWN receivables — the same scope `findAll`
  // applies above, resolved the same way. Without it the tiles would hand a
  // buyer the whole tenant's outstanding balance. (For the money tiles DRAFT
  // needs no extra exclusion: KPI_SUMMARY_EXCLUDED already drops it. The
  // awaiting-confirmation count is not on that set, so it carries findAll's
  // buyer DRAFT rule itself — see m7 below.)
  let customerId: string | undefined;
  if (user?.role === UserRole.CUSTOMER) {
    const customer = await deps.prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub } });
    // No customer profile: `findAll` returns an empty page, so the tiles zero out.
    if (!customer) {
      return {
        totalOutstanding: 0,
        overdue: 0,
        dueToday: 0,
        dueIn30: 0,
        avgDays: 0,
        awaitingConfirmationCount: 0,
      };
    }
    customerId = customer.id;
  }

  const [invoices, awaitingConfirmationCount, avgDaysRows] = await Promise.all([
    // No `take` — the OPEN set is read whole, not capped like a rendering page.
    deps.prisma.forTenant().invoice.findMany({
      where: { status: { notIn: KPI_SUMMARY_EXCLUDED }, ...(customerId ? { customerId } : {}) },
      select: {
        total: true,
        status: true,
        dueDate: true,
        payments: { select: { amount: true, status: true } },
      },
    }),
    // m7 (F16 hotfix): this tile is NOT on the money tiles' OPEN basis. It
    // reproduces the client memo it replaced, which counted every DRAFT
    // payment on every invoice `useInvoices({ limit: 999 })` returned —
    // `for (const p of inv.payments ?? []) { if (p.status === "DRAFT")
    // awaitingConfirmationCount++; }`, above and outside the memo's own
    // status branches, so no invoice status was excluded. Scoping it to
    // KPI_SUMMARY_EXCLUDED zeroed the tile for the commonest case there is:
    // a payment recorded against a still-DRAFT invoice, which `recordPayment`
    // deliberately leaves DRAFT (recomputeStatus treats DRAFT as terminal).
    // The queue exists to make unconfirmed money visible wherever it sits;
    // the invoice's own status is not what makes a draft payment actionable.
    deps.prisma.forTenant().invoicePayment.count({
      where: {
        status: "DRAFT",
        // Staff: no invoice-status scope at all — the memo had none. A BUYER
        // gets exactly `findAll`'s buyer scope instead: their own customer's
        // invoices, minus the DRAFT ones a buyer is never shown.
        ...(customerId ? { invoice: { customerId, status: { not: InvoiceStatus.DRAFT } } } : {}),
      },
    }),
    // Tenant id (and a buyer's customer id) reach the raw query as BOUND
    // values, never string-interpolated.
    deps.prisma.$queryRaw<{ avgDays: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM ("paidAt" - "sentAt")) / 86400)::float AS "avgDays"
      FROM "Invoice"
      WHERE "tenantId" = ${tenantId}
        ${customerId ? Prisma.sql`AND "customerId" = ${customerId}` : Prisma.empty}
        AND status = 'PAID'
        AND "paidAt" IS NOT NULL
        AND "sentAt" IS NOT NULL
        -- A PAID invoice re-sent as a receipt re-stamps sentAt AFTER paidAt
        -- (send(), sendEmail()), which would feed a large negative duration
        -- into the average. The client memo this replaced discarded those
        -- rows with "days >= 0"; so does this.
        AND "paidAt" >= "sentAt"
    `,
  ]);

  // RF-202 convention: ISO date-string comparison (YYYY-MM-DD), never raw
  // Date objects — a due date is a UTC-midnight calendar stamp, `today` is
  // the viewer's own calendar day, so the comparison must stay date-only.
  const cutoff = addCalendarDays(new Date(`${today}T00:00:00.000Z`), 30)
    .toISOString()
    .slice(0, 10);

  let totalOutstanding = 0;
  let overdue = 0;
  let dueToday = 0;
  let dueIn30 = 0;
  // SA-770: "overdue" is the staff rule, from the ONE classifier: a balance is due AND the due DAY has
  // ended before `today` (the tenant's day when its zone is known). The old m5 disjunct (a stale
  // status-OVERDUE flag counted as overdue whatever the due date said) is retired.
  const todayCutoff = new Date(`${today}T00:00:00.000Z`);
  for (const inv of invoices) {
    // Same balance basis as findAll's enrichment above: CONFIRMED (PAID)
    // payments only reduce the outstanding figure.
    const { balanceDue: balance, isOverdue } = classifyInvoiceBalance(inv as any, todayCutoff);
    totalOutstanding += balance;
    const dueDateIso = inv.dueDate
      ? (inv.dueDate instanceof Date ? inv.dueDate : new Date(inv.dueDate))
          .toISOString()
          .slice(0, 10)
      : null;
    if (isOverdue) overdue += balance;
    // No dueDate: totalOutstanding only, no bucket. A past due day with nothing owed adds 0 anyway.
    else if (dueDateIso == null || dueDateIso < today) continue;
    else if (dueDateIso === today) dueToday += balance;
    else if (dueDateIso <= cutoff) dueIn30 += balance;
  }

  return {
    totalOutstanding: roundMoney(totalOutstanding),
    overdue: roundMoney(overdue),
    dueToday: roundMoney(dueToday),
    dueIn30: roundMoney(dueIn30),
    avgDays: avgDaysRows[0]?.avgDays ?? 0,
    awaitingConfirmationCount,
  };
}

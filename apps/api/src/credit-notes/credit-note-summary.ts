import { BadRequestException } from "@nestjs/common";
import { CreditNoteStatus, UserRole } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type { CreditNoteSummary } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { addCalendarDays } from "../common/calendar-date";
import type { PrismaService } from "../prisma/prisma.service";
import { isOpenCreditNote } from "./sourced-credit-guard";

const ZERO: CreditNoteSummary = {
  counts: { total: 0, issued: 0, applied: 0, void: 0 },
  openCredit: 0,
  openCount: 0,
  issued30Value: 0,
  issued30Count: 0,
  topReason: "—",
  topReasonPct: 0,
};

/**
 * B238: the credit-notes page's counters and money tiles, over EVERY note. The page used to fetch
 * `useCreditNotes({ limit: 999 })` and reduce on the client, which drops whichever rows page 1000+ would have held (the same
 * shape B12 removed from the invoices page). The status counts are a database GROUP BY; the money tiles read the non-void set
 * whole (selected columns only, no `take`), with the canonical open predicate (`isOpenCreditNote`, written once) and cent
 * rounding on every note and every sum.
 *
 * `viewerToday` is the VIEWER's calendar day: "last 30 days" starts at that day minus 30, at 00:00 UTC. A buyer sees only
 * their own notes (as `findAllForUser`); a driver, a buyer with no profile and a request with no tenant see zeros.
 */
export async function computeCreditNoteSummary(
  deps: { prisma: PrismaService },
  viewerToday: string,
  user: JwtPayload,
  now: Date = new Date(),
): Promise<CreditNoteSummary> {
  const todayInstant = new Date(`${viewerToday}T00:00:00.000Z`);
  if (
    Number.isNaN(todayInstant.getTime()) ||
    todayInstant.toISOString().slice(0, 10) !== viewerToday
  ) {
    throw new BadRequestException("today must be a real calendar date (YYYY-MM-DD)");
  }
  if (!deps.prisma.getTenantId() || user?.role === UserRole.DRIVER) return structuredClone(ZERO);

  const db = deps.prisma.forTenant();
  let customerWhere: { customerId: string } | Record<string, never> = {};
  if (user?.role === UserRole.CUSTOMER) {
    const customer = await db.customer.findFirst({ where: { userId: user.sub } });
    if (!customer) return structuredClone(ZERO);
    customerWhere = { customerId: customer.id };
  }

  const [byStatus, live] = await Promise.all([
    db.creditNote.groupBy({
      by: ["status"],
      where: customerWhere,
      _count: { _all: true },
    }),
    db.creditNote.findMany({
      where: { status: { not: CreditNoteStatus.VOID }, ...customerWhere },
      select: { amount: true, amountUsed: true, expiresAt: true, reason: true, createdAt: true },
    }),
  ]);

  const counts = { total: 0, issued: 0, applied: 0, void: 0 };
  for (const row of byStatus) {
    const n = row._count._all;
    counts.total += n;
    if (row.status === CreditNoteStatus.ISSUED) counts.issued += n;
    else if (row.status === CreditNoteStatus.APPLIED) counts.applied += n;
    else if (row.status === CreditNoteStatus.VOID) counts.void += n;
  }

  const cutoff = addCalendarDays(todayInstant, -30);
  let openCredit = 0;
  let openCount = 0;
  let issued30Value = 0;
  let issued30Count = 0;
  let creditedTotal = 0;
  const byReason = new Map<string, number>();
  for (const cn of live) {
    const amount = roundMoney(Number(cn.amount));
    if (isOpenCreditNote(cn, now)) {
      openCount++;
      openCredit = roundMoney(openCredit + roundMoney(amount - Number(cn.amountUsed ?? 0)));
    }
    if (new Date(cn.createdAt) >= cutoff) {
      issued30Count++;
      issued30Value = roundMoney(issued30Value + amount);
    }
    const reason = (cn.reason ?? "").trim() || "—";
    byReason.set(reason, roundMoney((byReason.get(reason) ?? 0) + amount));
    creditedTotal = roundMoney(creditedTotal + amount);
  }

  let topReason = "—";
  let topReasonValue = 0;
  for (const [reason, value] of byReason) {
    if (value > topReasonValue) {
      topReason = reason;
      topReasonValue = value;
    }
  }
  const topReasonPct = creditedTotal > 0 ? Math.round((topReasonValue / creditedTotal) * 100) : 0;

  return { counts, openCredit, openCount, issued30Value, issued30Count, topReason, topReasonPct };
}

import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import type { TodaysSalesResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import {
  addCalendarDays,
  calendarDateFromIso,
  isoFromCalendarDate,
  parseCalendarDay,
  startOfCalendarDay,
  startOfLocalDay,
} from "../../common/calendar-date";
import { resolveZone } from "../../common/tenant-time-zone";
import { PrismaService } from "../../prisma/prisma.service";
import type { CounterSaleTodayDto } from "./counter-sale-today.dto";
import {
  TODAYS_SALES_DEFAULT_LIMIT,
  counterSalesWhere,
  foldSummary,
  liveCounterSalesWhere,
  pageQuery,
  paidOnDaysSalesWhere,
  salePaymentsWhere,
  toTodaysSaleRow,
  windowReturnsWhere,
  type TodayOrderRecord,
} from "./counter-sale-today";

const badDay = (message: string) =>
  new BadRequestException({ code: API_ERROR_CODES.COUNTER_SALES_DAY_INVALID, message });

/**
 * GET /orders/counter-sale/today (POS-7b): the register's "Today's sales" read. Read-only: no writes, no
 * locks, no key. Every read rides forTenant(); the day is the TENANT's calendar day, cut by the shared
 * calendar-date helpers (DST-safe), never by this class.
 *
 * Query budget (a spec pins it): the zone (1) + the page `findMany` (1) + the `count` (1), and on page 1 only the
 * four whole-day summary queries: `order.aggregate`, `invoicePayment.groupBy` (money in, by paid date),
 * `invoicePayment.aggregate` (paid on the day's own sales) and `return.findMany` (a day's few returns). No per-row call.
 * Rows and summary are two reads, not one transaction: a sale rung between them can show in one and not the other
 * until the next refetch (accepted; the web refetches both together).
 */
@Injectable()
export class CounterSaleTodayService {
  constructor(private readonly prisma: PrismaService) {}

  async today(query: CounterSaleTodayDto, now: Date = new Date()): Promise<TodaysSalesResponse> {
    const tenantId = this.prisma.getTenantId();
    // forTenant() is UNSCOPED without a tenant: refuse, like the by-key read.
    if (!tenantId) throw new ForbiddenException("Today's sales needs a tenant-scoped session");

    // SA-738r: the one resolver; the zone is resolved once per request and passed down.
    const { zone } = await resolveZone(this.prisma, { tenantId });
    const today = calendarDateFromIso(startOfCalendarDay(now, zone));
    const day = query.day ?? today;
    if (!parseCalendarDay(day)) throw badDay("day must be a real calendar day (YYYY-MM-DD)");
    // YYYY-MM-DD strings order the same as the days they name.
    if (day > today) throw badDay("day cannot be after today");

    const nextDay = calendarDateFromIso(addCalendarDays(new Date(isoFromCalendarDate(day)), 1));
    const window = { start: startOfLocalDay(day, zone), end: startOfLocalDay(nextDay, zone) };

    const page = query.page ?? 1;
    const limit = query.limit ?? TODAYS_SALES_DEFAULT_LIMIT;
    const db = this.prisma.forTenant();

    const [rows, total, summary] = await Promise.all([
      db.order.findMany(pageQuery(tenantId, window, page, limit)) as Promise<TodayOrderRecord[]>,
      db.order.count({ where: counterSalesWhere(tenantId, window) }),
      page === 1 ? this.summary(db, tenantId, window) : Promise.resolve(null),
    ]);

    return {
      data: rows.map(toTodaysSaleRow),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        day,
        timezone: zone,
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
      },
      summary,
    };
  }

  /**
   * The whole day, four queries (never per-row), folded in counter-sale-today.ts: the day's sales (aggregate), the
   * money that CAME IN in the window by method (groupBy on `paidAt`, sales of any day), what is paid on the day's own
   * sales (aggregate, for `onAccount`), and the returns counted in the window (a day's few returns are read whole so
   * the per-return amount rule applies; a grouped sum cannot).
   */
  private async summary(
    db: ReturnType<PrismaService["forTenant"]>,
    tenantId: string,
    window: { start: Date; end: Date },
  ) {
    const [sales, payments, paidOnSales, returns] = await Promise.all([
      db.order.aggregate({
        where: liveCounterSalesWhere(tenantId, window),
        _count: { _all: true },
        _sum: { total: true },
      }),
      db.invoicePayment.groupBy({
        by: ["method"],
        where: salePaymentsWhere(tenantId, window),
        _sum: { amount: true },
      }),
      db.invoicePayment.aggregate({
        where: paidOnDaysSalesWhere(tenantId, window),
        _sum: { amount: true },
      }),
      db.return.findMany({
        where: windowReturnsWhere(tenantId, window),
        select: {
          refundMethod: true,
          refundAmount: true,
          creditSubtotal: true,
          creditTax: true,
          creditCategoryTax: true,
        },
      }),
    ]);
    return foldSummary({ sales, payments, paidOnSales, returns });
  }
}

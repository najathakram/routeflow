import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { calendarDateFromIso, startOfCalendarDay } from "../common/calendar-date";

/**
 * #2118 (plan A1) — the ONE sales-fact reader: invoiced lines on the accrual basis
 * (`ACCRUAL_REVENUE_STATUSES`), credit notes and external refunds on their own dates, all
 * through the shared predicates in `common/invoiced-sales.ts` and composed with its `netOf`.
 * Product (and, next, customer) insights shape what this reads; they never query around it.
 *
 * Reads go THROUGH `Invoice` with an explicit `tenantId` in every where-clause: invoice lines
 * are nested writes, so legacy lines can carry `InvoiceItem.tenantId = null` (the trap
 * `invoiced-sales.ts` documents), and a null ambient tenant must fail closed, never sum
 * across tenants (B440 finding 2).
 */
@Injectable()
export class SalesFactsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The request's tenant; refuses a tenant-less (SUPER_ADMIN) context instead of reading unscoped. */
  requireTenantId(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  /**
   * The tenant's configured IANA zone, or null (no `TenantConfig` row) — the calendar helpers
   * then fall back to UTC, never to a guessed zone (the analytics convention).
   */
  async tenantTimezone(tenantId: string): Promise<string | null> {
    const cfg = await this.prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { timezone: true },
    });
    return cfg?.timezone ?? null;
  }

  /** Today's calendar day ("YYYY-MM-DD") in `timeZone` (UTC when null). */
  today(timeZone: string | null, now: Date = new Date()): string {
    return calendarDateFromIso(startOfCalendarDay(now, timeZone));
  }
}

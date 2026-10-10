import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  DAY_CLOSE_NOTES_MAX,
  roundMoney,
  sumDenominations,
  dayCloseWindowIsEmpty,
  validOpeningFloat,
  validateDenominations,
  type DayCloseSnapshot,
  type DayCloseState,
  type DayCloseTotals,
  type DenominationCount,
} from "@routeflow/pricing";
import type { JwtPayload } from "../../../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../../../common/api-error-codes";
import {
  calendarDateFromIso,
  calendarDayBounds,
  isoFromCalendarDate,
  startOfCalendarDay,
} from "../../../common/calendar-date";
import { tenantTimeZone } from "../../../common/tenant-time-zone";
import { EmailService } from "../../../email/email.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { AdminAuditAction } from "../../../platform-admin/audit-actions.constant";
import { dbClockNow } from "../../../returns/counter-close-lock";
import { counterSaleGate } from "../capability-shape";
import {
  FULFILMENT_CAPABILITY_READER,
  type FulfilmentCapabilityReader,
} from "../fulfilment-capability-reader";
import { effectiveZone } from "../counter-sale-today.service";
import type { DayCloseDto } from "./day-close.dto";
import { countSalesSince, readWindowFacts } from "./day-close-facts";
import { expectedCashOf, foldDayClose } from "./day-close-fold";
import { isLockTimeout, isUniqueViolation, lockCounterCloseExclusive } from "./day-close-lock";
import { parseRegisterKey } from "./day-close-register";
import { buildZReportEmail } from "./z-report-email";

/** The `BillingNotificationLog.milestone` of a Z report send claim. */
export const Z_REPORT_MILESTONE = "ZREPORT";
/** The `EmailDelivery.entityType` of a Z report. */
export const Z_REPORT_ENTITY = "CounterDayClose";

/** The stored close with its closer's name, as every read here selects it. */
interface CloseRow {
  id: string;
  tenantId: string;
  registerKey: string;
  day: Date;
  zone: string;
  windowStart: Date;
  windowEnd: Date;
  closedAt: Date;
  closedById: string | null;
  openingFloat: unknown;
  expectedCash: unknown;
  countedCash: unknown;
  variance: unknown;
  denominations: unknown;
  totals: unknown;
  notes: string | null;
  reopenedAt: Date | null;
  reopenedById: string | null;
  closedBy?: { username: string | null } | null;
}

const WITH_CLOSER = { closedBy: { select: { username: true } } } as const;
const LATEST_FIRST = [{ windowEnd: "desc" }, { id: "desc" }] as const;

const dayAlreadyClosed = () =>
  new ConflictException({
    code: API_ERROR_CODES.DAY_ALREADY_CLOSED,
    message: "This day has already been closed.",
  });

/** The key one Z report send is claimed under: a re-close has a new `closedAt`, so it sends a corrected report. */
export const zReportKey = (row: { id: string; closedAt: Date }) =>
  `${row.id}:${row.closedAt.toISOString()}`;

/**
 * Counter DAY CLOSE + Z REPORT (SA-750r3). One window per (tenant, register), running close to close; the close stores a snapshot
 * of the drawer count, the expected cash, the variance and a summary of the window's money (never rows, never customer names).
 *
 * The close transaction takes the EXCLUSIVE counter-close lock and reads its cutoff from the database clock AFTER the grant, so
 * every tender / pickup / refund / void in flight (they hold the SHARED form) is in exactly one window. It takes no other
 * advisory lock and no FOR UPDATE. The server recomputes every figure: a client `counted` / `expected` is never read.
 *
 * The Z report goes out AFTER the commit and can never fail the close.
 */
@Injectable()
export class CounterDayCloseService {
  private readonly logger = new Logger(CounterDayCloseService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FULFILMENT_CAPABILITY_READER) private readonly capability: FulfilmentCapabilityReader,
    private readonly email: EmailService,
  ) {}

  // ─── Guards ─────────────────────────────────────────────────────────────────────────────────────

  /** The tenant of the session; forTenant() is UNSCOPED without one, so a session with none is refused. */
  private tenantId(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new ForbiddenException("Day close needs a tenant-scoped session");
    return tenantId;
  }

  /** A tenant with counter sales off has no till to close. */
  private async assertCounterOn(tenantId: string): Promise<void> {
    const cap = await this.capability.get(tenantId);
    if (!counterSaleGate(cap)) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.COUNTER_SALES_DISABLED,
        message: "Counter sales are not turned on for this business.",
      });
    }
  }

  private async zoneOf(): Promise<string> {
    return effectiveZone(await tenantTimeZone(this.prisma));
  }

  /** The latest close of (tenant, register): windows chain, so it is the one with the greatest `windowEnd`. */
  private latest(db: any, tenantId: string, registerKey: string): Promise<CloseRow | null> {
    return db.counterDayClose.findFirst({
      where: { tenantId, registerKey },
      orderBy: [...LATEST_FIRST],
      include: WITH_CLOSER,
    });
  }

  // ─── Snapshot ───────────────────────────────────────────────────────────────────────────────────

  /** The stored row as the contract's snapshot (no report state: `reportSent` is the caller's to set). */
  private mapRow(row: CloseRow): DayCloseSnapshot {
    return {
      id: row.id,
      registerKey: row.registerKey,
      day: calendarDateFromIso(row.day),
      zone: row.zone,
      windowStart: row.windowStart.toISOString(),
      windowEnd: row.windowEnd.toISOString(),
      closedAt: row.closedAt.toISOString(),
      closedById: row.closedById,
      closedByName: row.closedBy?.username ?? null,
      openingFloat: Number(row.openingFloat),
      expectedCash: Number(row.expectedCash),
      countedCash: Number(row.countedCash),
      variance: Number(row.variance),
      denominations: Array.isArray(row.denominations)
        ? (row.denominations as DenominationCount[])
        : [],
      totals: row.totals as DayCloseTotals,
      notes: row.notes,
      reopenedAt: row.reopenedAt ? row.reopenedAt.toISOString() : null,
      reopenedById: row.reopenedById,
      reportSent: null,
    };
  }

  /**
   * `reportSent` has no column; it is derived from what the send leaves behind, for THIS `closedAt` (a re-close starts over):
   * the send claim exists -> true (it went to the admins); no claim but a FAILED delivery row since the close -> false
   * ("Report not sent - Resend"); neither (no admin to send to, or never attempted) -> null.
   */
  private async reportState(row: CloseRow): Promise<boolean | null> {
    const db = this.prisma.forTenant();
    const claim = await db.billingNotificationLog.findFirst({
      where: { tenantId: row.tenantId, milestone: Z_REPORT_MILESTONE, key: zReportKey(row) },
      select: { id: true },
    });
    if (claim) return true;
    const attempt = await db.emailDelivery.findFirst({
      where: {
        tenantId: row.tenantId,
        kind: "Z_REPORT",
        entityType: Z_REPORT_ENTITY,
        entityId: row.id,
        createdAt: { gte: row.closedAt },
      },
      select: { id: true },
    });
    return attempt ? false : null;
  }

  private async snapshotOf(row: CloseRow, reportSent?: boolean | null): Promise<DayCloseSnapshot> {
    return {
      ...this.mapRow(row),
      reportSent: reportSent === undefined ? await this.reportState(row) : reportSent,
    };
  }

  // ─── GET ────────────────────────────────────────────────────────────────────────────────────────

  /** GET .../day-close/latest: the latest close of the register (windowEnd is its `closedThrough`), or 404 when it has none. */
  async latestClose(rawRegisterKey?: string): Promise<DayCloseSnapshot> {
    const tenantId = this.tenantId();
    await this.assertCounterOn(tenantId);
    const registerKey = parseRegisterKey(rawRegisterKey);
    const row = await this.latest(this.prisma.forTenant(), tenantId, registerKey);
    if (!row) throw new NotFoundException("No close yet");
    return this.snapshotOf(row);
  }

  /** GET .../day-close/:id: one past close (404 for an unknown id or another tenant's). */
  async closeById(id: string): Promise<DayCloseSnapshot> {
    const tenantId = this.tenantId();
    await this.assertCounterOn(tenantId);
    const row = await this.prisma.forTenant().counterDayClose.findFirst({
      where: { id, tenantId },
      include: WITH_CLOSER,
    });
    if (!row) throw new NotFoundException("Close not found");
    return this.snapshotOf(row);
  }

  async state(rawRegisterKey?: string, now: Date = new Date()): Promise<DayCloseState> {
    const tenantId = this.tenantId();
    await this.assertCounterOn(tenantId);
    const registerKey = parseRegisterKey(rawRegisterKey);
    const zone = await this.zoneOf();
    const db = this.prisma.forTenant();

    const last = await this.latest(db, tenantId, registerKey);
    // A reopened close previews its STORED window (the re-close never moves the cutoff); otherwise the next window opens where
    // the last one ended (the first, at the start of the tenant-zone day).
    const reopened = last != null && last.reopenedAt != null;
    const window = reopened
      ? { start: last.windowStart, end: last.windowEnd }
      : { start: last ? last.windowEnd : calendarDayBounds(zone, now).start, end: now };
    const facts = await readWindowFacts(db, tenantId, registerKey, window);
    const fold = foldDayClose(facts);
    const salesSince = last
      ? await countSalesSince(
          db,
          tenantId,
          registerKey,
          last.windowEnd,
          new Date(now.getTime() + 1),
        )
      : 0;

    return {
      registerKey,
      zone,
      lastClose: last ? await this.snapshotOf(last) : null,
      salesSince,
      preview: {
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
        suggestedOpeningFloat: last ? Number(last.openingFloat) : 0,
        tillCash: fold.tillCash,
        cashRefunds: fold.cashRefunds,
        totals: fold.totals,
      },
    };
  }

  // ─── POST (close / re-close) ────────────────────────────────────────────────────────────────────

  async close(dto: DayCloseDto, user: JwtPayload): Promise<DayCloseSnapshot> {
    const tenantId = this.tenantId();
    await this.assertCounterOn(tenantId);
    const registerKey = parseRegisterKey(dto.registerKey);
    // The server owns every figure: only the float, the counted rows and the note are read from the request.
    const denominations = validateDenominations(dto.denominations);
    if (denominations === null) {
      throw new BadRequestException(
        "denominations must list each bill or coin once with a whole count of 0 to 100000",
      );
    }
    if (!validOpeningFloat(dto.openingFloat)) {
      throw new BadRequestException("openingFloat must be a whole-cents amount of 0 or more");
    }
    const notes = this.cleanNotes(dto.notes);
    const zone = await this.zoneOf();

    let row: CloseRow;
    try {
      row = await this.prisma.tenantTransaction(
        (tx: any) =>
          this.closeInTx(tx, {
            tenantId,
            registerKey,
            zone,
            user,
            openingFloat: dto.openingFloat,
            denominations,
            notes,
          }),
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw dayAlreadyClosed();
      if (isLockTimeout(e)) throw this.busy();
      throw e;
    }

    // After the commit: a send failure never fails the close.
    const reportSent = await this.sendReport(row, { manual: false });
    return this.snapshotOf(row, reportSent);
  }

  private cleanNotes(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") throw new BadRequestException("notes must be text");
    const trimmed = raw.trim();
    if (trimmed.length > DAY_CLOSE_NOTES_MAX) {
      throw new BadRequestException(`notes can be at most ${DAY_CLOSE_NOTES_MAX} characters`);
    }
    return trimmed === "" ? null : trimmed;
  }

  private busy() {
    return new ServiceUnavailableException(
      "A sale is still being recorded at this till. Try the close again in a moment.",
    );
  }

  private async closeInTx(
    tx: any,
    a: {
      tenantId: string;
      registerKey: string;
      zone: string;
      user: JwtPayload;
      openingFloat: number;
      denominations: DenominationCount[];
      notes: string | null;
    },
  ): Promise<CloseRow> {
    const { tenantId, registerKey } = a;
    await lockCounterCloseExclusive(tx, tenantId, registerKey);
    // The cutoff is read AFTER the lock is granted: every shared-lock writer in flight has committed, and none can start.
    const cutoff = await dbClockNow(tx);
    const last = await this.latest(tx, tenantId, registerKey);
    const counted = sumDenominations(a.denominations);
    const denominationsJson = a.denominations as unknown as Prisma.InputJsonValue;

    // RE-CLOSE: the latest close was reopened. Same row, same stored window; only the count, the note and what follows from them
    // change (the float stays: it is what the window opened with).
    if (last && last.reopenedAt != null) {
      const window = { start: last.windowStart, end: last.windowEnd };
      const fold = foldDayClose(await readWindowFacts(tx, tenantId, registerKey, window));
      const expected = expectedCashOf(Number(last.openingFloat), fold);
      const res = await tx.counterDayClose.updateMany({
        where: { id: last.id, tenantId, reopenedAt: { not: null } },
        data: {
          countedCash: counted,
          expectedCash: expected,
          variance: roundMoney(counted - expected),
          denominations: denominationsJson,
          totals: fold.totals as unknown as Prisma.InputJsonValue,
          notes: a.notes,
          closedAt: cutoff,
          reopenedAt: null,
        },
      });
      if (res.count !== 1) throw dayAlreadyClosed();
      const fresh = await this.latest(tx, tenantId, registerKey);
      if (!fresh) throw dayAlreadyClosed();
      return fresh;
    }

    // A NEW window. The day label is not a key: a second close of the same tenant-zone day is a second window, but only when
    // something happened since the standing close (a double-click, or a close with nothing new to count, is refused).
    const day = calendarDateFromIso(startOfCalendarDay(cutoff, a.zone));
    const windowStart = last ? last.windowEnd : calendarDayBounds(a.zone, cutoff).start;
    const fold = foldDayClose(
      await readWindowFacts(tx, tenantId, registerKey, { start: windowStart, end: cutoff }),
    );
    if (last && calendarDateFromIso(last.day) === day && dayCloseWindowIsEmpty(fold.totals)) {
      throw dayAlreadyClosed();
    }
    const expected = expectedCashOf(a.openingFloat, fold);
    return tx.counterDayClose.create({
      data: {
        tenantId,
        registerKey,
        day: new Date(isoFromCalendarDate(day)),
        zone: a.zone,
        windowStart,
        windowEnd: cutoff,
        closedAt: cutoff,
        closedById: a.user.sub,
        openingFloat: a.openingFloat,
        expectedCash: expected,
        countedCash: counted,
        variance: roundMoney(counted - expected),
        denominations: denominationsJson,
        totals: fold.totals as unknown as Prisma.InputJsonValue,
        notes: a.notes,
      },
      include: WITH_CLOSER,
    });
  }

  // ─── POST :id/reopen ────────────────────────────────────────────────────────────────────────────

  async reopen(id: string, user: JwtPayload): Promise<DayCloseSnapshot> {
    const tenantId = this.tenantId();
    await this.assertCounterOn(tenantId);
    const found = await this.prisma.forTenant().counterDayClose.findFirst({
      where: { id, tenantId },
      select: { registerKey: true },
    });
    if (!found) throw new NotFoundException("Close not found");

    let row: CloseRow;
    try {
      row = await this.prisma.tenantTransaction(
        async (tx: any) => {
          // The same exclusive lock as a close: a close and a reopen of one till never interleave.
          await lockCounterCloseExclusive(tx, tenantId, found.registerKey);
          const cur = await tx.counterDayClose.findFirst({
            where: { id, tenantId },
            include: WITH_CLOSER,
          });
          if (!cur) throw new NotFoundException("Close not found");
          const latest = await this.latest(tx, tenantId, cur.registerKey);
          if (!latest || latest.id !== cur.id) {
            throw new ConflictException("Only the latest close of a till can be reopened.");
          }
          if (cur.reopenedAt != null)
            throw new ConflictException("This close is already reopened.");
          const at = await dbClockNow(tx);
          const res = await tx.counterDayClose.updateMany({
            where: { id, tenantId, reopenedAt: null },
            data: { reopenedAt: at, reopenedById: user.sub },
          });
          if (res.count !== 1) throw new ConflictException("This close is already reopened.");
          // AWAITED in this transaction (not AuditService, which swallows a write error): the old snapshot is kept exactly when
          // the reopen is.
          await tx.auditLog.create({
            data: {
              tenantId,
              userId: user.sub,
              action: AdminAuditAction.COUNTER_DAY_CLOSE_REOPENED,
              entityType: Z_REPORT_ENTITY,
              entityId: id,
              meta: {
                registerKey: cur.registerKey,
                snapshot: this.mapRow(cur),
              } as unknown as Prisma.InputJsonValue,
            },
          });
          const fresh = await this.latest(tx, tenantId, cur.registerKey);
          if (!fresh) throw new NotFoundException("Close not found");
          return fresh;
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (e) {
      if (isLockTimeout(e)) throw this.busy();
      throw e;
    }
    return this.snapshotOf(row);
  }

  // ─── POST :id/report ────────────────────────────────────────────────────────────────────────────

  async resendReport(id: string): Promise<DayCloseSnapshot> {
    const tenantId = this.tenantId();
    await this.assertCounterOn(tenantId);
    const row = (await this.prisma.forTenant().counterDayClose.findFirst({
      where: { id, tenantId },
      include: WITH_CLOSER,
    })) as CloseRow | null;
    if (!row) throw new NotFoundException("Close not found");
    // A reopened close has no standing figures to report; the re-close sends the corrected one.
    if (row.reopenedAt != null) {
      throw new ConflictException(
        "This close is reopened. Close the day again to send the report.",
      );
    }
    const reportSent = await this.sendReport(row, { manual: true });
    return this.snapshotOf(row, reportSent);
  }

  // ─── The Z report ───────────────────────────────────────────────────────────────────────────────

  /**
   * Sends the Z report to every ACTIVE TENANT_ADMIN of the tenant. Never throws: true = it went to at least one admin, false = it did
   * not go (the claim is released so a resend can), null = nobody to send to.
   *
   * Idempotent through a BillingNotificationLog claim (milestone ZREPORT, key `<closeId>:<closedAt>`): an automatic send that finds the
   * claim taken does nothing (it was sent, or is being sent). A MANUAL resend deletes its own key's claim first and re-claims, so the
   * admin's "Resend" always sends once more; two resends racing still claim once.
   */
  async sendReport(row: CloseRow, opts: { manual: boolean }): Promise<boolean | null> {
    const tenantId = row.tenantId;
    const key = zReportKey(row);
    const db = this.prisma.forTenant();
    try {
      const admins = await db.user.findMany({
        where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
        select: { email: true },
        orderBy: { createdAt: "asc" },
      });
      const to = [...new Set(admins.map((a) => a.email).filter((e): e is string => !!e))];
      if (to.length === 0) return null;

      if (opts.manual) await this.release(tenantId, key);
      const claimed = await this.claim(tenantId, key);
      // A taken claim means another sender has it (nothing to do); a claim that could not be written means nothing was sent.
      if (claimed === "taken") return true;
      if (claimed === "error") return false;

      let delivered = 0;
      try {
        const tenant = await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { name: true },
        });
        const snapshot = this.mapRow(row);
        const mail = buildZReportEmail({
          businessName: tenant?.name ?? "Your business",
          snapshot,
        });
        for (const address of to) {
          const result = await this.email.send({
            to: address,
            // subject, html, text: built and escaped in z-report-email.ts (which the html-interpolation guard scans)
            ...mail,
            delivery: {
              tenantId,
              kind: "Z_REPORT",
              entityType: Z_REPORT_ENTITY,
              entityId: row.id,
            },
          });
          if (result.delivered) delivered += 1;
        }
      } catch (e) {
        this.logger.error(`Z report send failed for close ${row.id}: ${(e as Error)?.message}`);
      }
      if (delivered === 0) {
        await this.release(tenantId, key);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.error(`Z report failed for close ${row.id}: ${(e as Error)?.message}`);
      return false;
    }
  }

  /** "won" for the caller that takes the claim, "taken" when it already exists (P2002), "error" for any other failure. */
  private async claim(tenantId: string, key: string): Promise<"won" | "taken" | "error"> {
    try {
      await this.prisma.forTenant().billingNotificationLog.create({
        data: { tenantId, milestone: Z_REPORT_MILESTONE, key },
      });
      return "won";
    } catch (e) {
      if (isUniqueViolation(e)) return "taken";
      this.logger.error(`Z report claim failed for ${key}: ${(e as Error)?.message}`);
      return "error";
    }
  }

  /** Releases the claim so a failed send can be retried; a release that itself fails is logged ("at most twice", never zero). */
  private async release(tenantId: string, key: string): Promise<void> {
    try {
      await this.prisma.forTenant().billingNotificationLog.deleteMany({
        where: { tenantId, milestone: Z_REPORT_MILESTONE, key },
      });
    } catch (e) {
      this.logger.error(`Z report release failed for ${key}: ${(e as Error)?.message}`);
    }
  }
}

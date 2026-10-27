import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  roundMoney,
  sumDenominations,
  validOpeningFloat,
  validateDenominations,
} from "@routeflow/pricing";
import type {
  CounterDrawerEventView,
  DenominationCount,
  OpeningFloatState,
  RecordOpeningFloatResult,
} from "@routeflow/types";
import type { JwtPayload } from "../../../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../../../common/api-error-codes";
import { calendarDayBounds } from "../../../common/calendar-date";
import { tenantTimeZone } from "../../../common/tenant-time-zone";
import { PrismaService } from "../../../prisma/prisma.service";
import { AdminAuditAction } from "../../../platform-admin/audit-actions.constant";
import { counterSaleGate } from "../capability-shape";
import { effectiveZone } from "../counter-sale-today.service";
import {
  FULFILMENT_CAPABILITY_READER,
  type FulfilmentCapabilityReader,
} from "../fulfilment-capability-reader";
import { lockCounterClose } from "../../../returns/counter-close-lock";
import { isLockTimeout, isUniqueViolation } from "../day-close/day-close-lock";
import { parseRegisterKey } from "../day-close/day-close-register";
import type { CorrectOpeningFloatDto, RecordOpeningFloatDto } from "./counter-drawer.dto";

export const DRAWER_EVENT_ENTITY = "CounterDrawerEvent";
const OPENING_FLOAT = "OPENING_FLOAT" as const;
/** A window can start no later than now; this much clock skew between till and server is tolerated. */
const FUTURE_SKEW_MS = 5 * 60_000;
const REASON_MIN = 5;
const REASON_MAX = 500;

/** The slice of the tenant-scoped client this service uses (the day-close service types it the same loose way). */
interface DrawerDb {
  $executeRaw(strings: TemplateStringsArray, ...values: any[]): Promise<unknown>;
  counterDrawerEvent: {
    findFirst(args: unknown): Promise<EventRow | null>;
    create(args: unknown): Promise<EventRow>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  counterDayClose: {
    findFirst(
      args: unknown,
    ): Promise<{ windowStart: Date; windowEnd: Date; reopenedAt: Date | null } | null>;
  };
  user: { findFirst(args: unknown): Promise<{ username: string } | null> };
  auditLog: { create(args: unknown): Promise<unknown> };
}

interface EventRow {
  id: string;
  tenantId: string;
  registerKey: string;
  windowStart: Date;
  kind: typeof OPENING_FLOAT;
  amount: unknown;
  denominations: unknown;
  at: Date;
  byId: string;
  reason: string | null;
}

/**
 * Counter DRAWER events (W-819 part 1). One OPENING_FLOAT per (tenant, register, window); the count is locked once written.
 * Record: any till staff; an identical amount replays the existing row, a different one is 409 COUNTER_FLOAT_ALREADY_COUNTED.
 * Correct: admin only (the controller), a reason, and the audit row is written in the SAME transaction as the update (L-301).
 * A write (record or correction) runs in a transaction that takes the SHARED day-close lock first (SA-1019, the same key the
 * tender and the refunds take), so a close in flight is waited for and the window is re-read after it: a float is never written
 * into, or corrected in, a window a close already sealed. After a close the day must be reopened before a correction.
 * Tenant and user always come from the session / JWT, never the body. Nothing here moves money; the fold reads it in part 2.
 */
@Injectable()
export class CounterDrawerService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FULFILMENT_CAPABILITY_READER) private readonly capability: FulfilmentCapabilityReader,
  ) {}

  private tenantId(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new ForbiddenException("The drawer needs a tenant-scoped session");
    return tenantId;
  }

  /**
   * The start of the register's OPEN window, derived exactly as DayCloseService.state() does: the latest close's windowEnd (a
   * reopened close previews its stored windowStart), else the start of the tenant-zone day. The client's windowStart must equal it.
   */
  private async openWindowStart(
    db: DrawerDb,
    tenantId: string,
    registerKey: string,
    now: Date,
  ): Promise<Date> {
    const last = await db.counterDayClose.findFirst({
      where: { tenantId, registerKey },
      orderBy: [{ windowEnd: "desc" }, { id: "desc" }],
    });
    if (last) return last.reopenedAt != null ? last.windowStart : last.windowEnd;
    const zone = effectiveZone(await tenantTimeZone(this.prisma));
    return calendarDayBounds(zone, now).start;
  }

  /**
   * The window the write targets must still be the register's open one (re-read on the caller's transaction, after the close
   * lock). One predicate for record and correct (L-167); a window a close covers is final until the day is reopened.
   */
  private async assertFloatWindowOpen(
    tx: DrawerDb,
    tenantId: string,
    registerKey: string,
    windowStart: Date,
  ): Promise<void> {
    const open = await this.openWindowStart(tx, tenantId, registerKey, new Date());
    if (open.getTime() !== windowStart.getTime()) {
      throw new ConflictException({
        code: API_ERROR_CODES.COUNTER_FLOAT_WINDOW_NOT_OPEN,
        message:
          "That drawer window is not the open one. Reload the day-close screen and try again.",
      });
    }
  }

  /**
   * The first statement of a drawer write: a bounded wait (the close holds the lock exclusively while it runs), then the SHARED
   * close lock, so writes never serialize with each other, only with a close.
   */
  private async lockClose(tx: DrawerDb, tenantId: string, registerKey: string): Promise<void> {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await lockCounterClose(tx, tenantId, registerKey);
  }

  private busy(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      "The day is being closed at this till. Try again in a moment.",
    );
  }

  private async assertCounterOn(tenantId: string): Promise<void> {
    if (!counterSaleGate(await this.capability.get(tenantId))) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.COUNTER_SALES_DISABLED,
        message: "Counter sales are not turned on for this business.",
      });
    }
  }

  private parseWindowStart(raw: string, now = new Date()): Date {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException("windowStart must be an ISO date-time");
    }
    if (d.getTime() > now.getTime() + FUTURE_SKEW_MS) {
      throw new BadRequestException("windowStart cannot be in the future");
    }
    return d;
  }

  /** The amount in whole cents; when a breakdown is sent its sum must equal it. Returns the normalised breakdown or null. */
  private checkAmount(
    amount: unknown,
    denominations: unknown,
  ): { amount: number; rows: DenominationCount[] | null } {
    if (!validOpeningFloat(amount)) {
      throw new BadRequestException("amount must be a whole-cents amount of 0 or more");
    }
    const cents = roundMoney(amount);
    if (denominations === undefined || denominations === null) return { amount: cents, rows: null };
    const rows = validateDenominations(denominations);
    if (rows === null) throw new BadRequestException("denominations are not valid");
    if (sumDenominations(rows) !== cents) {
      throw new BadRequestException("denominations must add up to the amount");
    }
    return { amount: cents, rows: rows as DenominationCount[] };
  }

  private async view(
    db: DrawerDb,
    tenantId: string,
    row: EventRow,
  ): Promise<CounterDrawerEventView> {
    const user = await db.user.findFirst({
      where: { id: row.byId, tenantId },
      select: { username: true },
    });
    return {
      id: row.id,
      registerKey: row.registerKey,
      windowStart: row.windowStart.toISOString(),
      kind: row.kind,
      amount: Number(row.amount),
      denominations: (row.denominations as DenominationCount[] | null) ?? null,
      at: row.at.toISOString(),
      byId: row.byId,
      byName: user?.username ?? null,
      reason: row.reason,
    };
  }

  private find(
    db: DrawerDb,
    tenantId: string,
    registerKey: string,
    windowStart: Date,
  ): Promise<EventRow | null> {
    return db.counterDrawerEvent.findFirst({
      where: { tenantId, registerKey, windowStart, kind: OPENING_FLOAT },
    });
  }

  // GET

  async read(
    rawRegisterKey: string | undefined,
    rawWindowStart: string,
  ): Promise<OpeningFloatState> {
    const tenantId = this.tenantId();
    await this.assertCounterOn(tenantId);
    const registerKey = parseRegisterKey(rawRegisterKey);
    const windowStart = this.parseWindowStart(rawWindowStart);
    const db = this.prisma.forTenant();
    const row = await this.find(db, tenantId, registerKey, windowStart);
    return {
      registerKey,
      windowStart: windowStart.toISOString(),
      event: row ? await this.view(db, tenantId, row) : null,
    };
  }

  // POST (record)

  async record(dto: RecordOpeningFloatDto, user: JwtPayload): Promise<RecordOpeningFloatResult> {
    const tenantId = this.tenantId();
    await this.assertCounterOn(tenantId);
    const registerKey = parseRegisterKey(dto.registerKey);
    const windowStart = this.parseWindowStart(dto.windowStart);
    const { amount, rows } = this.checkAmount(dto.amount, dto.denominations);
    const db = this.prisma.forTenant();

    try {
      return await this.prisma.tenantTransaction(
        async (tx: DrawerDb) => {
          await this.lockClose(tx, tenantId, registerKey);
          // A replay is a read: it stays allowed after a close. Only a NEW row needs the window to be the open one (window+1ms
          // would dodge the unique key, and a window a close covers is final).
          const existing = await this.find(tx, tenantId, registerKey, windowStart);
          if (existing) return this.replay(tx, tenantId, existing, amount);
          await this.assertFloatWindowOpen(tx, tenantId, registerKey, windowStart);
          const created = await tx.counterDrawerEvent.create({
            data: {
              tenantId,
              registerKey,
              windowStart,
              kind: OPENING_FLOAT,
              amount,
              denominations: (rows ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
              byId: user.sub,
            },
          });
          return { event: await this.view(tx, tenantId, created), created: true };
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (e) {
      if (isLockTimeout(e)) throw this.busy();
      if (!isUniqueViolation(e)) throw e;
      // Lost the race with another till (a failed insert aborts its transaction, so this read is outside it): the winner's row
      // decides (same amount replays, a different one is refused).
      const winner = await this.find(db, tenantId, registerKey, windowStart);
      if (!winner) throw e;
      return this.replay(db, tenantId, winner, amount);
    }
  }

  private async replay(
    db: DrawerDb,
    tenantId: string,
    row: EventRow,
    amount: number,
  ): Promise<RecordOpeningFloatResult> {
    if (roundMoney(Number(row.amount)) !== amount) {
      throw new ConflictException({
        code: API_ERROR_CODES.COUNTER_FLOAT_ALREADY_COUNTED,
        message: "This drawer was already counted for this window. Ask an admin to correct it.",
      });
    }
    return { event: await this.view(db, tenantId, row), created: false };
  }

  // PATCH (admin correction)

  private changed(): ConflictException {
    return new ConflictException({
      code: API_ERROR_CODES.COUNTER_FLOAT_CHANGED,
      message:
        "The opening float changed since you loaded it. Reload to see the current figure, then correct it again.",
    });
  }

  async correct(dto: CorrectOpeningFloatDto, user: JwtPayload): Promise<CounterDrawerEventView> {
    const tenantId = this.tenantId();
    await this.assertCounterOn(tenantId);
    const registerKey = parseRegisterKey(dto.registerKey);
    const windowStart = this.parseWindowStart(dto.windowStart);
    const { amount, rows } = this.checkAmount(dto.amount, dto.denominations);
    if (!validOpeningFloat(dto.expectedAmount)) {
      throw new BadRequestException("expectedAmount must be a whole-cents amount of 0 or more");
    }
    const expectedAmount = roundMoney(dto.expectedAmount);
    const reason = (dto.reason ?? "").trim();
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      throw new BadRequestException("reason is required: 5 to 500 characters");
    }

    try {
      return await this.prisma.tenantTransaction(
        async (tx: DrawerDb) => {
          await this.lockClose(tx, tenantId, registerKey);
          const cur = await this.find(tx, tenantId, registerKey, windowStart);
          if (!cur) {
            throw new NotFoundException({
              code: API_ERROR_CODES.COUNTER_FLOAT_NOT_COUNTED,
              message: "No opening float was counted for this window.",
            });
          }
          // After the lock, so a close that just committed is seen: its window is final until the day is reopened.
          await this.assertFloatWindowOpen(tx, tenantId, registerKey, cur.windowStart);
          const from = roundMoney(Number(cur.amount));
          // The screen's figure must still be the stored one: a stale screen never overwrites a correction that already committed.
          if (from !== expectedAmount) throw this.changed();
          if (from === amount && rows === null) {
            throw new BadRequestException(
              "The corrected amount is the same as the counted one. Send a new breakdown to change only that.",
            );
          }
          // The same compare again as a CAS in the UPDATE (amount = expectedAmount): two admins racing between our read and our write
          // cannot both win, whichever read first.
          const res = await tx.counterDrawerEvent.updateMany({
            where: { id: cur.id, tenantId, amount: expectedAmount },
            data: {
              amount,
              denominations: rows === null ? null : (rows as unknown as Prisma.InputJsonValue),
              reason,
            },
          });
          if (res.count !== 1) throw this.changed();
          // AWAITED in this transaction (not AuditService, which swallows a write error): the correction exists exactly when
          // its audit row does.
          await tx.auditLog.create({
            data: {
              tenantId,
              userId: user.sub,
              action: AdminAuditAction.COUNTER_FLOAT_CORRECTED,
              entityType: DRAWER_EVENT_ENTITY,
              entityId: cur.id,
              meta: {
                registerKey,
                windowStart: windowStart.toISOString(),
                kind: OPENING_FLOAT,
                from,
                to: amount,
                reason,
              } as unknown as Prisma.InputJsonValue,
            },
          });
          const fresh = await this.find(tx, tenantId, registerKey, windowStart);
          if (!fresh) throw new NotFoundException("Opening float not found");
          return this.view(tx, tenantId, fresh);
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (e) {
      if (isLockTimeout(e)) throw this.busy();
      throw e;
    }
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BillingEventService } from "../billing/billing-event.service";
import { lockTenantForLedger } from "../billing/addon-ledger";
import { writeAdminNotice } from "../billing/manual-invoice-notice";
import { BILLING_EVENTS, BILLING_EVENT_LABELS } from "../billing/plan-catalog.constants";
import { latestYearlyPayment, type YearlyPaymentRecord } from "../billing/yearly-payment-record";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AdminAuditAction } from "./audit-actions.constant";
import { StaffRefundDto } from "./dto/staff-refund.dto";
import { checkRefundDate, refundDeadline, type RefundDateVerdict } from "./staff-refund-window";

/** The one neutral line every staff-refund notice carries (SA-1297 ruling 6): this action never touches the subscription. */
export const STAFF_REFUND_NOTICE_MESSAGE =
  "Recorded only; the subscription status here is unchanged until the provider's cancellation is processed.";

const OUT_OF_RANGE_MESSAGE = "Choose a refund date between the payment date and today.";
const WINDOW_PASSED_MESSAGE =
  "The refund date is more than 14 days after the yearly payment, so it can't be recorded as a staff refund.";
const NO_PAYMENT_MESSAGE = "This business has no yearly payment to refund.";
const ALREADY_RECORDED_MESSAGE = "A staff refund is already recorded for this payment.";

const TYPE = BILLING_EVENTS.STAFF_REFUND_RECORDED;

/** Either the request client or a transaction: the reads below run on both (the POST re-reads under its lock). */
type LedgerReadDb =
  | Pick<Prisma.TransactionClient, "billingEvent" | "user">
  | Pick<PrismaService, "billingEvent" | "user">;
type UserReadDb = Pick<Prisma.TransactionClient, "user"> | Pick<PrismaService, "user">;

/** The existing staff refund of a payment, as the refundable read and the 409 body carry it. */
export interface ExistingStaffRefund {
  createdAt: Date;
  providerRef: string | null;
  actorName: string | null;
  refundDate: string | null;
}

export interface RefundableView {
  payment: { invoiceId: string; amount: string; currency: string; paidAt: Date } | null;
  /** paidAt + 14 x 24h, null when there is no payment. */
  deadline: Date | null;
  refusal:
    | null
    | typeof API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT
    | typeof API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED;
  existing: ExistingStaffRefund | null;
}

export interface BillingEventView {
  id: string;
  type: string;
  /** From the partial BILLING_EVENT_LABELS; null for every type with no ruled label (the web shows the raw type). */
  label: string | null;
  createdAt: Date;
  actorName: string | null;
  payload: Prisma.JsonValue;
}

const BILLING_EVENTS_TAKE = 100;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * R-2 (SA-1297): the audited "Record staff refund". It records, in one BillingEvent (`refund.staff`, amountDelta ALWAYS
 * null), that staff refunded a tenant's latest yearly payment in the provider's dashboard. It moves no money, writes no
 * subscription or tenant state and reads no rollout flag.
 *
 *  - The figure is never typed: amount, currency and paidAt are COPIED from `latestYearlyPayment` (the only read of
 *    payments this file makes; it never re-reads or re-sorts them and never queries `invoice.yearly_paid` itself).
 *  - Dedupe is under ONE writer and the tenant row lock (L-301): the first statement of the transaction is
 *    `lockTenantForLedger`; the payment, the date and the existing row are all read AFTER it.
 *  - This is the ONLY emitter of BILLING_EVENTS.STAFF_REFUND_RECORDED, and its emit call passes `{ actorId, tx }` and no
 *    `amountDelta` (pinned by staff-refund.service.spec.ts, so a second writer or a delta fails the build).
 */
@Injectable()
export class StaffRefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventService,
  ) {}

  /** The read that drives the button. No lock: the POST re-proves everything under the lock. */
  async resolveRefundable(tenantId: string): Promise<RefundableView> {
    const payment = await latestYearlyPayment(this.prisma, tenantId);
    if (!payment) {
      return {
        payment: null,
        deadline: null,
        refusal: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT,
        existing: null,
      };
    }
    const existing = await this.findExisting(this.prisma, tenantId, payment.invoiceId);
    return {
      payment: {
        invoiceId: payment.invoiceId,
        amount: payment.amount,
        currency: payment.currency,
        paidAt: payment.paidAt,
      },
      deadline: refundDeadline(payment.paidAt),
      refusal: existing ? API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED : null,
      existing,
    };
  }

  /** Records the refund. Refusals: 404 no yearly payment, 400 date out of range, 409 window passed, 409 already recorded. */
  async record(tenantId: string, dto: StaffRefundDto, actorId: string) {
    // Fail fast on an unlocked read; every check below is repeated under the lock, where it counts (L-301).
    const early = await latestYearlyPayment(this.prisma, tenantId);
    if (!early) throw this.noPayment();
    this.refuseDate(checkRefundDate(early.paidAt, dto.refundDate, new Date()), early);

    return this.prisma.$transaction(async (tx) => {
      await lockTenantForLedger(tx, tenantId);
      const payment = await latestYearlyPayment(tx, tenantId);
      if (!payment) throw this.noPayment();
      this.refuseDate(checkRefundDate(payment.paidAt, dto.refundDate, new Date()), payment);

      const existing = await this.findExisting(tx, tenantId, payment.invoiceId);
      if (existing) {
        throw new ConflictException({
          code: API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED,
          message: ALREADY_RECORDED_MESSAGE,
          ...existing,
        });
      }

      const row = await this.events.emit(
        tenantId,
        BILLING_EVENTS.STAFF_REFUND_RECORDED,
        {
          invoiceId: payment.invoiceId,
          amount: payment.amount,
          currency: payment.currency,
          paidAt: payment.paidAt.toISOString(),
          refundDate: dto.refundDate,
          providerRef: dto.providerRef,
          refundedInFull: true,
          cancelledImmediately: true,
          ...(dto.note ? { note: dto.note } : {}),
        },
        { actorId, tx },
      );
      await writeAdminNotice(tx, {
        tenantId,
        actorId,
        action: AdminAuditAction.TENANT_STAFF_REFUND_RECORDED,
        message: STAFF_REFUND_NOTICE_MESSAGE,
        meta: {
          invoiceId: payment.invoiceId,
          providerRef: dto.providerRef,
          refundDate: dto.refundDate,
        },
      });
      return row;
    });
  }

  /** The tenant's billing events, newest first, labelled and with actor names joined here (the web keeps no map). */
  async listBillingEvents(tenantId: string): Promise<BillingEventView[]> {
    const rows = await this.prisma.billingEvent.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: BILLING_EVENTS_TAKE,
    });
    const names = await this.actorNames(
      this.prisma,
      rows.map((r) => r.actorId),
    );
    const labels: Readonly<Record<string, string | undefined>> = BILLING_EVENT_LABELS;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      label: labels[r.type] ?? null,
      createdAt: r.createdAt,
      actorName: r.actorId ? (names.get(r.actorId) ?? null) : null,
      payload: r.payload,
    }));
  }

  private noPayment(): NotFoundException {
    return new NotFoundException({
      code: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT,
      message: NO_PAYMENT_MESSAGE,
    });
  }

  private refuseDate(verdict: RefundDateVerdict, payment: YearlyPaymentRecord): void {
    if (verdict.ok) return;
    if (verdict.reason === "WINDOW_PASSED") {
      throw new ConflictException({
        code: API_ERROR_CODES.STAFF_REFUND_WINDOW_PASSED,
        message: WINDOW_PASSED_MESSAGE,
        deadline: refundDeadline(payment.paidAt),
      });
    }
    // Plain 400, no code: the web's min and max keep a person from reaching it; this is the backstop.
    throw new BadRequestException(OUT_OF_RANGE_MESSAGE);
  }

  /** The staff refund already recorded for this provider invoice of this tenant, or null. Read under the lock by `record`. */
  private async findExisting(
    db: LedgerReadDb,
    tenantId: string,
    invoiceId: string,
  ): Promise<ExistingStaffRefund | null> {
    const row = await db.billingEvent.findFirst({
      where: { tenantId, type: TYPE, payload: { path: ["invoiceId"], equals: invoiceId } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!row) return null;
    const payload = asRecord(row.payload);
    const names = await this.actorNames(db, [row.actorId]);
    return {
      createdAt: row.createdAt,
      providerRef: str(payload.providerRef),
      actorName: row.actorId ? (names.get(row.actorId) ?? null) : null,
      refundDate: str(payload.refundDate),
    };
  }

  private async actorNames(
    db: UserReadDb,
    ids: Array<string | null>,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const users = await db.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, username: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.username || u.email] as const));
  }
}

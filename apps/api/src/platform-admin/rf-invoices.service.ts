import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import type {
  RfInvoiceListQuery,
  RfInvoiceListResponse,
  RfInvoiceRow,
  RfInvoiceSummary,
  RfInvoiceView,
} from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { writeAdminNotice } from "../billing/manual-invoice-notice";
import { RfInvoiceBuilder } from "../billing/rf-invoice/rf-invoice-builder";
import {
  RF_INVOICE_CANDIDATE_WHERE,
  RfInvoiceIssuerService,
  isCandidate,
  isStale,
  type IssuerSubscription,
} from "../billing/rf-invoice/rf-invoice-issuer.service";
import {
  RF_INVOICE_LEAD_DAYS,
  rfInvoicingMode,
  type RfInvoiceStatus,
} from "../billing/rf-invoice/rf-invoice.constants";
import { AdminAuditAction } from "./audit-actions.constant";
import {
  EXTERNAL_PAYMENT_METHODS,
  type ExternalPaymentMethod,
} from "./dto/activate-subscription.dto";

const DAY = 24 * 60 * 60 * 1000;
/** A payment can be recorded this many UTC days after it happened, no further back. */
const MAX_PAID_AT_AGE_DAYS = 60;
/** Methods whose payment leaves no paper in the office: a reference is the only trace. */
const REFERENCE_REQUIRED_METHODS: readonly ExternalPaymentMethod[] = [
  "ZELLE",
  "BANK_TRANSFER",
  "WIRE",
];
/** 13-19 consecutive digits is the length of a card number (and of a full account number). */
const CARD_LIKE = /\d{13,19}/;
const CARD_LIKE_MESSAGE = "Don't enter card or full account numbers.";

const TENANT_SCOPE = { class: "PRODUCTION", deletedAt: null } as const;

/** The queue row's columns: deliberately no paidNote, voidReason or actor ids. */
const ROW_SELECT = {
  id: true,
  tenantId: true,
  number: true,
  amount: true,
  currency: true,
  cycle: true,
  periodStart: true,
  periodEnd: true,
  issuedAt: true,
  dueDate: true,
  status: true,
  lastSentAt: true,
  sendCount: true,
  paidAt: true,
  paidMethod: true,
  paidRef: true,
  lines: true,
  needsReview: true,
  tenant: {
    select: {
      name: true,
      slug: true,
      status: true,
      subscription: { select: { stripeSubId: true } },
    },
  },
} as const;

/** What an action reads before its compare-and-set: the row plus the key it may suffix. */
const ACTION_SELECT = { ...ROW_SELECT, periodKey: true } as const;

const dayStart = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

type Dto = { reason?: string };

/**
 * The super-admin queue over RouteFlow's own invoices to manual-pay tenants. An invoice is a RECORD:
 * nothing here touches a tenant's status, its subscription or a BillingEvent (SEC-5). Every state change
 * is a compare-and-set `updateMany` on the status it expects, with its audit row in the same transaction,
 * so two admins racing produce one change, one audit row and a coded 409 for the loser.
 */
@Injectable()
export class RfInvoicesAdminService {
  private readonly logger = new Logger(RfInvoicesAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: RfInvoiceBuilder,
    private readonly issuer: RfInvoiceIssuerService,
  ) {}

  // ─── Reads ────────────────────────────────────────────────────────────────

  async list(q: RfInvoiceListQuery, now: Date = new Date()): Promise<RfInvoiceListResponse> {
    const view: RfInvoiceView = q.view ?? "open";
    const page = Math.max(1, Math.floor(q.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 50)));
    const today = dayStart(now);

    const where: Record<string, unknown> = {
      tenant: { ...TENANT_SCOPE },
      ...(q.tenantId ? { tenantId: q.tenantId } : {}),
      ...viewWhere(view, today),
    };
    const term = q.q?.trim();
    if (term) {
      where.OR = [
        { number: { contains: term, mode: "insensitive" } },
        { tenant: { name: { contains: term, mode: "insensitive" } } },
        { tenant: { slug: { contains: term, mode: "insensitive" } } },
      ];
    }

    const sort = q.sort ?? "due";
    const dir = q.dir ?? (sort === "amount" ? "desc" : "asc");
    const orderBy =
      sort === "amount"
        ? [{ amount: dir }, { dueDate: "asc" }, { id: "asc" }]
        : sort === "tenant"
          ? [{ tenant: { name: dir } }, { dueDate: "asc" }, { id: "asc" }]
          : [{ dueDate: dir }, { amount: "desc" }, { id: "asc" }];

    const [rows, total] = await Promise.all([
      this.prisma.rfInvoice.findMany({
        where: where as any,
        select: ROW_SELECT,
        orderBy: orderBy as any,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.rfInvoice.count({ where: where as any }),
    ]);
    return { rows: rows.map((r: any) => this.toRow(r, now)), meta: { total, page, limit } };
  }

  async summary(now: Date = new Date()): Promise<RfInvoiceSummary> {
    const today = dayStart(now);
    const scope = { tenant: { ...TENANT_SCOPE } };
    const [openRows, byStatus, paid, subs] = await Promise.all([
      this.prisma.rfInvoice.findMany({
        where: { ...scope, status: "OPEN" },
        select: { dueDate: true, amount: true },
      }),
      this.prisma.rfInvoice.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
      this.prisma.rfInvoice.aggregate({
        where: { ...scope, status: "PAID", paidAt: { gte: new Date(now.getTime() - 30 * DAY) } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.tenantSubscription.findMany({
        where: RF_INVOICE_CANDIDATE_WHERE,
        select: {
          tenantId: true,
          cycle: true,
          periodStart: true,
          periodEnd: true,
          tenant: { select: { name: true, slug: true } },
        },
      }),
    ]);

    const overdue = { count: 0, amount: 0 };
    const dueSoon = { count: 0, amount: 0 };
    for (const r of openRows as Array<{ dueDate: Date | null; amount: unknown }>) {
      const { dueState } = dueInfo("OPEN", r.dueDate, today);
      const bucket = dueState === "overdue" ? overdue : dueState === "due_soon" ? dueSoon : null;
      if (bucket) {
        bucket.count++;
        bucket.amount += Number(r.amount);
      }
    }
    overdue.amount = roundMoney(overdue.amount);
    dueSoon.amount = roundMoney(dueSoon.amount);

    const statusCount = (s: RfInvoiceStatus) =>
      (byStatus as Array<{ status: string; _count: { _all: number } }>).find((g) => g.status === s)
        ?._count._all ?? 0;
    const all = (byStatus as Array<{ _count: { _all: number } }>).reduce(
      (n, g) => n + g._count._all,
      0,
    );

    const unpricedTenants: RfInvoiceSummary["unpricedTenants"] = [];
    const staleTenants: RfInvoiceSummary["staleTenants"] = [];
    for (const sub of subs as Array<any>) {
      const ref = { tenantId: sub.tenantId, name: sub.tenant.name, slug: sub.tenant.slug };
      if (isStale(sub as IssuerSubscription, now)) staleTenants.push(ref);
      try {
        const draft = await this.builder.build(sub.tenantId, sub.cycle);
        if (!draft.ok) unpricedTenants.push(ref);
      } catch (e) {
        // an infrastructure blip on one tenant must not blank the whole summary
        this.logger.error(`summary: pricing ${sub.tenantId} failed: ${(e as Error).message}`);
      }
    }

    return {
      overdue,
      dueSoon,
      paid30d: {
        count: (paid as any)._count?._all ?? 0,
        amount: roundMoney(Number((paid as any)._sum?.amount ?? 0)),
      },
      viewCounts: {
        overdue: overdue.count,
        due_soon: dueSoon.count,
        open: statusCount("OPEN"),
        paid: statusCount("PAID"),
        void: statusCount("VOID"),
        all,
      },
      unpricedTenants,
      staleTenants,
      mode: rfInvoicingMode(),
    };
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  async markPaid(
    id: string,
    dto: { paidAt?: string; method: string; reference?: string; note?: string },
    actorId: string,
    now: Date = new Date(),
  ): Promise<RfInvoiceRow> {
    if (!(EXTERNAL_PAYMENT_METHODS as readonly string[]).includes(dto.method)) {
      throw new BadRequestException("Unknown payment method.");
    }
    const method = dto.method as ExternalPaymentMethod;
    const reference = dto.reference?.trim() || null;
    if (reference && CARD_LIKE.test(reference)) {
      throw new BadRequestException({
        code: API_ERROR_CODES.RF_INVOICE_REFERENCE_LOOKS_LIKE_CARD,
        message: CARD_LIKE_MESSAGE,
      });
    }
    if (!reference && REFERENCE_REQUIRED_METHODS.includes(method)) {
      throw new BadRequestException({
        code: API_ERROR_CODES.RF_INVOICE_REFERENCE_REQUIRED,
        message: "Enter the confirmation or transaction reference for this payment.",
      });
    }
    const paidAt = this.resolvePaidAt(dto.paidAt, now);
    const note = dto.note?.trim() || null;

    return this.transition(id, "OPEN", actorId, now, (row) => ({
      data: {
        status: "PAID",
        paidAt,
        paidMethod: method,
        paidRef: reference,
        paidNote: note,
        paidById: actorId,
      },
      action: AdminAuditAction.RF_INVOICE_MARKED_PAID,
      message: `RouteFlow invoice ${row.number} marked paid (${method}).`,
      meta: { invoiceId: id, number: row.number, amount: Number(row.amount), method, reference },
    }));
  }

  async reopen(
    id: string,
    dto: Dto,
    actorId: string,
    now: Date = new Date(),
  ): Promise<RfInvoiceRow> {
    const reason = this.requireReason(dto);
    return this.transition(id, "PAID", actorId, now, (row) => ({
      data: {
        status: "OPEN",
        paidAt: null,
        paidMethod: null,
        paidRef: null,
        paidNote: null,
        paidById: null,
      },
      action: AdminAuditAction.RF_INVOICE_REOPENED,
      message: `RouteFlow invoice ${row.number} reopened.`,
      meta: { invoiceId: id, number: row.number, amount: Number(row.amount), reason },
    }));
  }

  async voidInvoice(
    id: string,
    dto: Dto,
    actorId: string,
    now: Date = new Date(),
  ): Promise<RfInvoiceRow> {
    const reason = this.requireReason(dto);
    return this.transition(id, "OPEN", actorId, now, (row) => ({
      data: {
        status: "VOID",
        voidedAt: now,
        voidReason: reason,
        // frees the (tenant, period) slot so a corrected invoice can be issued for the same period
        ...(row.periodKey ? { periodKey: `${row.periodKey}:void:${id}` } : {}),
      },
      action: AdminAuditAction.RF_INVOICE_VOIDED,
      message: `RouteFlow invoice ${row.number} voided.`,
      meta: { invoiceId: id, number: row.number, amount: Number(row.amount), reason },
    }));
  }

  /** POST tenants/:id/rf-invoices/issue - the cron's rules, run now for one tenant. */
  async issueForTenant(
    tenantId: string,
    actorId: string,
    now: Date = new Date(),
  ): Promise<RfInvoiceRow> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");

    if (rfInvoicingMode() === "off") {
      throw this.refuse(
        API_ERROR_CODES.RF_INVOICING_OFF,
        "Invoicing is switched off (RF_INVOICING_MODE).",
      );
    }
    const sub = (await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: {
        tenantId: true,
        cycle: true,
        planKey: true,
        periodStart: true,
        periodEnd: true,
        externalPayment: true,
        stripeSubId: true,
        cancelAtPeriodEnd: true,
        tenant: { select: { status: true, class: true, deletedAt: true } },
      },
    })) as IssuerSubscription | null;
    if (!sub || !sub.externalPayment || sub.stripeSubId || sub.tenant?.class !== "PRODUCTION") {
      throw this.refuse(
        API_ERROR_CODES.RF_INVOICE_NOT_MANUAL,
        "This tenant is not on manual invoicing.",
      );
    }
    if (!isCandidate(sub) || isStale(sub, now)) throw this.nothingToIssue();

    let issuedId: string | null = null;
    let noPrice = false;
    for (const window of await this.issuer.windowsFor(sub, now)) {
      const r = await this.issuer.issuePeriod(sub, window, now, actorId);
      if (r.status === "issued") issuedId ??= r.invoice.id;
      else if (r.status === "no_price") noPrice = true;
    }
    if (issuedId) {
      const row = await this.prisma.rfInvoice.findFirst({
        where: { id: issuedId },
        select: ROW_SELECT,
      });
      return this.toRow(row, now);
    }
    if (noPrice) {
      throw this.refuse(
        API_ERROR_CODES.RF_INVOICE_NO_PRICE,
        "No price can be resolved for this tenant, so no invoice was issued.",
      );
    }
    throw this.nothingToIssue();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /**
   * One CAS transition: read the row, refuse unless it is in the expected status, flip it with
   * `updateMany({ where: { id, status: expected } })`, write the audit row, all in one transaction.
   * A lost CAS (count 0) throws the coded 409 with the winner's row, which rolls the transaction back.
   */
  private transition(
    id: string,
    expected: "OPEN" | "PAID",
    actorId: string,
    now: Date,
    plan: (row: any) => {
      data: Record<string, unknown>;
      action: string;
      message: string;
      meta: Record<string, unknown>;
    },
  ): Promise<RfInvoiceRow> {
    return this.prisma.$transaction(async (tx: any) => {
      const row = await tx.rfInvoice.findFirst({ where: { id }, select: ACTION_SELECT });
      if (!row) throw new NotFoundException("Invoice not found");
      if (row.status !== expected) throw this.statusConflict(row, now);

      const { data, action, message, meta } = plan(row);
      const { count } = await tx.rfInvoice.updateMany({ where: { id, status: expected }, data });
      if (count === 0) {
        const fresh = await tx.rfInvoice.findFirst({ where: { id }, select: ACTION_SELECT });
        throw this.statusConflict(fresh ?? row, now);
      }
      await writeAdminNotice(tx, { tenantId: row.tenantId, actorId, action, message, meta });
      const after = await tx.rfInvoice.findFirst({ where: { id }, select: ROW_SELECT });
      return this.toRow(after, now);
    });
  }

  private statusConflict(row: any, now: Date): ConflictException {
    const code =
      row.status === "PAID"
        ? API_ERROR_CODES.RF_INVOICE_ALREADY_PAID
        : row.status === "OPEN"
          ? API_ERROR_CODES.RF_INVOICE_NOT_PAID
          : API_ERROR_CODES.RF_INVOICE_IS_VOID;
    const message =
      code === API_ERROR_CODES.RF_INVOICE_ALREADY_PAID
        ? "This invoice is already marked paid."
        : code === API_ERROR_CODES.RF_INVOICE_NOT_PAID
          ? "This invoice is not marked paid."
          : "This invoice has been voided.";
    return new ConflictException({ code, message, row: this.toRow(row, now) });
  }

  private refuse(code: string, message: string): ConflictException {
    return new ConflictException({ code, message });
  }

  private nothingToIssue(): ConflictException {
    return this.refuse(
      API_ERROR_CODES.RF_INVOICE_NOTHING_TO_ISSUE,
      "There is no invoice due for this tenant right now.",
    );
  }

  private requireReason(dto: Dto): string {
    const reason = typeof dto.reason === "string" ? dto.reason.trim() : "";
    if (reason.length < 3 || reason.length > 500) {
      throw new BadRequestException("A reason of 3 to 500 characters is required.");
    }
    return reason;
  }

  /** Default now; refuse a date in the future or more than 60 UTC days back. Never later than now. */
  private resolvePaidAt(raw: string | undefined, now: Date): Date {
    if (!raw) return now;
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) throw new BadRequestException("paidAt is not a valid date.");
    const ageDays = (dayStart(now).getTime() - dayStart(at).getTime()) / DAY;
    if (ageDays < 0) {
      throw new BadRequestException({
        code: API_ERROR_CODES.RF_INVOICE_PAID_AT_IN_FUTURE,
        message: "The payment date cannot be in the future.",
      });
    }
    if (ageDays > MAX_PAID_AT_AGE_DAYS) {
      throw new BadRequestException({
        code: API_ERROR_CODES.RF_INVOICE_PAID_AT_TOO_OLD,
        message: `The payment date cannot be more than ${MAX_PAID_AT_AGE_DAYS} days ago.`,
      });
    }
    return at.getTime() > now.getTime() ? now : at;
  }

  private toRow(r: any, now: Date): RfInvoiceRow {
    const { dueState, daysOverdue } = dueInfo(r.status, r.dueDate, dayStart(now));
    return {
      id: r.id,
      number: r.number,
      tenantId: r.tenantId,
      tenantName: r.tenant?.name ?? "",
      tenantSlug: r.tenant?.slug ?? "",
      tenantStatus: r.tenant?.status ?? "",
      tenantPaysByCard: !!r.tenant?.subscription?.stripeSubId,
      amount: roundMoney(Number(r.amount)),
      currency: r.currency,
      cycle: r.cycle,
      periodStart: iso(r.periodStart),
      periodEnd: iso(r.periodEnd),
      issuedAt: r.issuedAt.toISOString(),
      dueDate: iso(r.dueDate),
      status: r.status,
      dueState,
      daysOverdue,
      lastSentAt: iso(r.lastSentAt),
      sendCount: r.sendCount ?? 0,
      paidAt: iso(r.paidAt),
      paidMethod: r.paidMethod ?? null,
      paidRef: r.paidRef ?? null,
      lines: Array.isArray(r.lines) ? r.lines : [],
      needsReview: r.needsReview === true,
    };
  }
}

/** The one definition of overdue / due-soon (UTC days); only an OPEN invoice is ever due. */
function dueInfo(
  status: string,
  dueDate: Date | null,
  today: Date,
): { dueState: RfInvoiceRow["dueState"]; daysOverdue: number } {
  if (status !== "OPEN" || !dueDate) return { dueState: "upcoming", daysOverdue: 0 };
  const delta = Math.round((dayStart(dueDate).getTime() - today.getTime()) / DAY);
  if (delta < 0) return { dueState: "overdue", daysOverdue: -delta };
  return { dueState: delta <= RF_INVOICE_LEAD_DAYS ? "due_soon" : "upcoming", daysOverdue: 0 };
}

/** The `where` of one queue tab; kept next to `dueInfo` so the two agree on the day boundaries. */
function viewWhere(view: RfInvoiceView, today: Date): Record<string, unknown> {
  switch (view) {
    case "overdue":
      return { status: "OPEN", dueDate: { lt: today } };
    case "due_soon":
      return {
        status: "OPEN",
        dueDate: { gte: today, lt: new Date(today.getTime() + (RF_INVOICE_LEAD_DAYS + 1) * DAY) },
      };
    case "open":
      return { status: "OPEN" };
    case "paid":
      return { status: "PAID" };
    case "void":
      return { status: "VOID" };
    default:
      return {};
  }
}

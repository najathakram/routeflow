import { ConflictException, Injectable, Logger } from "@nestjs/common";
import type { CommissionAccrualStatus, CommissionAdjustmentKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { roundMoney } from "@routeflow/pricing";
import {
  COMMISSION_EPS,
  InvoiceMoneyState,
  NSF_FEE_DESCRIPTION_PREFIX,
  RateSource,
  accruedCommission,
  collectionRatio,
  commissionBase,
  passesGrandfathering,
  payableCommission,
  resolveRate,
} from "./commission-math";

/**
 * Commission sync engine. `syncInvoiceCommission` derives one invoice's
 * commission accrual state from CURRENT database state (payments, rate
 * history, customer attribution, agent lifecycle) and writes only what
 * changed — re-running with unchanged inputs writes nothing. See the plan's
 * "Engine design" section (money semantics, rate precedence, agent lifecycle,
 * the ledger invariant) at
 * .claude/pipeline/plans/2026-08-22-sales-agents-engine.md — this service is
 * a direct transplant of that design, not a reinterpretation of it.
 *
 * The ledger invariant in one line: for accrual A,
 * drift(A) = payable(A) − claimedAmount(A) − Σadjustments(A). A sync never
 * mutates claims (those only move via CommissionStatementsService); when
 * drift < −ε it appends exactly one CommissionAdjustment (append-only) whose
 * amount self-limits drift back to ~0. Positive drift needs no adjustment —
 * it is simply unclaimed payable the next statement generation will sweep.
 *
 * "Exactly one" is only true under concurrency because `runSync` opens with
 * a `FOR UPDATE` row lock on this invoice's CommissionAccrual (keyed on
 * invoiceId — see `runSync`'s own docblock). Without it, two READ COMMITTED
 * callers (the hourly reconciliation cron and a hook call site) can each
 * read zero prior adjustments and both append the same CLAWBACK (B73).
 * That lock holds for EVERY caller, not just the ones that hand over a
 * transaction: `syncInvoiceCommission` wraps a non-transactional `db` (a
 * `forTenant()` client — what the un-`tx`'d `reconcileOrderDraftInvoice`
 * hook path passes) in its own `tenantTransaction` first, so the lock can
 * never be released between the read and the append. Residual, filed not
 * fixed: `removeInvoiceCommission` takes no lock.
 */
@Injectable()
export class CommissionEngineService {
  private readonly logger = new Logger(CommissionEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Derive-from-current-state sync for one invoice. Idempotent: unchanged
   * state writes nothing. `db` = a tenantTransaction tx or forTenant()
   * client; when omitted — OR when the caller hands over a non-transactional
   * client — it opens its own tenantTransaction, so `runSync`'s B73
   * `FOR UPDATE` lock always spans that sync's read-then-append (B73: a
   * lock taken on an autocommit client is released one statement later and
   * protects nothing).
   */
  async syncInvoiceCommission(invoiceId: string, db?: any): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return;
    if (!(await this.entitlements.hasFlag(tenantId, "flag.sales_agents"))) return;

    if (db && this.isTransactionClient(db)) {
      await this.runSync(invoiceId, db);
    } else {
      await this.prisma.tenantTransaction((tx: any) => this.runSync(invoiceId, tx));
    }
  }

  /**
   * True when `db` is an interactive-transaction client. Prisma's tx client —
   * and the tenant-scoping Proxy `tenantTransaction` wraps it in, which passes
   * `$`-prefixed keys straight through — omits `$transaction`; a base or
   * `$extends`ed client (what `forTenant()` returns) exposes it. Callers that
   * pass the latter therefore get wrapped in a real transaction rather than
   * silently losing the B73 row lock.
   */
  private isTransactionClient(db: any): boolean {
    return typeof db?.$transaction !== "function";
  }

  /**
   * Hook-safe wrapper: catches EVERYTHING, logs loudly, never throws — a
   * commission bug must never block an invoice or payment write. The hourly
   * reconciliation cron heals any sync this swallows.
   *
   * Caveat the engine is written around: when `db` is the CALLER's transaction,
   * a database error raised inside it aborts that whole Postgres transaction,
   * so swallowing it here cannot save the caller — the commit fails anyway.
   * The engine therefore must not provoke foreseeable in-transaction database
   * errors (see the pre-insert check in `createAccrualRow`); this wrapper is
   * the backstop for logic bugs, not a licence to let constraint violations fly.
   */
  async syncInvoiceCommissionSafe(invoiceId: string, db?: any): Promise<void> {
    try {
      await this.syncInvoiceCommission(invoiceId, db);
    } catch (err) {
      this.logger.error(
        `Commission sync failed for invoice ${invoiceId}: ${(err as Error)?.message ?? err}`,
        (err as Error)?.stack,
      );
    }
  }

  /** All non-DRAFT invoices of one order (per-order override changes, order edits). */
  async syncOrderInvoices(orderId: string, db?: any): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return;
    if (!(await this.entitlements.hasFlag(tenantId, "flag.sales_agents"))) return;

    const client = db ?? this.prisma.forTenant();
    const invoices = await client.invoice.findMany({
      where: { orderId, status: { not: "DRAFT" } },
      select: { id: true },
    });
    for (const inv of invoices) {
      await this.syncInvoiceCommission(inv.id, db);
    }
  }

  /**
   * Pre-delete: throws ConflictException if any accrual on this invoice has
   * claimedAmount > 0; otherwise deletes the invoice's accrual rows (+ their
   * unclaimed adjustments — a swept/claimed adjustment is a statement's
   * historical record and must survive; it is what the claimedAmount guard
   * above exists to protect).
   */
  async removeInvoiceCommission(invoiceId: string, db: any): Promise<void> {
    const accruals = await db.commissionAccrual.findMany({
      where: { invoiceId },
      include: { adjustments: { include: { line: true } } },
    });
    const hasClaims = accruals.some((a: any) => Number(a.claimedAmount) > COMMISSION_EPS);
    if (hasClaims) {
      throw new ConflictException(
        "Cannot remove commission accruals with claimed amounts outstanding — void the statement first.",
      );
    }
    for (const accrual of accruals) {
      const unclaimedAdjustmentIds = accrual.adjustments
        .filter((a: any) => !a.line)
        .map((a: any) => a.id);
      if (unclaimedAdjustmentIds.length > 0) {
        await db.commissionAdjustment.deleteMany({ where: { id: { in: unclaimedAdjustmentIds } } });
      }
    }
    if (accruals.length > 0) {
      await db.commissionAccrual.deleteMany({ where: { invoiceId } });
    }
  }

  /**
   * Backdated rate/assignment sweep. Enumerates non-DRAFT invoices of
   * customers covered by scope.agentId (via any AgentAssignment) or scope.
   * customerId, whose issueDate or order.orderDate is >= fromDate, and syncs
   * each in its OWN sequential tenantTransaction (crash-resumable).
   */
  async recomputeCommissionRange(
    scope: { agentId?: string; customerId?: string },
    fromDate: Date,
  ): Promise<{ invoicesSynced: number }> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return { invoicesSynced: 0 };
    if (!(await this.entitlements.hasFlag(tenantId, "flag.sales_agents"))) {
      return { invoicesSynced: 0 };
    }

    const customerFilter: any = {};
    if (scope.customerId) {
      customerFilter.id = scope.customerId;
    } else if (scope.agentId) {
      customerFilter.agentAssignments = { some: { agentId: scope.agentId } };
    }

    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        status: { not: "DRAFT" },
        customer: customerFilter,
        OR: [{ issueDate: { gte: fromDate } }, { order: { orderDate: { gte: fromDate } } }],
      },
      select: { id: true },
    });

    for (const inv of invoices) {
      await this.prisma.tenantTransaction((tx: any) => this.runSync(inv.id, tx));
    }

    await this.audit.log({
      tenantId,
      userId: null,
      action: "commission.recompute",
      entityType: scope.agentId ? "SalesAgent" : "Customer",
      entityId: scope.agentId ?? scope.customerId ?? null,
      meta: { scope, fromDate: fromDate.toISOString(), count: invoices.length },
    });

    return { invoicesSynced: invoices.length };
  }

  // ─── internal sync algorithm (not part of the pinned public surface) ────

  /**
   * B73: serializes concurrent syncs of the SAME invoice's commission
   * accrual with a `FOR UPDATE` row lock, taken BEFORE the invoice read so
   * a caller that acquires it second observes every adjustment the first
   * caller already committed — this is what makes "append exactly one
   * CommissionAdjustment per drift" (see the class docblock) hold even when
   * two READ COMMITTED callers race. Keyed on invoiceId ONLY:
   * CommissionAccrual.tenantId is nullable (legacy rows), so a tenant
   * predicate would let those rows escape the lock, and invoiceId is a
   * UUID, so a cross-tenant collision is impossible. Contract: `runSync` is
   * only ever reached with a transactional client — `recomputeCommissionRange`
   * opens its own `tenantTransaction`, and `syncInvoiceCommission` wraps a
   * non-transactional `db` in one before calling through. On an autocommit
   * client the lock would be released before the read below and protect
   * nothing. Residual: `removeInvoiceCommission` has no lock, filed not fixed.
   */
  private async runSync(invoiceId: string, db: any): Promise<void> {
    await db.$executeRaw`SELECT id FROM "CommissionAccrual" WHERE "invoiceId" = ${invoiceId} FOR UPDATE`;

    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        payments: { select: { id: true, amount: true, method: true, status: true } },
        items: { select: { description: true, qty: true, unitPrice: true } },
        order: {
          select: {
            orderDate: true,
            commissionRatePct: true,
            orderTemplate: { select: { createdAt: true } },
          },
        },
        recurringInvoice: { select: { createdAt: true } },
        commissionAccruals: { include: { adjustments: true } },
      },
    });
    if (!invoice) return; // removal path owns deletes

    const basisDate: Date = invoice.order?.orderDate ?? invoice.issueDate;
    const issued = invoice.status !== "DRAFT" && invoice.status !== "VOID";

    // The attributed agent = the AgentAssignment row covering basisDate. No
    // covering assignment → house account → resolvedAgentId stays null and
    // every existing row on this invoice zero-targets.
    const assignment = await db.agentAssignment.findFirst({
      where: {
        customerId: invoice.customerId,
        effectiveFrom: { lte: basisDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: basisDate } }],
      },
      orderBy: { effectiveFrom: "desc" },
    });
    const resolvedAgentId: string | null = assignment?.agentId ?? null;

    let ratePct = 0;
    let rateSource: RateSource = "NONE";
    if (resolvedAgentId) {
      const [customerRateRows, agentRateRows] = await Promise.all([
        db.customerCommissionRate.findMany({
          where: { customerId: invoice.customerId },
          select: { ratePct: true, effectiveFrom: true },
        }),
        db.salesAgentRate.findMany({
          where: { agentId: resolvedAgentId },
          select: { ratePct: true, effectiveFrom: true },
        }),
      ]);
      const orderOverride =
        invoice.order?.commissionRatePct != null ? Number(invoice.order.commissionRatePct) : null;
      const resolved = resolveRate(
        orderOverride,
        customerRateRows.map((r: any) => ({
          ratePct: Number(r.ratePct),
          effectiveFrom: r.effectiveFrom,
        })),
        agentRateRows.map((r: any) => ({
          ratePct: Number(r.ratePct),
          effectiveFrom: r.effectiveFrom,
        })),
        basisDate,
      );
      ratePct = resolved.ratePct;
      rateSource = resolved.source;
    }

    const nsfFees = roundMoney(
      (invoice.items ?? [])
        .filter((i: any) => i.description?.startsWith(NSF_FEE_DESCRIPTION_PREFIX))
        .reduce((s: number, i: any) => s + Number(i.qty) * Number(i.unitPrice), 0),
    );
    const moneyState: InvoiceMoneyState = {
      subtotal: Number(invoice.subtotal),
      discount: Number(invoice.discount),
      total: Number(invoice.total),
      cashCollected: invoice.payments
        .filter((p: any) => p.status === "PAID" && p.method !== "CREDIT_NOTE")
        .reduce((s: number, p: any) => s + Number(p.amount), 0),
      creditApplied: invoice.payments
        .filter((p: any) => p.status === "PAID" && p.method === "CREDIT_NOTE")
        .reduce((s: number, p: any) => s + Number(p.amount), 0),
      nsfFees,
    };
    const base = commissionBase(moneyState);
    const ratio = collectionRatio(moneyState);

    const existingByAgent = new Map<string, any>(
      invoice.commissionAccruals.map((a: any) => [a.agentId, a]),
    );

    // Re-sync every EXISTING row: the resolved agent's row (if it already
    // exists) earns per the formulas; every OTHER agent's row zero-targets.
    // Existing rows are ALWAYS re-synced regardless of the resolved agent's
    // current PAUSED/STOPPED_FOR_NEW/deleted status — those only gate
    // creation of a brand-new row, below.
    for (const existing of invoice.commissionAccruals) {
      const isResolved = existing.agentId === resolvedAgentId;
      await this.syncAccrualRow(
        db,
        invoice,
        existing,
        isResolved,
        issued,
        base,
        ratePct,
        rateSource,
        ratio,
        basisDate,
      );
    }

    // Create a fresh row for the resolved agent only if it doesn't have one yet.
    if (resolvedAgentId && !existingByAgent.has(resolvedAgentId)) {
      await this.createAccrualRow(
        db,
        invoice,
        resolvedAgentId,
        issued,
        base,
        ratePct,
        rateSource,
        ratio,
        basisDate,
      );
    }
  }

  /** Re-sync one existing CommissionAccrual row toward its current target. */
  private async syncAccrualRow(
    db: any,
    invoice: any,
    existing: any,
    isResolved: boolean,
    issued: boolean,
    base: number,
    ratePct: number,
    rateSource: RateSource,
    ratio: number,
    basisDate: Date,
  ): Promise<void> {
    const earning = isResolved && issued;
    const targetBase = earning ? roundMoney(base) : 0;
    const targetRatePct = earning ? ratePct : 0;
    const targetRateSource: RateSource = earning ? rateSource : "NONE";
    const targetAccrued = earning ? accruedCommission(base, ratePct) : 0;
    const targetPayable = earning ? payableCommission(targetAccrued, ratio) : 0;

    const claimedAmount = Number(existing.claimedAmount);
    const priorAdjTotal = roundMoney(
      existing.adjustments.reduce((s: number, a: any) => s + Number(a.amount), 0),
    );
    const rawDrift = roundMoney(targetPayable - claimedAmount - priorAdjTotal);

    // Drift rule: a negative drift means the target dropped below what's
    // already claimed + previously adjusted — append exactly one signed,
    // append-only CommissionAdjustment that brings drift back to ~0. Positive
    // drift needs nothing: it is simply unclaimed payable for the next
    // statement's CLAIM line.
    let newAdjustment: { kind: CommissionAdjustmentKind; amount: number } | null = null;
    if (rawDrift < -COMMISSION_EPS) {
      // Only a row that still EARNS can have had its rate changed. When the
      // invoice is no longer issued (void / reverted to draft / reopened) the
      // target rate is forced to 0/NONE, which would otherwise read as a rate
      // change and mislabel the clawback — the cause is the un-issue, so the
      // kind is CLAWBACK.
      const rateChanged =
        earning &&
        (Number(existing.ratePct) !== targetRatePct || existing.rateSource !== targetRateSource);
      const kind: CommissionAdjustmentKind = !isResolved
        ? "REASSIGNMENT"
        : rateChanged
          ? "RATE_CHANGE"
          : "CLAWBACK";
      newAdjustment = { kind, amount: rawDrift };
    }
    const adjTotalAfter = newAdjustment
      ? roundMoney(priorAdjTotal + newAdjustment.amount)
      : priorAdjTotal;
    const finalDrift = roundMoney(targetPayable - claimedAmount - adjTotalAfter);

    // A zero-target row with nothing claimed and no adjustment history (old
    // or new) carries no information worth keeping — delete it rather than
    // leaving an empty row behind. "Zero target" means the row no longer earns
    // at all (the agent lost the customer, or the invoice is no longer issued)
    // — NOT merely that the resolved rate rounds to zero: a resolved agent at
    // rate 0 (rateSource NONE, or an explicit "exempt" order override) keeps
    // its placeholder row so a later backdated rate has something for the
    // recompute sweep to find and correct in place.
    const isZeroTarget = !earning;
    const canDelete =
      isZeroTarget &&
      claimedAmount <= COMMISSION_EPS &&
      existing.adjustments.length === 0 &&
      !newAdjustment;

    if (canDelete) {
      await db.commissionAccrual.delete({ where: { id: existing.id } });
      return;
    }

    const status = this.deriveAccrualStatus({
      targetAccrued,
      claimedAmount,
      drift: finalDrift,
      ratio,
    });

    const unchanged =
      !newAdjustment &&
      Number(existing.baseAmount) === targetBase &&
      Number(existing.ratePct) === targetRatePct &&
      existing.rateSource === targetRateSource &&
      Number(existing.accruedAmount) === roundMoney(targetAccrued) &&
      Number(existing.payableAmount) === roundMoney(targetPayable) &&
      existing.status === status &&
      new Date(existing.basisDate).getTime() === basisDate.getTime();

    if (!unchanged) {
      await db.commissionAccrual.update({
        where: { id: existing.id },
        data: {
          basisDate,
          baseAmount: targetBase,
          ratePct: targetRatePct,
          rateSource: targetRateSource,
          accruedAmount: roundMoney(targetAccrued),
          payableAmount: roundMoney(targetPayable),
          status,
        },
      });
    }

    if (newAdjustment) {
      await db.commissionAdjustment.create({
        data: {
          accrualId: existing.id,
          agentId: existing.agentId,
          kind: newAdjustment.kind,
          amount: newAdjustment.amount,
          reason: this.adjustmentReason(newAdjustment.kind, invoice),
        },
      });
    }
  }

  /** Create a brand-new CommissionAccrual row for the resolved agent, gated by lifecycle. */
  private async createAccrualRow(
    db: any,
    invoice: any,
    agentId: string,
    issued: boolean,
    base: number,
    ratePct: number,
    rateSource: RateSource,
    ratio: number,
    basisDate: Date,
  ): Promise<void> {
    if (!issued) return;
    const agent = await db.salesAgent.findFirst({
      where: { id: agentId },
      select: { status: true, deletedAt: true, stopNewBusinessAt: true },
    });
    if (!agent || agent.deletedAt) return;
    if (agent.status === "PAUSED") return;
    if (agent.status === "STOPPED_FOR_NEW") {
      const grandfathered = passesGrandfathering({
        stopNewBusinessAt: agent.stopNewBusinessAt,
        basisDate,
        orderTemplateCreatedAt: invoice.order?.orderTemplate?.createdAt ?? null,
        recurringInvoiceCreatedAt: invoice.recurringInvoice?.createdAt ?? null,
      });
      if (!grandfathered) return;
    }

    // rateSource NONE (no rate found at all) still creates a row — ratePct 0
    // means accrued/payable land at 0, so a later backdated rate has an
    // existing row for the recompute sweep to find and correct in place.
    const accruedAmount = accruedCommission(base, ratePct);
    const payableAmount = payableCommission(accruedAmount, ratio);
    const status = this.deriveAccrualStatus({
      targetAccrued: accruedAmount,
      claimedAmount: 0,
      drift: roundMoney(payableAmount),
      ratio,
    });

    // Re-check the double-accrual lock (@@unique([tenantId, invoiceId, agentId]))
    // BEFORE inserting rather than catching its P2002 afterwards: `db` is
    // usually the caller's invoice/payment transaction, and Postgres aborts the
    // WHOLE transaction on a constraint violation, so swallowing the error
    // would only defer the failure to COMMIT — breaking exactly the flow the
    // Safe wrapper exists to protect. This read runs in the same transaction,
    // so it sees anything a concurrent sync committed since runSync's own read.
    const alreadyAccrued = await db.commissionAccrual.findFirst({
      where: { invoiceId: invoice.id, agentId },
      select: { id: true },
    });
    if (alreadyAccrued) return;

    await db.commissionAccrual.create({
      data: {
        invoiceId: invoice.id,
        agentId,
        customerId: invoice.customerId,
        basisDate,
        baseAmount: roundMoney(base),
        ratePct,
        rateSource,
        accruedAmount: roundMoney(accruedAmount),
        payableAmount: roundMoney(payableAmount),
        claimedAmount: 0,
        status,
      },
    });
  }

  /**
   * PENDING/PARTIAL/PAYABLE/SETTLED/VOID derivation. VOID means the row
   * earned nothing THIS sync (targetAccrued ~ 0) — not merely "nothing
   * collected yet", which is PENDING (targetAccrued > 0, ratio 0).
   */
  private deriveAccrualStatus(args: {
    targetAccrued: number;
    claimedAmount: number;
    drift: number;
    ratio: number;
  }): CommissionAccrualStatus {
    if (args.targetAccrued <= COMMISSION_EPS && args.claimedAmount <= COMMISSION_EPS) {
      return "VOID";
    }
    if (
      Math.abs(args.drift) <= COMMISSION_EPS &&
      args.ratio >= 1 - COMMISSION_EPS &&
      args.claimedAmount > COMMISSION_EPS
    ) {
      return "SETTLED";
    }
    if (args.ratio >= 1 - COMMISSION_EPS) return "PAYABLE";
    if (args.ratio > COMMISSION_EPS) return "PARTIAL";
    return "PENDING";
  }

  private adjustmentReason(kind: CommissionAdjustmentKind, invoice: any): string {
    const label = invoice.invoiceNumber ?? invoice.id;
    switch (kind) {
      case "CLAWBACK":
        return `Payable reduced on invoice ${label} (void, credit, or payment reversal).`;
      case "RATE_CHANGE":
        return `Commission rate changed retroactively for invoice ${label}.`;
      case "REASSIGNMENT":
        return `Customer attribution changed away from this agent as of invoice ${label}.`;
      default:
        return `Adjustment on invoice ${label}.`;
    }
  }
}

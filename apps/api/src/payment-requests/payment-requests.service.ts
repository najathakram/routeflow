import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StripeConnectService } from "../stripe-connect/stripe-connect.service";
import { StripeService } from "../billing/stripe.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { roundMoney } from "../common/pricing";

/** Statuses with money still owed — DRAFT is not issued, PAID/VOID/WRITTEN_OFF owe nothing. */
const OPEN_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.OVERDUE,
];

export interface AllocationPreviewLine {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: Date;
  total: number;
  balanceDue: number;
  /** What this payment would put on the invoice (0 rows are dropped). */
  applied: number;
}

/**
 * Buyer-initiated payments (card via the tenant's connected Stripe account, or
 * a declared cash payment awaiting operator approval).
 *
 * ALLOCATION POLICY (owner decision 2026-08-21): every buyer payment is against
 * the ACCOUNT and settles the OLDEST invoices first (issueDate asc, then
 * invoiceNumber asc), partially covering the last invoice it reaches. The
 * request may record which invoice screen it started from, but allocation never
 * honors it — the UI says so.
 *
 * MONEY DISCIPLINE: a request row is NOT money. InvoicePayment rows are written
 * exclusively through InvoicesService.recordStandalonePayment — on operator
 * approval (cash) or a verified Stripe webhook (card) — so payment numbering,
 * grouping and invoice status recompute stay in the one existing code path,
 * and a pending request can never move a balance (the DRAFT-payment trap).
 */
@Injectable()
export class PaymentRequestsService {
  private readonly logger = new Logger(PaymentRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly connect: StripeConnectService,
    private readonly stripe: StripeService,
    private readonly tenantContext: TenantContextService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  // ─── Allocation ─────────────────────────────────────────────────────────────

  /** Open invoices for a customer, oldest first, with live balances. */
  private async openInvoices(customerId: string): Promise<AllocationPreviewLine[]> {
    const rows = await this.prisma.forTenant().invoice.findMany({
      where: { customerId, status: { in: OPEN_STATUSES } },
      include: { payments: { where: { status: { not: "VOID" as any } } } },
      orderBy: [{ issueDate: "asc" }, { invoiceNumber: "asc" }],
    });
    return rows
      .map((inv) => {
        const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        const balanceDue = roundMoney(Number(inv.total) - paid);
        return {
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          issueDate: inv.issueDate,
          total: roundMoney(Number(inv.total)),
          balanceDue,
          applied: 0,
        };
      })
      .filter((l) => l.balanceDue > 0.001);
  }

  /**
   * Spread `amount` across the open invoices oldest-first. Returns the preview
   * lines (with `applied` filled), the compact allocations for
   * recordStandalonePayment, and whatever exceeds the account balance.
   */
  async buildOldestFirstAllocation(customerId: string, amount: number) {
    const lines = await this.openInvoices(customerId);
    let remaining = roundMoney(amount);
    for (const line of lines) {
      if (remaining <= 0.001) break;
      line.applied = roundMoney(Math.min(remaining, line.balanceDue));
      remaining = roundMoney(remaining - line.applied);
    }
    return {
      lines,
      allocations: lines
        .filter((l) => l.applied > 0)
        .map((l) => ({ invoiceId: l.invoiceId, amount: l.applied })),
      excess: Math.max(0, remaining),
      balanceDue: roundMoney(lines.reduce((s, l) => s + l.balanceDue, 0)),
    };
  }

  // ─── Buyer side ─────────────────────────────────────────────────────────────

  /** Everything the "Make a payment" panel needs in one call. */
  async paymentContext(tenantId: string, customerId: string) {
    const [lines, account, pending] = await Promise.all([
      this.openInvoices(customerId),
      this.connect.chargeableAccount(tenantId),
      this.prisma.buyerPaymentRequest.findMany({
        where: { tenantId, customerId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return {
      balanceDue: roundMoney(lines.reduce((s, l) => s + l.balanceDue, 0)),
      cardEnabled: !!account,
      openInvoices: lines,
      pendingRequests: pending.map((r) => this.toBuyerView(r)),
    };
  }

  /** Buyer preview: "paying $X settles these invoices". Read-only. */
  async previewAllocation(customerId: string, amount: number) {
    this.assertAmount(amount);
    const { lines, excess } = await this.buildOldestFirstAllocation(customerId, amount);
    return { lines: lines.filter((l) => l.applied > 0), excess };
  }

  private assertAmount(amount: number) {
    if (!Number.isFinite(amount) || amount < 0.5) {
      // Stripe's own floor is $0.50 — one floor for both kinds keeps it simple.
      throw new BadRequestException("Payment amount must be at least $0.50");
    }
    if (amount > 999999) throw new BadRequestException("Payment amount is too large");
  }

  private async assertNoOpenRequest(tenantId: string, customerId: string) {
    const open = await this.prisma.buyerPaymentRequest.findFirst({
      where: { tenantId, customerId, status: "PENDING" },
    });
    if (open) {
      throw new BadRequestException(
        open.kind === "CASH"
          ? "You already have a payment awaiting the seller's approval. Cancel it first to submit a different one."
          : "You already have a card payment in progress. Cancel it first to start another.",
      );
    }
  }

  /**
   * Start a card payment: a Stripe Checkout Session ON the tenant's connected
   * account. The amount is capped at the account balance so a card payment can
   * never mint on-account credit. The PENDING row exists before the redirect;
   * money moves only when the webhook proves the session paid.
   */
  async createCardRequest(params: {
    tenantId: string;
    tenantSlug: string;
    customerId: string;
    buyerAccountId: string;
    amount: number;
    fromInvoiceId?: string | null;
  }) {
    this.assertAmount(params.amount);
    await this.assertNoOpenRequest(params.tenantId, params.customerId);

    const account = await this.connect.chargeableAccount(params.tenantId);
    if (!account) {
      throw new BadRequestException("This seller does not accept card payments yet.");
    }
    const { balanceDue } = await this.buildOldestFirstAllocation(params.customerId, params.amount);
    if (balanceDue <= 0.001) throw new BadRequestException("Nothing is currently owed.");
    const amount = roundMoney(Math.min(params.amount, balanceDue));

    const [tenant, config, customer] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: params.tenantId }, select: { name: true } }),
      this.prisma.tenantConfig.findUnique({
        where: { tenantId: params.tenantId },
        select: { currency: true, businessName: true },
      }),
      this.prisma.forTenant().customer.findFirst({
        where: { id: params.customerId },
        select: { businessName: true, email: true },
      }),
    ]);
    if (!customer) throw new NotFoundException("Customer not found");

    const request = await this.prisma.buyerPaymentRequest.create({
      data: {
        tenantId: params.tenantId,
        customerId: params.customerId,
        buyerAccountId: params.buyerAccountId,
        invoiceId: params.fromInvoiceId ?? null,
        kind: "CARD",
        status: "PENDING",
        amount,
      },
    });

    const webUrl = (process.env.WEB_URL ?? "https://www.routeflow.info").replace(/\/$/, "");
    const backTo = `${webUrl}/buyer/portal/${params.tenantSlug}/payments`;
    const sellerName = config?.businessName ?? tenant?.name ?? "your seller";

    let session: any;
    try {
      session = await this.stripe.client.checkout.sessions.create(
        {
          mode: "payment",
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: (config?.currency ?? "USD").toLowerCase(),
                unit_amount: Math.round(amount * 100),
                product_data: {
                  name: `Payment to ${sellerName}`,
                  description: "Applied to your oldest open invoices first",
                },
              },
            },
          ],
          metadata: { buyerPaymentRequestId: request.id },
          customer_email: customer.email ?? undefined,
          success_url: `${backTo}?payment=processing`,
          cancel_url: `${backTo}?payment=cancelled`,
        },
        { stripeAccount: account },
      );
    } catch (err: any) {
      // The row must not linger PENDING when Stripe never issued a session —
      // it would block the buyer's next attempt.
      await this.prisma.buyerPaymentRequest.update({
        where: { id: request.id },
        data: { status: "FAILED", failureReason: String(err?.message ?? "session_create_failed") },
      });
      this.logger.warn(`Checkout session create failed (${account}): ${err?.message}`);
      throw new BadRequestException("Could not start the card payment — try again.");
    }

    await this.prisma.buyerPaymentRequest.update({
      where: { id: request.id },
      data: {
        stripeSessionId: session.id,
        expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
      },
    });
    return { requestId: request.id, url: session.url, amount };
  }

  /** Declare a cash payment. No money moves until the operator approves. */
  async createCashRequest(params: {
    tenantId: string;
    customerId: string;
    buyerAccountId: string;
    amount: number;
    note?: string | null;
    reference?: string | null;
    fromInvoiceId?: string | null;
  }) {
    this.assertAmount(params.amount);
    await this.assertNoOpenRequest(params.tenantId, params.customerId);

    const customer = await this.prisma.forTenant().customer.findFirst({
      where: { id: params.customerId },
      select: { businessName: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    const request = await this.prisma.buyerPaymentRequest.create({
      data: {
        tenantId: params.tenantId,
        customerId: params.customerId,
        buyerAccountId: params.buyerAccountId,
        invoiceId: params.fromInvoiceId ?? null,
        kind: "CASH",
        status: "PENDING",
        amount: roundMoney(params.amount),
        note: params.note?.slice(0, 500) ?? null,
        reference: params.reference?.slice(0, 120) ?? null,
      },
    });
    this.gateway.emitBuyerPaymentRequest(params.tenantId, {
      requestId: request.id,
      customerId: params.customerId,
      customerName: customer.businessName,
      kind: "CASH",
      amount: Number(request.amount),
      requestedAt: request.createdAt.toISOString(),
    });
    return this.toBuyerView(request);
  }

  async cancelOwn(buyerAccountId: string, customerId: string, requestId: string) {
    const claimed = await this.prisma.buyerPaymentRequest.updateMany({
      where: { id: requestId, buyerAccountId, customerId, status: "PENDING" },
      data: { status: "CANCELLED", decidedAt: new Date() },
    });
    if (claimed.count === 0) throw new NotFoundException("No pending request to cancel");
    return { cancelled: true };
  }

  async listForBuyer(tenantId: string, customerId: string, limit = 20) {
    const rows = await this.prisma.buyerPaymentRequest.findMany({
      where: { tenantId, customerId },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 50),
    });
    return rows.map((r) => this.toBuyerView(r));
  }

  private toBuyerView(r: any) {
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      amount: Number(r.amount),
      note: r.note,
      reference: r.reference,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      failureReason: r.failureReason,
    };
  }

  // ─── Tenant side ────────────────────────────────────────────────────────────

  async listForTenant(status?: string) {
    const where: any = {};
    if (status) where.status = status;
    const rows = await this.prisma.forTenant().buyerPaymentRequest.findMany({
      where,
      include: { customer: { select: { businessName: true, contactName: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    // The approve dialog shows where the money would land before committing.
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        amount: Number(r.amount),
        note: r.note,
        reference: r.reference,
        customerId: r.customerId,
        customerName: r.customer.businessName,
        contactName: r.customer.contactName,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        decidedByName: r.decidedByName,
        allocationPreview:
          r.status === "PENDING"
            ? (await this.buildOldestFirstAllocation(r.customerId, Number(r.amount))).lines.filter(
                (l) => l.applied > 0,
              )
            : undefined,
      })),
    );
  }

  /**
   * Operator approves a declared cash payment: claim the row atomically, then
   * write the money through recordStandalonePayment (oldest-first; anything
   * above the balance becomes on-account credit, mirroring the AP flow).
   */
  async approve(requestId: string, decidedBy: { id: string; username: string }) {
    const tenantId = this.tenantContext.get();
    const request = await this.prisma.buyerPaymentRequest.findFirst({
      where: { id: requestId, tenantId },
    });
    if (!request) throw new NotFoundException("Payment request not found");
    if (request.kind !== "CASH") {
      throw new BadRequestException("Card payments settle from Stripe automatically.");
    }

    const claimed = await this.prisma.buyerPaymentRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: {
        status: "APPROVED",
        decidedById: decidedBy.id,
        decidedByName: decidedBy.username,
        decidedAt: new Date(),
      },
    });
    if (claimed.count === 0) throw new BadRequestException("Request already decided");

    try {
      const { allocations } = await this.buildOldestFirstAllocation(
        request.customerId,
        Number(request.amount),
      );
      const result = await this.invoices.recordStandalonePayment({
        customerId: request.customerId,
        totalAmount: Number(request.amount),
        method: "CASH",
        reference: request.reference ?? undefined,
        notes: request.note ? `Buyer declared: ${request.note}` : "Buyer-declared cash payment",
        allocations,
      } as any);
      await this.prisma.buyerPaymentRequest.update({
        where: { id: requestId },
        data: { paymentGroupId: result.paymentGroupId },
      });
      return { approved: true, paymentGroupId: result.paymentGroupId, excess: result.excess };
    } catch (err) {
      // Money write failed — reopen the request so the approval can be retried.
      await this.prisma.buyerPaymentRequest.update({
        where: { id: requestId },
        data: { status: "PENDING", decidedById: null, decidedByName: null, decidedAt: null },
      });
      throw err;
    }
  }

  async reject(requestId: string, decidedBy: { id: string; username: string }, reason?: string) {
    const tenantId = this.tenantContext.get();
    const claimed = await this.prisma.buyerPaymentRequest.updateMany({
      where: { id: requestId, tenantId, status: "PENDING" },
      data: {
        status: "REJECTED",
        failureReason: reason?.slice(0, 300) ?? null,
        decidedById: decidedBy.id,
        decidedByName: decidedBy.username,
        decidedAt: new Date(),
      },
    });
    if (claimed.count === 0) throw new NotFoundException("No pending request to reject");
    return { rejected: true };
  }

  // ─── Webhook settlement (card) ──────────────────────────────────────────────

  /**
   * checkout.session.completed / async_payment_succeeded. Runs with NO request
   * context — establishes the tenant scope itself, claims the request
   * atomically (Stripe retries webhooks; the unique session id plus the
   * PENDING-claim makes replays a no-op), then writes the money.
   */
  async settleCardBySession(session: any) {
    const sessionId: string | undefined = session?.id;
    if (!sessionId) return { handled: false };
    const request = await this.prisma.buyerPaymentRequest.findUnique({
      where: { stripeSessionId: sessionId },
    });
    if (!request) {
      this.logger.warn(`No payment request for checkout session ${sessionId} — ignoring`);
      return { handled: false };
    }
    if (session.payment_status !== "paid") return { handled: false };

    const claimed = await this.prisma.buyerPaymentRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        stripePaymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null),
        decidedByName: "Stripe",
        decidedAt: new Date(),
      },
    });
    if (claimed.count === 0) return { handled: true }; // replay — already settled

    try {
      await this.tenantContext.run(request.tenantId, async () => {
        const { allocations } = await this.buildOldestFirstAllocation(
          request.customerId,
          Number(request.amount),
        );
        const result = await this.invoices.recordStandalonePayment({
          customerId: request.customerId,
          totalAmount: Number(request.amount),
          method: "CREDIT_CARD",
          reference:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? sessionId),
          notes: "Card payment via Stripe",
          // The card cleared the moment Stripe said so.
          settledAt: new Date().toISOString(),
          allocations,
        } as any);
        await this.prisma.buyerPaymentRequest.update({
          where: { id: request.id },
          data: { paymentGroupId: result.paymentGroupId },
        });
      });
      this.logger.log(`Card payment settled for request ${request.id} (${sessionId})`);
      return { handled: true };
    } catch (err) {
      // Reopen and rethrow — Stripe will redeliver and the claim will re-run.
      await this.prisma.buyerPaymentRequest.update({
        where: { id: request.id },
        data: { status: "PENDING", decidedByName: null, decidedAt: null },
      });
      throw err;
    }
  }

  /** async_payment_failed (delayed methods) — surface the failure to the buyer. */
  async failCardBySession(session: any, reason?: string) {
    const sessionId: string | undefined = session?.id;
    if (!sessionId) return;
    await this.prisma.buyerPaymentRequest.updateMany({
      where: { stripeSessionId: sessionId, status: "PENDING" },
      data: { status: "FAILED", failureReason: reason?.slice(0, 300) ?? "Payment failed" },
    });
  }
}

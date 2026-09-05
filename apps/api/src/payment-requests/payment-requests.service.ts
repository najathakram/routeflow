import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { BuyerPaymentRequestStatus, InvoiceStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { InvoicesService } from "../invoices/invoices.service";
import { CONFIRMED_PAYMENT, sumConfirmed } from "../invoices/payment-predicates";
import { StripeConnectService } from "../stripe-connect/stripe-connect.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { roundMoney } from "@routeflow/pricing";
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type HostedCheckoutSession,
  type ExpireCheckoutOutcome,
  type NormalizedPiSucceededEvent,
  type NormalizedSessionExpiredEvent,
  type NormalizedSessionAsyncPaymentFailedEvent,
} from "./provider/payment-provider.interface";

/** Statuses with money still owed — DRAFT is not issued, PAID/VOID/WRITTEN_OFF owe nothing. */
const OPEN_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.OVERDUE,
];

/** Statuses that hold the account's "one open request at a time" slot — mirrors
 *  the partial unique index on (tenantId, customerId) added for invariant 8. */
const OPEN_REQUEST_STATUSES = ["PENDING", "SETTLING"] as const;

/** How long after it expired an EXPIRED request is still worth telling the
 *  buyer about — one Checkout session lifetime (24h), long enough to cover the
 *  buyer who comes back the day their link lapsed, short enough that an
 *  abandoned Checkout never greets them months later. */
const EXPIRED_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AllocationPreviewLine {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: Date;
  total: number;
  balanceDue: number;
  /** What this payment would put on the invoice (0 rows are dropped). */
  applied: number;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
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
 * approval (cash) or from `settleByPaymentIntent`, the ONLY entry point money
 * ever takes for a card request (invariant 1/5) — so payment numbering,
 * grouping and invoice status recompute stay in the one existing code path,
 * and a pending request can never move a balance (the DRAFT-payment trap).
 *
 * PROVIDER PORT (invariant 4): this service speaks only to `PaymentProvider`
 * (see `./provider/payment-provider.interface`) — typed, normalized requests
 * and events. It never imports the Stripe SDK, never reads a snake_case Stripe
 * field, and never depends on the SaaS billing module.
 *
 * CARD LIFECYCLE: PENDING -> SETTLING -> SETTLED (invariant 7). The claim
 * (PENDING/other -> SETTLING) happens before the money write and is what
 * makes a crash between "money recorded" and "row flipped" safe to redeliver:
 * a SETTLING row whose payment intent already has a matching InvoicePayment
 * completes the flip instead of recording twice. CASH stays on its own
 * PENDING -> APPROVED/REJECTED lane, decided by the operator.
 */
@Injectable()
export class PaymentRequestsService {
  private readonly logger = new Logger(PaymentRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly connect: StripeConnectService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly tenantContext: TenantContextService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  // ─── Allocation ─────────────────────────────────────────────────────────────

  /** Open invoices for a customer, oldest first, with live balances. */
  private async openInvoices(customerId: string): Promise<AllocationPreviewLine[]> {
    const rows = await this.prisma.forTenant().invoice.findMany({
      where: { customerId, status: { in: OPEN_STATUSES } },
      // F03/R1: CONFIRMED (PAID) rows only. These balances drive the oldest-first
      // allocation, so an unconfirmed DRAFT payment counted here would zero out an
      // invoice's balanceDue, drop it from the allocation, and misroute the buyer's
      // real payment into on-account credit — while every other read (findAll/
      // findOne/PDF/email) correctly still shows the money owed.
      include: { payments: { where: CONFIRMED_PAYMENT } },
      orderBy: [{ issueDate: "asc" }, { invoiceNumber: "asc" }],
    });
    return rows
      .map((inv) => {
        const paid = sumConfirmed(inv.payments);
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
    const [lines, account, open] = await Promise.all([
      this.openInvoices(customerId),
      this.connect.chargeableAccount(tenantId),
      this.prisma.buyerPaymentRequest.findMany({
        where: { tenantId, customerId, status: { in: [...OPEN_REQUEST_STATUSES] } },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const requests = open.length > 0 ? open : await this.latestExpiredRequest(tenantId, customerId);
    return {
      balanceDue: roundMoney(lines.reduce((s, l) => s + l.balanceDue, 0)),
      cardEnabled: !!account,
      openInvoices: lines,
      pendingRequests: requests.map((r) => this.toBuyerView(r)),
    };
  }

  /**
   * The buyer's most recent request, but ONLY when it EXPIRED and nothing has
   * happened since (invariant 13). Without it the panel has no way to say "your
   * payment link expired — start again": it derives its single request from
   * this list, so an abandoned Checkout would just re-render a blank amount
   * form with no explanation of where the previous link went. EXPIRED sits
   * outside the partial unique index, so handing one back here never blocks the
   * buyer from starting a new request — the panel treats it as a dismissible
   * notice, not an open request.
   *
   * BOUNDED BY RECENCY: the notice only answers "where did the link I just
   * started go?", so it is withheld once the expiry is older than
   * `EXPIRED_NOTICE_WINDOW_MS`. Without that bound a single abandoned Checkout
   * stays the buyer's newest request forever, and every future visit opens on a
   * months-stale "your payment link expired" banner instead of the amount form
   * (the panel's dismissal is component state, so it does not survive a reload).
   * `updatedAt` — not `createdAt` — is the anchor: a session lives 24h, so the
   * expiry webhook lands a day after the row was created.
   */
  private async latestExpiredRequest(tenantId: string, customerId: string) {
    const latest = await this.prisma.buyerPaymentRequest.findFirst({
      where: { tenantId, customerId },
      orderBy: { createdAt: "desc" },
    });
    if (!latest || latest.status !== "EXPIRED") return [];
    const expiredAt = (latest.updatedAt ?? latest.createdAt).getTime();
    return Date.now() - expiredAt <= EXPIRED_NOTICE_WINDOW_MS ? [latest] : [];
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

  private openRequestMessage(kind: "CARD" | "CASH"): string {
    return kind === "CASH"
      ? "You already have a payment awaiting the seller's approval. Cancel it first to submit a different one."
      : "You already have a card payment in progress. Cancel it first to start another.";
  }

  /**
   * Friendly pre-check — the authoritative guard is the partial unique index
   * on (tenantId, customerId) WHERE status IN (PENDING, SETTLING), which the
   * create() calls below also catch (invariant 8). This just avoids a wasted
   * Stripe round trip in the common case.
   */
  private async assertNoOpenRequest(tenantId: string, customerId: string) {
    const open = await this.prisma.buyerPaymentRequest.findFirst({
      where: { tenantId, customerId, status: { in: [...OPEN_REQUEST_STATUSES] } },
    });
    if (open) throw new BadRequestException(this.openRequestMessage(open.kind));
  }

  /**
   * `fromInvoiceId` is provenance-only (allocation is always oldest-first
   * across the account, never against this invoice specifically) but it still
   * becomes a real FK on the request row — verify it belongs to this
   * (tenant, customer) before it is ever persisted.
   */
  private async assertInvoiceBelongsToCustomer(customerId: string, invoiceId?: string | null) {
    if (!invoiceId) return;
    const invoice = await this.prisma.forTenant().invoice.findFirst({
      where: { id: invoiceId, customerId },
      select: { id: true },
    });
    if (!invoice) throw new BadRequestException("That invoice could not be found.");
  }

  /**
   * Start a card payment: a Stripe Checkout Session ON the tenant's connected
   * account. The amount is capped at the account balance so a card payment can
   * never mint on-account credit. The PENDING row exists before the redirect;
   * money moves only when `settleByPaymentIntent` proves the charge succeeded.
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
    await this.assertInvoiceBelongsToCustomer(params.customerId, params.fromInvoiceId);

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

    let request;
    try {
      request = await this.prisma.buyerPaymentRequest.create({
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
    } catch (err) {
      if (isUniqueConstraintViolation(err))
        throw new BadRequestException(this.openRequestMessage("CARD"));
      throw err;
    }

    const webUrl = (process.env.WEB_URL ?? "https://www.routeflow.info").replace(/\/$/, "");
    const backTo = `${webUrl}/buyer/portal/${params.tenantSlug}/payments`;
    const sellerName = config?.businessName ?? tenant?.name ?? "your seller";

    let checkout: HostedCheckoutSession;
    try {
      checkout = await this.provider.createHostedCheckout({
        accountRef: account,
        amountDollars: amount,
        currency: config?.currency ?? "USD",
        description: `Payment to ${sellerName} — applied to your oldest open invoices first`,
        customerEmail: customer.email ?? undefined,
        successUrl: `${backTo}?payment=processing`,
        cancelUrl: `${backTo}?payment=cancelled`,
        // Invariant 1: settleByPaymentIntent resolves the tenant from THIS
        // metadata (the adapter is responsible for placing it on the payment
        // intent, not just the session — see the WP1 port brief).
        metadata: { tenantId: params.tenantId, buyerPaymentRequestId: request.id },
      });
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
      data: { stripeSessionId: checkout.sessionId },
    });
    return { requestId: request.id, url: checkout.url, amount };
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
    await this.assertInvoiceBelongsToCustomer(params.customerId, params.fromInvoiceId);

    const customer = await this.prisma.forTenant().customer.findFirst({
      where: { id: params.customerId },
      select: { businessName: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    let request;
    try {
      request = await this.prisma.buyerPaymentRequest.create({
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
    } catch (err) {
      if (isUniqueConstraintViolation(err))
        throw new BadRequestException(this.openRequestMessage("CASH"));
      throw err;
    }
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

  /**
   * Cancel the buyer's own pending request.
   *
   * Invariant 5: cancelOwn NEVER writes money — settlement is reachable
   * exclusively from `settleByPaymentIntent` (the webhook's
   * payment_intent.succeeded branch). This method's only job around a CARD
   * request is to prove, via the provider, that the underlying session can
   * never be paid AFTER the cancel — and to refuse rather than guess when it
   * cannot prove that.
   *
   * Invariant 6: expireCheckout is attempted whenever a session id exists,
   * EVEN when the seller's account is not currently chargeable — an account
   * that lost `chargesEnabled` after Checkout was created can still have a
   * session sitting there that got paid. The provider's expire call re-reads
   * the session on failure and reports one of three outcomes:
   *   - "expired" / "already_expired" → the session can never be paid now;
   *     safe to cancel.
   *   - "already_completed" → the buyer already went through checkout, whether
   *     the charge has landed or is still processing (ACH stays `complete` +
   *     unpaid for days). Refuse the cancel and leave the row PENDING for the
   *     webhook to settle.
   * A session the provider cannot classify (still open, PaymentIntent in
   * flight) throws instead — caught below and refused, never cancelled.
   */
  async cancelOwn(buyerAccountId: string, customerId: string, requestId: string) {
    const request = await this.prisma.buyerPaymentRequest.findFirst({
      where: { id: requestId, buyerAccountId, customerId, status: "PENDING" },
    });
    if (!request) throw new NotFoundException("No pending request to cancel");

    if (request.kind === "CARD" && request.stripeSessionId) {
      // `lastKnownAccount`, NOT `getStatus`/`chargeableAccount`: those two
      // report null the moment the link is disconnected, and a seller who
      // disconnects Stripe (or whose account is deauthorized) while a card
      // request is open would otherwise lock the buyer out permanently — every
      // cancel refused for want of an account, and the open-request index
      // blocking any new request, cash included, until the 24h expiry webhook.
      // The session was created on that account and can still be expired there.
      const accountRef = await this.connect.lastKnownAccount(request.tenantId);
      if (!accountRef) {
        // No account id was ever stored — nothing left to check the session
        // against, so refuse rather than risk cancelling one that could still
        // be paid on Stripe's side.
        throw new BadRequestException(
          "Could not confirm the card payment's status. Please try again in a moment.",
        );
      }

      let outcome: ExpireCheckoutOutcome;
      try {
        ({ outcome } = await this.provider.expireCheckout(accountRef, request.stripeSessionId));
      } catch (err: any) {
        this.logger.warn(
          `Could not expire session ${request.stripeSessionId} before cancel: ${err?.message}`,
        );
        throw new BadRequestException(
          "Could not confirm the card payment's status. Please try again in a moment.",
        );
      }

      if (outcome === "already_completed") {
        throw new BadRequestException(
          "That card payment already went through — it is being applied to your account.",
        );
      }
      // "expired" or "already_expired" — falls through to the cancel below.
    }

    const claimed = await this.prisma.buyerPaymentRequest.updateMany({
      where: { id: requestId, tenantId: request.tenantId, status: "PENDING" },
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
        outcome: r.outcome,
        // The settled provider payment id (pi_…) — the operator's link from a
        // recorded payment back to the processor. Was populated but never
        // serialized until 2026-08-22.
        providerPaymentId: r.providerPaymentId,
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
      where: { id: requestId, tenantId, status: "PENDING" },
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
      const result = await this.invoices.recordStandalonePayment(
        {
          customerId: request.customerId,
          totalAmount: Number(request.amount),
          method: "CASH",
          reference: request.reference ?? undefined,
          notes: request.note ? `Buyer declared: ${request.note}` : "Buyer-declared cash payment",
          allocations,
          // Allocation computed outside the tx row locks — a stale preview must
          // roll back rather than overpay (carried from the #397 hardening).
        } as any,
        { assertAllocationsWithinBalance: true },
      );
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
   * payment_intent.succeeded — THE only event that ever writes money
   * (invariant 1). Runs with no request context: the tenant is resolved from
   * the payment intent's own metadata (set at Checkout creation), then the
   * whole settlement — including the eventual recordStandalonePayment call —
   * runs inside tenantContext.run so every access is tenant-scoped (mirrors
   * recurring-invoices.service.ts's cron pattern).
   *
   * Claim is PENDING/other -> SETTLING (invariant 7) BEFORE the money write,
   * so a crash between "money recorded" and "row flipped to SETTLED" can
   * never leave the row re-claimable as PENDING — which would double-charge
   * the buyer's invoices on redelivery. ANY row that already left PENDING is
   * completed (not re-recorded) once a matching payment is found by
   * `reference = payment intent id` (tenant-scoped) — that probe runs before
   * the claim, because the anomalous in-place settle below never occupies
   * SETTLING and so leaves no other trace that money is already in flight.
   *
   * `claimed.count === 0` is a benign replay only when the row is already
   * SETTLING/SETTLED. Any other terminal status (CANCELLED/FAILED/EXPIRED/
   * REJECTED) means Stripe actually charged the buyer for a request the
   * tenant considered closed — money is never silently discarded: it is
   * still recorded, and the row is force-flipped to SETTLED with an
   * `outcome` note for the operator to see. That force-claim can itself
   * collide with the replacement request the buyer opened after the cancel
   * (the partial unique index covers PENDING/SETTLING, which the terminal
   * status was not) — `settleWithoutClaim` catches that P2002 and records the
   * money without ever occupying the slot, because a 500 here would strand a
   * real charge with no InvoicePayment behind it.
   */
  async settleByPaymentIntent(evt: NormalizedPiSucceededEvent): Promise<{ handled: boolean }> {
    const tenantId = evt.metadata?.tenantId;
    const requestId = evt.metadata?.buyerPaymentRequestId;
    const piId = evt.paymentIntentId;
    if (!tenantId || !requestId || !piId) {
      this.logger.error(
        `CRITICAL: payment_intent.succeeded ${evt.eventId} is missing tenantId/buyerPaymentRequestId/paymentIntentId metadata — cannot settle`,
      );
      return { handled: false };
    }

    return this.tenantContext.run(tenantId, async () => {
      // Invariant 2 (anti-spoof): the event's account must be the account
      // actually connected to this tenant before anything is read or written.
      const accountOk = await this.connect.assertEventAccount(tenantId, evt.accountRef);
      if (!accountOk) {
        this.logger.error(
          `CRITICAL: payment_intent.succeeded ${evt.eventId} account mismatch for tenant ${tenantId} (event account ${evt.accountRef}) — refusing to settle`,
        );
        return { handled: false };
      }

      const request = await this.prisma.forTenant().buyerPaymentRequest.findFirst({
        where: { id: requestId },
      });
      if (!request) {
        this.logger.error(
          `CRITICAL: payment_intent.succeeded ${evt.eventId} references unknown request ${requestId} (tenant ${tenantId})`,
        );
        return { handled: false };
      }

      // Pure replay of an already-completed settlement.
      if (request.status === "SETTLED") return { handled: true };

      const priorStatus = request.status;
      const anomalous = priorStatus !== "PENDING" && priorStatus !== "SETTLING";

      if (priorStatus !== "PENDING") {
        // Redelivery against a row that already left PENDING: the money may be
        // on the ledger from an earlier attempt that died before the final
        // flip. Two shapes of that — a SETTLING crash path, and an anomalous
        // terminal row that `settleWithoutClaim` recorded IN PLACE (that path
        // never enters SETTLING, so the claim below is not its mutex and the
        // row carries no "money in flight" marker at all; by the time Stripe
        // redelivers, the replacement request may have freed the slot and the
        // claim would succeed, re-recording the same charge). The ledger probe
        // is the never-record-twice guarantee for both, so it runs BEFORE the
        // claim rather than only for SETTLING.
        const existing = await this.findRecordedPayment(piId);
        if (existing) {
          await this.completeAlreadyRecorded(requestId, priorStatus, piId, existing);
          return { handled: true };
        }
        // No payment recorded yet for this PI — fall through and claim it so
        // the money still gets written (an earlier delivery never finished).
      }

      if (anomalous) {
        this.logger.error(
          `CRITICAL: payment arrived for non-pending request ${requestId} (status was ${priorStatus}, PI ${piId}) — recording anyway`,
        );
      }

      let claimed: { count: number };
      try {
        claimed = await this.prisma.forTenant().buyerPaymentRequest.updateMany({
          where: { id: requestId, status: priorStatus },
          data: { status: "SETTLING", providerPaymentId: piId },
        });
      } catch (err) {
        // SETTLING is INSIDE the partial unique index on (tenantId,
        // customerId); a terminal status is not. The buyer is expected to open
        // a replacement request the moment the old one closes — that is the
        // whole point of CANCELLED/EXPIRED not holding the slot — so pulling
        // the closed row back into SETTLING can collide with the replacement
        // and raise P2002. Invariant 7 outranks the row's bookkeeping: settle
        // it in place instead of throwing the money away with a 500.
        if (!anomalous || !isUniqueConstraintViolation(err)) throw err;
        await this.settleWithoutClaim(request, evt, priorStatus, piId);
        return { handled: true };
      }

      if (claimed.count === 0) {
        // Lost a race to another concurrent delivery of the same event — that
        // delivery will finish the settlement.
        return { handled: true };
      }

      await this.writeSettlement(request, evt, priorStatus);
      return { handled: true };
    });
  }

  /**
   * Has the money for this payment intent already reached the ledger?
   *
   * `recordStandalonePayment` writes ZERO InvoicePayment rows when there is
   * nothing left to allocate against — the whole amount becomes an
   * `AdvancePayment` instead, which is exactly what happens when another
   * payment cleared the account between Checkout creation and settlement. An
   * InvoicePayment-only probe would miss that settlement entirely and record
   * it a second time, minting a duplicate on-account credit.
   */
  private async findRecordedPayment(
    piId: string,
  ): Promise<{ paymentGroupId: string | null } | null> {
    const payment = await this.prisma.forTenant().invoicePayment.findFirst({
      where: { reference: piId },
    });
    if (payment) return { paymentGroupId: payment.paymentGroupId ?? null };
    const advance = await this.prisma.forTenant().advancePayment.findFirst({
      where: { reference: piId },
    });
    // AdvancePayment carries no paymentGroupId — there are no payment rows to
    // group. The request still flips to SETTLED; the credit is the record.
    return advance ? { paymentGroupId: null } : null;
  }

  /**
   * Settle an anomalous (CANCELLED/EXPIRED/FAILED/REJECTED) request whose
   * SETTLING claim collided with the replacement request already holding the
   * open-request slot. The row never enters SETTLING, so it never contends for
   * that index — it goes straight to SETTLED with the anomaly note. Without the
   * claim acting as the mutex, the ledger probe IS the never-record-twice
   * guarantee — it already ran before the claim (and found nothing) and runs
   * again here, and the flip stays conditional on the row still sitting in
   * `priorStatus`.
   */
  private async settleWithoutClaim(
    request: { id: string; customerId: string; amount: Prisma.Decimal | number },
    evt: NormalizedPiSucceededEvent,
    priorStatus: BuyerPaymentRequestStatus,
    piId: string,
  ) {
    const existing = await this.findRecordedPayment(piId);
    if (existing) {
      await this.completeAlreadyRecorded(request.id, priorStatus, piId, existing);
      return;
    }
    await this.writeSettlement(request, evt, priorStatus, priorStatus);
  }

  /**
   * The money for this payment intent is already on the ledger: flip the row to
   * SETTLED without recording anything. The flip stays conditional on the row
   * still sitting in `priorStatus` so a concurrent delivery cannot double-apply
   * it, and it carries the anomaly note when the row was already closed.
   */
  private async completeAlreadyRecorded(
    requestId: string,
    priorStatus: BuyerPaymentRequestStatus,
    piId: string,
    existing: { paymentGroupId: string | null },
  ) {
    await this.prisma.forTenant().buyerPaymentRequest.updateMany({
      where: { id: requestId, status: priorStatus },
      data: {
        status: "SETTLED",
        providerPaymentId: piId,
        paymentGroupId: existing.paymentGroupId,
        outcome: this.anomalyOutcome(priorStatus),
        decidedByName: "Stripe",
        decidedAt: new Date(),
      },
    });
  }

  /** The operator-facing note for money that arrived against a closed row. */
  private anomalyOutcome(priorStatus: string): string | null {
    return priorStatus !== "PENDING" && priorStatus !== "SETTLING"
      ? `payment arrived for non-pending request (status was ${priorStatus})`
      : null;
  }

  /**
   * Writes the InvoicePayment for a claimed (SETTLING) request and flips it
   * to SETTLED. Invariant 9 (amount truth): the provider-reported amount is
   * authoritative whenever it disagrees with the request's amount by ≥ $0.01
   * — that is what was actually charged, so it is what gets recorded, never
   * `min(requestAmount, providerAmount)`.
   */
  private async writeSettlement(
    request: { id: string; customerId: string; amount: Prisma.Decimal | number },
    evt: NormalizedPiSucceededEvent,
    priorStatus: string,
    /** The status the final flip is conditional on — normally the SETTLING
     *  claim, but an anomalous row that could not hold the open-request slot
     *  (see `settleWithoutClaim`) flips straight out of its terminal status. */
    fromStatus: BuyerPaymentRequestStatus = "SETTLING",
  ) {
    const requestAmount = roundMoney(Number(request.amount));
    const providerAmount = roundMoney(evt.amountDollars);
    const mismatched = Math.abs(providerAmount - requestAmount) >= 0.01;
    const amountToRecord = mismatched ? providerAmount : requestAmount;

    if (mismatched) {
      this.logger.error(
        `CRITICAL: amount mismatch settling request ${request.id} — requested $${requestAmount.toFixed(2)}, Stripe charged $${providerAmount.toFixed(2)}. Recording the charged amount.`,
      );
    }

    const { allocations } = await this.buildOldestFirstAllocation(
      request.customerId,
      amountToRecord,
    );
    const method = evt.methodKind === "us_bank_account" ? "ACH" : "CREDIT_CARD";
    // Card clears immediately from the buyer's side (cash-basis reporting
    // falls back to paidAt); ACH settles at the moment Stripe confirms it.
    const settledAt = method === "ACH" ? evt.created.toISOString() : null;
    const notes = mismatched
      ? `Card payment via Stripe (amount discrepancy: requested $${requestAmount.toFixed(2)}, charged $${providerAmount.toFixed(2)} — recorded the charged amount)`
      : "Card payment via Stripe";

    const result = await this.invoices.recordStandalonePayment(
      {
        customerId: request.customerId,
        totalAmount: amountToRecord,
        method,
        reference: evt.paymentIntentId,
        notes,
        settledAt,
        allocations,
        // Stale-preview guard (carried from the #397 hardening): on conflict the
        // tx rolls back, the row STAYS SETTLING (never reopened), and Stripe's
        // redelivery recomputes a fresh allocation — converges without overpay.
      } as any,
      { assertAllocationsWithinBalance: true },
    );

    await this.prisma.forTenant().buyerPaymentRequest.updateMany({
      where: { id: request.id, status: fromStatus },
      data: {
        status: "SETTLED",
        providerPaymentId: evt.paymentIntentId,
        paymentGroupId: result.paymentGroupId,
        outcome: this.anomalyOutcome(priorStatus),
        decidedByName: "Stripe",
        decidedAt: new Date(),
      },
    });
  }

  /**
   * checkout.session.expired — invariant 10. An abandoned CARD request flips
   * to EXPIRED, which (unlike CANCELLED) does not hold the account's one-open-
   * request slot — the partial unique index only covers PENDING/SETTLING — so
   * the buyer can start a new one. Runs with no request context; the tenant is
   * resolved from the request row itself (found by the session id, which is
   * unique) rather than from `evt.metadata` — the row's own `tenantId` is what
   * was actually recorded at Checkout creation, so it needs no trust in
   * Stripe's metadata echo for this lookup.
   */
  async expireBySession(evt: NormalizedSessionExpiredEvent): Promise<{ handled: boolean }> {
    const request = await this.prisma.buyerPaymentRequest.findUnique({
      where: { stripeSessionId: evt.sessionId },
    });
    if (!request) {
      this.logger.warn(
        `No payment request for expired checkout session ${evt.sessionId} — ignoring`,
      );
      return { handled: false };
    }

    return this.tenantContext.run(request.tenantId, async () => {
      const accountOk = await this.connect.assertEventAccount(request.tenantId, evt.accountRef);
      if (!accountOk) {
        this.logger.error(
          `CRITICAL: checkout.session.expired ${evt.eventId} account mismatch for tenant ${request.tenantId} (event account ${evt.accountRef}) — refusing to apply`,
        );
        return { handled: false };
      }

      const claimed = await this.prisma.forTenant().buyerPaymentRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
      return { handled: claimed.count > 0 };
    });
  }

  /**
   * checkout.session.async_payment_failed — a delayed payment method (ACH
   * debit) that Stripe accepted at checkout and only failed days later. That
   * session is already `complete`, so `checkout.session.expired` never fires
   * for it: this is the ONLY event that can release the row. Without it the
   * request sits PENDING forever and the partial unique index (invariant 8)
   * locks the buyer out of ever starting another one.
   *
   * Only a PENDING row is touched — a SETTLING/SETTLED row means
   * `payment_intent.succeeded` already wrote the money (invariant 1), and a
   * late failure notice must never undo that. Tenant resolution mirrors
   * `expireBySession`: off the request row found by session id, not off
   * Stripe's metadata echo.
   */
  async failBySession(
    evt: NormalizedSessionAsyncPaymentFailedEvent,
  ): Promise<{ handled: boolean }> {
    const request = await this.prisma.buyerPaymentRequest.findUnique({
      where: { stripeSessionId: evt.sessionId },
    });
    if (!request) {
      this.logger.warn(
        `No payment request for failed checkout session ${evt.sessionId} — ignoring`,
      );
      return { handled: false };
    }

    return this.tenantContext.run(request.tenantId, async () => {
      const accountOk = await this.connect.assertEventAccount(request.tenantId, evt.accountRef);
      if (!accountOk) {
        this.logger.error(
          `CRITICAL: checkout.session.async_payment_failed ${evt.eventId} account mismatch for tenant ${request.tenantId} (event account ${evt.accountRef}) — refusing to apply`,
        );
        return { handled: false };
      }

      const claimed = await this.prisma.forTenant().buyerPaymentRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "FAILED",
          failureReason: "The bank payment did not go through. You can start a new payment.",
        },
      });
      return { handled: claimed.count > 0 };
    });
  }
}

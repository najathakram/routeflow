import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { CronExpression } from "@nestjs/schedule";
import { LeaderCron } from "../common/cron-lock";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { PrismaService } from "../prisma/prisma.service";
import { BillingEventService } from "./billing-event.service";
import { applyCouponStateTx } from "./coupon-state";
import { NO_COUPON } from "./coupon-unbilled";
import { lockTenantForLedger } from "./addon-ledger";
import {
  CATCHUP_LATE_ALERT_DAYS,
  CATCHUP_META,
  CATCHUP_ORPHAN_AFTER_MS,
  STRIPE_WEBHOOK_RETRY_DAYS,
  claimRefusal,
  invoiceDefinitivelyFailed,
  invoiceIsPaid,
  isCatchupSession,
  type InvoiceFacts,
} from "./catchup-claim";
import { paidThroughOf, supersededOpenInvoiceIds, type CatchupInvoice } from "./catchup-plan";
import {
  STRIPE_CHECKOUT_DUPLICATE_ACTION,
  STRIPE_CHECKOUT_ENTITY,
  STRIPE_CHECKOUT_REFUSED_ACTION,
} from "./config-snapshot-audit.constants";
import { writeAdminNotice } from "./manual-invoice-notice";
import {
  isLiveStripeSubscriptionStatus,
  stripeInvoiceSubscriptionId,
  stripeRefId,
} from "./stripe-period";
import { StripeService } from "./stripe.service";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The audit-notice kind that records the manual period at claim time, for the release to restore (a). */
const MANUAL_PERIOD_KIND = "billing_catchup_manual_period";

/** The claim columns, as one select/clear. */
const CLAIM_SELECT = {
  tenantId: true,
  stripeSubId: true,
  externalPayment: true,
  catchupState: true,
  catchupSessionId: true,
  catchupInvoiceId: true,
  updatedAt: true,
} as const;
const CLEAR_CLAIM = {
  catchupState: null,
  catchupSessionId: null,
  catchupInvoiceId: null,
} as const;

type ClaimRow = {
  tenantId: string;
  stripeSubId: string | null;
  externalPayment: boolean;
  catchupState: string | null;
  catchupSessionId: string | null;
  catchupInvoiceId: string | null;
  updatedAt: Date;
};

export type ReleaseOutcome =
  | "none" // no claim / not this claim
  | "settled" // the invoice turned out PAID: took the paid path
  | "deferred" // a payment is processing: nothing released
  | "released" // all steps done
  | "needs_ruling"; // the void was refused because the invoice is PAID

/**
 * The October catch-up CLAIM lifecycle (SA-733r3 N2, r4 N2(b)(c)(d)): the machinery around `catchupState` /
 * `catchupSessionId` / `catchupInvoiceId`. It owns the TWO moments that matter:
 *
 *   PAID    `invoice.paid` of the claim's `catchupInvoiceId` (the subscription equal to the row's non-null
 *           stripeSubId, r4 N1) voids the tenant's OPEN RfInvoices from paid-through on and clears the claim.
 *           NEVER at checkout completion (an ACH completion is `payment_status=unpaid`).
 *   FAILED  `checkout.session.expired` (CAS on the session id and SESSION_OPEN only - a `complete` session is
 *           never released), a definitively failed first invoice, or the hourly sweep: release in the r4 order
 *           (Step 0 re-read, Step 1 RELEASING, release tx, Step 2 void, Step 3 cancel, Step 4 clear).
 *
 * Every state change is a compare-and-set under the Tenant row lock (`lockTenantForLedger`, the house order).
 * Stripe is never called under that lock: the re-reads of Step 0 happen outside it and the CAS that follows
 * proves nothing moved in between.
 *
 * OPERATOR RUNBOOK - leaving a HELD claim (an amount mismatch or a foreign subscription: there is no route for it
 * by design): (1) in Stripe, decide what the tenant really paid; (2) void the superseded RfInvoices by hand
 * (platform-admin RfInvoice "void") ONLY for periods the card subscription now covers; (3) then, with a fresh
 * backup, clear the claim in ONE statement: UPDATE "TenantSubscription" SET "catchupState"=NULL,
 * "catchupSessionId"=NULL, "catchupInvoiceId"=NULL WHERE "tenantId"=<id> AND "catchupState" IS NOT NULL (keep the
 * card subscription), or - to go
 * back to manual invoicing - cancel the Stripe subscription first and also set "stripeSubId"=NULL,
 * "externalPayment"=true in that statement. Never clear it while an invoice is still unpaid and retrying.
 *
 * What is NOT here: the dunning skip (N2(a)), pause/resume and `pause_collection` - PR-B3.
 */
@Injectable()
export class CatchupClaimService {
  private readonly logger = new Logger(CatchupClaimService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly events: BillingEventService,
  ) {}

  // ─── helpers ──────────────────────────────────────────────────────────────

  private inTenantTx<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await lockTenantForLedger(tx, tenantId);
      return fn(tx);
    });
  }

  private notice(
    tx: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    kind: string,
    message: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    return writeAdminNotice(tx, {
      tenantId,
      action: AdminAuditAction.TENANT_CONFIG_UPDATED,
      message,
      meta: { kind, ...meta },
    });
  }

  private readClaim(tx: Prisma.TransactionClient | PrismaService, tenantId: string) {
    return tx.tenantSubscription.findUnique({
      where: { tenantId },
      select: CLAIM_SELECT,
    }) as Promise<ClaimRow | null>;
  }

  /** A notice written at most once per (kind, key): an hourly sweep must not re-raise the same NEEDS RULING forever. */
  private async noticeOnce(
    db: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    kind: string,
    key: string,
    message: string,
    meta: Record<string, unknown> = {},
  ): Promise<boolean> {
    const seen = await db.auditLog.findFirst({
      where: {
        tenantId,
        entityType: ADMIN_AUDIT_ENTITY,
        action: AdminAuditAction.TENANT_CONFIG_UPDATED,
        AND: [
          { meta: { path: ["kind"], equals: kind } },
          { meta: { path: ["dedupeKey"], equals: key } },
        ],
      },
      select: { id: true },
    });
    if (seen) return false;
    await this.notice(db, tenantId, kind, message, { ...meta, dedupeKey: key });
    return true;
  }

  /**
   * Is this claim's settling invoice really the catch-up's money? (Opus B1 + SHOULD-FIX 2.) Fails closed:
   *  - "foreign": the invoice's subscription is not the one the claim's Checkout session created - e.g. an ORDINARY
   *    subscription completed while the claim was SESSION_OPEN. Never adopted, never settles.
   *  - "hold": the invoice does not carry the amount the session promised (trial_one_time / prepaid stub =
   *    `catchup_stub_cents`): a Stripe deviation. A NEEDS RULING notice (once) and the claim is HELD, not cleared.
   *  - "ok".
   */
  private async verifyClaimSettlement(
    row: ClaimRow,
    facts: InvoiceFacts | null,
    invoiceId: string | null,
  ): Promise<"ok" | "foreign" | "hold"> {
    if (!row.catchupSessionId || !row.stripeSubId) return "foreign";
    const session = await this.stripe.getCheckoutSession(row.catchupSessionId);
    if (stripeRefId(session?.subscription) !== row.stripeSubId) {
      // An unrelated subscription's invoice on a tenant whose claim is held is unusual (ordinary checkouts are
      // refused while a claim is held): say so once, per invoice.
      if (invoiceId) {
        await this.noticeOnce(
          this.prisma,
          row.tenantId,
          "billing_catchup_foreign_invoice",
          invoiceId,
          `NEEDS RULING: invoice ${invoiceId} was paid on subscription ${row.stripeSubId}, which is not the subscription the catch-up Checkout created. It was NOT treated as the catch-up payment and nothing was voided.`,
          { invoiceId, storedSubscriptionId: row.stripeSubId },
        ).catch(() => undefined);
      }
      return "foreign";
    }
    const meta = session?.metadata ?? {};
    const shape = meta[CATCHUP_META.shape];
    const expected = Number(meta[CATCHUP_META.stubCents] ?? 0);
    if (
      (shape === "trial_one_time" || shape === "trial") &&
      Number.isInteger(expected) &&
      expected > 0
    ) {
      const got = facts ? (facts.amountPaid > 0 ? facts.amountPaid : facts.amountDue) : null;
      if (got !== expected) {
        await this.noticeOnce(
          this.prisma,
          row.tenantId,
          "billing_catchup_amount_mismatch",
          invoiceId ?? row.catchupSessionId,
          `NEEDS RULING: the catch-up invoice ${invoiceId ?? "(unknown)"} was paid for ${got ?? "an unknown amount"} cents but the session promised ${expected}. The claim is HELD and nothing was voided; check Stripe.`,
          { invoiceId, expectedCents: expected, gotCents: got },
        ).catch(() => undefined);
        this.logger.error(
          `billing.catchup.amount_mismatch tenant=${row.tenantId} invoice=${invoiceId} expected=${expected} got=${got}: claim HELD`,
        );
        return "hold";
      }
    }
    return "ok";
  }

  // ─── opening a claim (called by the catch-up checkout) ────────────────────

  /**
   * Written under the Tenant FOR UPDATE BEFORE any Stripe call. Refuses a tenant that already holds a claim
   * (409 CATCHUP_SESSION_OPEN / CATCHUP_PENDING), already has a Stripe subscription (census first) or is not on
   * manual invoicing.
   */
  async openClaim(tenantId: string): Promise<void> {
    await this.inTenantTx(tenantId, async (tx) => {
      const row = await this.readClaim(tx, tenantId);
      if (!row) throw new NotFoundException("Tenant has no subscription row.");
      const held = claimRefusal(row.catchupState);
      if (held) throw held;
      if (row.stripeSubId) {
        throw new ConflictException({
          code: API_ERROR_CODES.CATCHUP_NEEDS_RULING,
          message:
            "NEEDS RULING: this tenant already has a Stripe subscription: no catch-up checkout.",
        });
      }
      if (!row.externalPayment) {
        throw new ConflictException({
          code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE,
          message: "This tenant is not on manual invoicing: no catch-up checkout.",
        });
      }
      const { count } = await tx.tenantSubscription.updateMany({
        where: { tenantId, catchupState: null, stripeSubId: null },
        data: { catchupState: "SESSION_OPEN" },
      });
      if (count !== 1) throw claimRefusal("SESSION_OPEN")!;
      // (a) The ordinary completion overwrites periodStart / periodEnd with Stripe's trial window. A RELEASE must put
      // the manual window back or RouteFlow invoicing would resume AFTER it and the window would never be billed.
      // No column for it (no schema change), so it rides the audit trail, in this same transaction.
      const period = (await tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: { periodStart: true, periodEnd: true },
      })) as { periodStart?: Date | null; periodEnd?: Date | null } | null;
      await this.notice(
        tx,
        tenantId,
        MANUAL_PERIOD_KIND,
        "October catch-up claim opened; the manual subscription period is recorded so a release can restore it.",
        {
          periodStart: period?.periodStart ? period.periodStart.toISOString() : null,
          periodEnd: period?.periodEnd ? period.periodEnd.toISOString() : null,
        },
      );
    });
  }

  /** The Stripe session exists: store its id (CAS: still SESSION_OPEN with no session yet). */
  async attachSession(tenantId: string, sessionId: string): Promise<void> {
    await this.inTenantTx(tenantId, async (tx) => {
      await tx.tenantSubscription.updateMany({
        where: { tenantId, catchupState: "SESSION_OPEN", catchupSessionId: null },
        data: { catchupSessionId: sessionId },
      });
    });
  }

  /** Session creation failed at Stripe: nothing exists, the claim just taken is dropped. */
  async abortClaim(tenantId: string): Promise<void> {
    await this.inTenantTx(tenantId, async (tx) => {
      await tx.tenantSubscription.updateMany({
        where: { tenantId, catchupState: "SESSION_OPEN", catchupSessionId: null },
        data: { ...CLEAR_CLAIM },
      });
    });
  }

  // ─── RfInvoice side: refusing writes while a claim is held ────────────────

  /**
   * Called INSIDE an RfInvoice transaction (markPaid / reopen), after the Tenant row lock: refuses with the coded
   * 409 while a claim is held, so a payment cannot be recorded behind a Stripe charge.
   */
  async assertNoClaimTx(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    const row = (await tx.tenantSubscription.findUnique({
      where: { tenantId },
      select: { catchupState: true },
    })) as { catchupState: string | null } | null;
    const refusal = claimRefusal(row?.catchupState);
    if (refusal) throw refusal;
  }

  // ─── webhook entry points (every one idempotent) ──────────────────────────

  /**
   * `checkout.session.completed` of a catch-up session, AFTER the ordinary completion has stored the Stripe
   * subscription. Advances SESSION_OPEN -> AWAITING_FIRST_PAYMENT, sets `externalPayment=false` (manual invoicing
   * stops), and records the invoice whose payment will settle the claim - persisted BEFORE it can be paid (the
   * trial stub is created as a draft first) - then settles at once if it is already paid (r4 N2(c)).
   */
  async onSessionCompleted(session: any): Promise<void> {
    if (!isCatchupSession(session)) return;
    const tenantId: string | undefined = session.metadata?.tenantId;
    const subId = stripeRefId(session.subscription);
    if (!tenantId || !subId || !session.id) return;

    const advanced = await this.inTenantTx(tenantId, async (tx) => {
      const row = await this.readClaim(tx, tenantId);
      // The ordinary completion did not apply this subscription (refused, duplicate, parked): nothing to advance.
      if (!row || row.stripeSubId !== subId) return null;
      const mine = row.catchupSessionId === session.id || row.catchupSessionId == null;
      if (row.catchupState === "SESSION_OPEN" && mine) {
        await tx.tenantSubscription.updateMany({
          where: { tenantId, catchupState: "SESSION_OPEN", stripeSubId: subId },
          data: {
            catchupState: "AWAITING_FIRST_PAYMENT",
            catchupSessionId: session.id,
            externalPayment: false,
          },
        });
        return { ...row, catchupState: "AWAITING_FIRST_PAYMENT", catchupSessionId: session.id };
      }
      if (row.catchupState === "AWAITING_FIRST_PAYMENT" && row.catchupSessionId === session.id) {
        return row; // a redelivery: carry on to the (idempotent) invoice step
      }
      return null;
    });
    if (!advanced) return;

    // Stripe work, OUTSIDE the lock.
    let invoiceId = advanced.catchupInvoiceId;
    if (!invoiceId) invoiceId = await this.ensureSettlingInvoice(tenantId, session, subId);
    else await this.ensureStubItem(tenantId, session, invoiceId, subId); // a redelivery: the draft must carry its item
    if (!invoiceId) return; // settles on the first paid invoice (see onInvoicePaid)

    const facts = await this.stripe.getInvoiceFacts(invoiceId);
    if (invoiceIsPaid(facts)) await this.settle(tenantId, subId, facts);
  }

  /**
   * The invoice that settles the claim (r4 N2(c)): the TRIAL STUB when the session carries one (a draft
   * `invoices.create` with `automatically_finalizes_at` = the paid-through date, then its one item), else the
   * subscription's first non-zero invoice if it already exists. Persisted on the claim before it can be paid.
   * A $0 trial invoice is never the settling one.
   */
  private async ensureSettlingInvoice(
    tenantId: string,
    session: any,
    subId: string,
  ): Promise<string | null> {
    const meta = session.metadata ?? {};
    // trial_one_time (SA-733r5): the invoice Checkout created at completion carries the one-time line -
    // `session.invoice` (else the subscription's latest). Persisted before it can be paid; the $0 trial lines
    // ride the same invoice, so there is no separate $0 invoice to ignore.
    if (meta[CATCHUP_META.shape] === "trial_one_time") {
      const sub = await this.stripe.getSubscription(subId);
      const id = stripeRefId(session.invoice) ?? stripeRefId(sub?.latest_invoice);
      if (!id) return null; // settles on the first paid invoice with money (onInvoicePaid / the sweep)
      await this.setInvoiceId(tenantId, session.id, id);
      return id;
    }
    const stubCents = Number(meta[CATCHUP_META.stubCents] ?? 0);
    if (meta[CATCHUP_META.shape] === "trial" && Number.isInteger(stubCents) && stubCents > 0) {
      const sub = await this.stripe.getSubscription(subId);
      const finalizeAt = this.stubFinalizeAt(session, meta);
      const draft = await this.stripe.client.invoices.create(
        {
          customer: stripeRefId(session.customer) ?? stripeRefId(sub?.customer),
          subscription: subId,
          auto_advance: true,
          collection_method: "charge_automatically",
          ...(stripeRefId(sub?.default_payment_method)
            ? { default_payment_method: stripeRefId(sub.default_payment_method) }
            : {}),
          automatically_finalizes_at: finalizeAt,
          metadata: { catchup_for: session.id, tenantId },
        },
        { idempotencyKey: `${tenantId}:trial-stub:${session.id}` },
      );
      // Persist the id while the invoice is still a draft.
      await this.setInvoiceId(tenantId, session.id, draft.id);
      await this.ensureStubItem(tenantId, session, draft.id, subId);
      return draft.id;
    }
    // No stub: the first invoice with money on it, if Stripe already made one (otherwise onInvoicePaid adopts it).
    const sub = await this.stripe.getSubscription(subId);
    const latest = stripeRefId(sub?.latest_invoice);
    if (!latest) return null;
    const facts = await this.stripe.getInvoiceFacts(latest);
    if (facts.amountDue > 0 || facts.amountPaid > 0) {
      await this.setInvoiceId(tenantId, session.id, latest);
      return latest;
    }
    return null;
  }

  /**
   * (d) When the prepaid stub's draft invoice finalizes. r3 N3: 12:00Z of the paid-through day - but Stripe rejects
   * a past timestamp. The floor used to be `now + 1 h` read at call time, so a REDELIVERY computed a different
   * value under the same idempotency key (`:trial-stub:<session>`) and Stripe answered with an idempotency error.
   * The floor is now derived from the SESSION alone: its expiry + Stripe's whole webhook retry window + 1 h. A
   * completion can only arrive before the session expires and is retried for at most that window afterwards, so the
   * value is the same on every delivery AND still in the future on the last one. (A session with no expiry - only a
   * hand-built one - keeps the old call-time floor.) At worst this delays the stub's finalize by about a day when the
   * paid-through date is within ~4 days of the checkout; the subscription itself is in its trial until then.
   */
  private stubFinalizeAt(session: any, meta: Record<string, string>): number {
    const planned = Number(meta[CATCHUP_META.finalizeAt]) || 0;
    const expiresAt = Number(session?.expires_at);
    const floor =
      Number.isFinite(expiresAt) && expiresAt > 0
        ? expiresAt + STRIPE_WEBHOOK_RETRY_DAYS * 24 * 3600 + 3600
        : Math.floor(Date.now() / 1000) + 3600;
    return Math.max(planned, floor);
  }

  /**
   * The prepaid-trial stub's ONE item, created on the DRAFT invoice. Idempotent and re-runnable (Opus SHOULD-FIX 1): a
   * crash between `invoices.create` and `invoiceItems.create` leaves a persisted draft id and a redelivery skips the
   * creation step - so every completion delivery calls this, and it adds the item (same idempotency key) whenever the
   * draft is still a draft that does not yet carry the stub. A no-op for any other shape or an already-complete draft.
   */
  private async ensureStubItem(
    tenantId: string,
    session: any,
    invoiceId: string,
    subId: string,
  ): Promise<void> {
    const meta = session.metadata ?? {};
    const stubCents = Number(meta[CATCHUP_META.stubCents] ?? 0);
    if (meta[CATCHUP_META.shape] !== "trial" || !Number.isInteger(stubCents) || stubCents <= 0)
      return;
    const facts = await this.stripe.getInvoiceFacts(invoiceId);
    if (facts.status !== "draft") return;
    // Detected by the item's own TAG (`metadata.catchup_for = session.id`), never by the invoice amount: a Stripe-side
    // coupon lowers amountDue, and a redelivery after the idempotency key expired (24 h) would add a SECOND stub.
    const items = await this.stripe.listInvoiceItems(invoiceId);
    if (items.some((i) => i?.metadata?.catchup_for === session.id)) return;
    const sub = await this.stripe.getSubscription(subId);
    await this.stripe.client.invoiceItems.create(
      {
        customer: stripeRefId(session.customer) ?? stripeRefId(sub?.customer),
        invoice: invoiceId,
        amount: stubCents,
        currency: "usd",
        description: String(meta[CATCHUP_META.stubLabel] ?? "Subscription — catch-up"),
        metadata: { catchup_for: session.id, tenantId },
      },
      { idempotencyKey: `${tenantId}:trial-stub-item:${session.id}` },
    );
  }

  private async setInvoiceId(
    tenantId: string,
    sessionId: string,
    invoiceId: string,
  ): Promise<void> {
    await this.inTenantTx(tenantId, async (tx) => {
      await tx.tenantSubscription.updateMany({
        where: {
          tenantId,
          catchupSessionId: sessionId,
          catchupState: "AWAITING_FIRST_PAYMENT",
          catchupInvoiceId: null,
        },
        data: { catchupInvoiceId: invoiceId },
      });
    });
  }

  /**
   * `checkout.session.expired`: release ONLY by CAS on `catchupSessionId = event.session.id AND
   * catchupState = SESSION_OPEN` (r4 #8). A session that completed is never released here.
   */
  async onSessionExpired(session: any): Promise<void> {
    if (!isCatchupSession(session) || !session?.id) return;
    const tenantId: string | undefined = session.metadata?.tenantId;
    if (!tenantId) return;
    await this.inTenantTx(tenantId, async (tx) => {
      const { count } = await tx.tenantSubscription.updateMany({
        where: { tenantId, catchupSessionId: session.id, catchupState: "SESSION_OPEN" },
        data: { ...CLEAR_CLAIM },
      });
      if (count === 1) {
        await this.notice(
          tx,
          tenantId,
          "billing_catchup_session_expired",
          "The October catch-up checkout expired unpaid; the claim was released and manual invoicing continues.",
          { sessionId: session.id },
        );
      }
    });
  }

  /**
   * `invoice.paid`. Settles a held claim when it is the claim's invoice: the subscription must equal the row's
   * NON-NULL stripeSubId (r4 N1 - `invoice.subscription` is absent under dahlia), and either the invoice is the
   * stored `catchupInvoiceId`, or none is stored yet and this one carries money (the first paid invoice is then
   * adopted). A $0 invoice is ignored.
   */
  async onInvoicePaid(invoice: any): Promise<void> {
    const subId = stripeInvoiceSubscriptionId(invoice);
    if (!subId || !invoice?.id) return;
    const row = (await this.prisma.tenantSubscription.findFirst({
      where: { stripeSubId: subId, catchupState: { not: null } },
      select: CLAIM_SELECT,
    })) as ClaimRow | null;
    if (!row || !row.stripeSubId || row.stripeSubId !== subId) return;
    if (row.catchupState === "RELEASING") return; // the release owns it (its Step 0 handles a paid invoice)

    const isClaimInvoice = row.catchupInvoiceId === invoice.id;
    const isFirstMoney =
      row.catchupInvoiceId == null &&
      Number.isFinite(invoice.amount_paid) &&
      invoice.amount_paid > 0;
    if (!isClaimInvoice && !isFirstMoney) return;
    // Opus B1: nothing is adopted or settled until the invoice is proven to belong to the SESSION's subscription
    // (settle verifies; a foreign subscription's first invoice - e.g. an ordinary checkout completed while the
    // claim was SESSION_OPEN - voids nothing and is not recorded on the claim).
    await this.settle(
      row.tenantId,
      subId,
      await this.stripe.getInvoiceFacts(invoice.id),
      invoice.id,
    );
  }

  private async setInvoiceIdBySub(
    tenantId: string,
    subId: string,
    invoiceId: string,
  ): Promise<void> {
    await this.inTenantTx(tenantId, async (tx) => {
      await tx.tenantSubscription.updateMany({
        where: {
          tenantId,
          stripeSubId: subId,
          catchupInvoiceId: null,
          catchupState: { not: null },
        },
        data: { catchupInvoiceId: invoiceId },
      });
    });
  }

  /**
   * `invoice.payment_failed`: release when the claim's invoice has DEFINITIVELY failed (no next attempt). A
   * failure Stripe will retry changes nothing.
   */
  async onPaymentFailed(invoice: any): Promise<void> {
    const subId = stripeInvoiceSubscriptionId(invoice);
    if (!subId || !invoice?.id) return;
    const row = (await this.prisma.tenantSubscription.findFirst({
      where: { stripeSubId: subId, catchupState: "AWAITING_FIRST_PAYMENT" },
      select: CLAIM_SELECT,
    })) as ClaimRow | null;
    if (!row || row.stripeSubId !== subId) return;
    if (row.catchupInvoiceId && row.catchupInvoiceId !== invoice.id) return;
    // Re-read: the event is only a hint (r3 M8-style) - Stripe decides whether it is definitive.
    const facts = await this.stripe.getInvoiceFacts(invoice.id);
    if (!invoiceDefinitivelyFailed(facts)) return;
    // No settling invoice stored yet: THIS is the failed one - record it first so the release (Step 2) voids it.
    if (!row.catchupInvoiceId) await this.setInvoiceIdBySub(row.tenantId, subId, invoice.id);
    await this.release(row.tenantId, {
      sessionId: row.catchupSessionId,
      reason: "first_payment_failed",
    });
  }

  // ─── the PAID path ────────────────────────────────────────────────────────

  /**
   * Void the tenant's OPEN RfInvoices from paid-through on and clear the claim, in ONE transaction under the
   * Tenant lock. CAS on the claim being still held for this subscription: a replay finds nothing and does nothing.
   * A tenant whose RfInvoices cannot be placed (a PAID invoice after a gap) voids nothing and says so (NEEDS
   * RULING) - the claim still clears, because the customer has paid.
   */
  async settle(
    tenantId: string,
    subId: string,
    facts: InvoiceFacts | null = null,
    invoiceId: string | null = null,
  ): Promise<boolean> {
    // Verified OUTSIDE the lock (a Stripe read), then re-proved by the CAS below. AWAITING_FIRST_PAYMENT already
    // means "the session's own subscription is stored"; SESSION_OPEN settles only for the session's own sub.
    const seen = await this.readClaim(this.prisma, tenantId);
    if (
      !seen ||
      seen.stripeSubId !== subId ||
      !(seen.catchupState === "AWAITING_FIRST_PAYMENT" || seen.catchupState === "SESSION_OPEN")
    ) {
      return false;
    }
    const settling = invoiceId ?? seen.catchupInvoiceId;
    const f = facts ?? (settling ? await this.stripe.getInvoiceFacts(settling) : null);
    const verdict = await this.verifyClaimSettlement(seen, f, settling);
    if (verdict !== "ok") return false;

    return this.inTenantTx(tenantId, async (tx) => {
      const row = await this.readClaim(tx, tenantId);
      if (
        !row ||
        row.stripeSubId !== subId ||
        row.catchupSessionId !== seen.catchupSessionId ||
        !(row.catchupState === "AWAITING_FIRST_PAYMENT" || row.catchupState === "SESSION_OPEN")
      ) {
        return false;
      }
      const voided = await this.voidSupersededTx(tx, tenantId, "billing_catchup_settled");
      await tx.tenantSubscription.updateMany({
        where: { tenantId, stripeSubId: subId, catchupState: row.catchupState },
        // the successful conversion: manual invoicing is OFF for good (so dunning, B3, applies from here). Completion
        // wrote it already; settlement states it again so it never depends on completion alone.
        data: { ...CLEAR_CLAIM, externalPayment: false },
      });
      await this.notice(
        tx,
        tenantId,
        "billing_catchup_settled",
        `The October catch-up is paid; ${voided} RouteFlow invoice(s) voided and the claim cleared.`,
        { voided },
      );
      return true;
    });
  }

  /**
   * The ONE rule for which RfInvoices a card subscription supersedes (settle AND the ordinary-checkout
   * conversion): every OPEN invoice whose (snapped) period END is after paid-through - the subscription bills from
   * paid-through on, so each is a second charge. Inside the caller's Tenant-locked transaction; the `status = OPEN`
   * CAS makes it idempotent. A PAID invoice after a gap voids NOTHING and raises NEEDS RULING. Returns the count.
   */
  private async voidSupersededTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    reason: string,
  ): Promise<number> {
    const invoices = (await tx.rfInvoice.findMany({
      where: { tenantId, status: { in: ["OPEN", "PAID"] } },
      select: {
        id: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        periodKey: true,
        number: true,
      },
    })) as (CatchupInvoice & { periodKey: string | null; number: string })[];
    const pt = paidThroughOf(invoices);
    if (!pt.ok) {
      await this.notice(
        tx,
        tenantId,
        "billing_catchup_needs_ruling",
        `The card subscription is paid but this tenant's RouteFlow invoices could not be placed (${pt.reason}); none were voided. NEEDS RULING.`,
        { reason: pt.reason },
      );
      return 0;
    }
    const targets = new Set(supersededOpenInvoiceIds(invoices, pt.paidThrough).void);
    let voided = 0;
    for (const inv of invoices) {
      if (!targets.has(inv.id)) continue;
      const { count } = await tx.rfInvoice.updateMany({
        where: { id: inv.id, status: "OPEN" },
        data: {
          status: "VOID",
          voidedAt: new Date(),
          voidReason: "Superseded by the card subscription.",
          ...(inv.periodKey ? { periodKey: `${inv.periodKey}:void:${inv.id}` } : {}),
        },
      });
      if (count === 1) {
        voided++;
        await writeAdminNotice(tx, {
          tenantId,
          action: AdminAuditAction.RF_INVOICE_VOIDED,
          message: `RouteFlow invoice ${inv.number} voided: superseded by the card subscription.`,
          meta: { invoiceId: inv.id, number: inv.number, reason },
        });
      }
    }
    return voided;
  }

  // RULING (item 8): there is NO ordinary-checkout conversion path for a manual-pay tenant. An ordinary card
  // checkout by an `externalPayment` tenant is refused (409 EXTERNAL_PAYMENT_USE_CATCHUP, billing.service
  // createCheckoutSession); the catch-up is the ONLY card path for them, and `voidSupersededTx` runs ONLY from
  // `settle` (pinned by catchup-claim.service.spec). An `invoice.paid` for a subscription with no held claim
  // therefore voids nothing, whatever the tenant's flags.

  // ─── the RELEASE path (r4 N2(b)) ──────────────────────────────────────────

  /**
   * Step 0 (re-read; paid -> the paid path, processing -> do not release) -> Step 1 RELEASING -> release tx
   * (`stripeSubId = null`, `externalPayment = true`) -> Step 2 void `catchupInvoiceId` (refused because PAID: do
   * not cancel, alert NEEDS RULING) -> Step 3 cancel the subscription (its deleted event matches no row) -> Step 4
   * clear. `sessionId` pins which claim is meant (null = whatever is held).
   */
  async release(
    tenantId: string,
    opts: { sessionId?: string | null; reason: string },
  ): Promise<ReleaseOutcome> {
    // ── Step 0: the claim as it stands, then Stripe's view of it (no Stripe call under the lock) ──
    const seen = await this.inTenantTx(tenantId, (tx) => this.readClaim(tx, tenantId));
    if (!seen || !seen.catchupState) return "none";
    if (
      opts.sessionId !== undefined &&
      opts.sessionId !== null &&
      seen.catchupSessionId !== opts.sessionId
    )
      return "none";

    if (seen.catchupState !== "RELEASING" && seen.catchupInvoiceId) {
      const facts = await this.stripe.getInvoiceFacts(seen.catchupInvoiceId);
      if (invoiceIsPaid(facts)) {
        // A refused settle (held amount mismatch / foreign subscription) is NOT "settled": the claim is still held.
        const done = seen.stripeSubId
          ? await this.settle(tenantId, seen.stripeSubId, facts, seen.catchupInvoiceId)
          : false;
        return done ? "settled" : "needs_ruling";
      }
      if (facts.paymentProcessing) return "deferred";
    }

    // The subscription to cancel: the stored one while it is still stored, else the session's (the release tx
    // clears the column, the claim keeps the session id).
    let subId: string | null = seen.stripeSubId;
    if (!subId && seen.catchupSessionId && seen.catchupState !== "SESSION_OPEN") {
      subId = stripeRefId(
        (await this.stripe.getCheckoutSession(seen.catchupSessionId))?.subscription,
      );
    }

    // ── Step 1 (+ the release tx) ──
    const proceed = await this.inTenantTx(tenantId, async (tx) => {
      const cur = await this.readClaim(tx, tenantId);
      if (
        !cur ||
        cur.catchupState !== seen.catchupState ||
        cur.catchupSessionId !== seen.catchupSessionId ||
        cur.catchupInvoiceId !== seen.catchupInvoiceId
      ) {
        return false; // moved while Stripe was being read: let the next trigger judge it again
      }
      if (cur.catchupState === "SESSION_OPEN") {
        // nothing exists beyond the session: the claim simply goes
        await tx.tenantSubscription.updateMany({
          where: { tenantId, catchupState: "SESSION_OPEN", catchupSessionId: cur.catchupSessionId },
          data: { ...CLEAR_CLAIM },
        });
        return false;
      }
      if (cur.catchupState === "AWAITING_FIRST_PAYMENT") {
        await tx.tenantSubscription.updateMany({
          where: { tenantId, catchupState: "AWAITING_FIRST_PAYMENT" },
          data: { catchupState: "RELEASING" },
        });
      }
      return true;
    });
    if (!proceed) {
      const after = await this.inTenantTx(tenantId, (tx) => this.readClaim(tx, tenantId));
      return after?.catchupState ? "none" : "released";
    }

    await this.inTenantTx(tenantId, async (tx) => {
      // the release tx: the tenant goes back to manual invoicing (RF invoicing resumes - RF_INVOICE_CANDIDATE_WHERE)
      const { count } = await tx.tenantSubscription.updateMany({
        where: { tenantId, catchupState: "RELEASING", ...(subId ? { stripeSubId: subId } : {}) },
        data: { stripeSubId: null, externalPayment: true },
      });
      // b2b review: the coupon columns never outlive their subscription, and coupon-state.ts is their ONLY
      // writer - so the release resets them THROUGH it (Tenant lock held, MRR booked once if it crosses).
      if (count === 1) {
        await applyCouponStateTx(tx, this.events, tenantId, NO_COUPON, {
          reason: "catchup_released",
          tenantLockHeld: true,
        });
        await this.restoreManualPeriodTx(tx, tenantId);
      }
    });

    // ── Step 2: void the settling invoice (a draft stub is deleted; a PAID one is never touched) ──
    if (seen.catchupInvoiceId) {
      const invoiceId = seen.catchupInvoiceId;
      const refusedBecausePaid = async (): Promise<ReleaseOutcome> => {
        // PAID after we decided to release: do NOT cancel; a human refunds / rules.
        // once per invoice: the hourly sweep retries a RELEASING row and must not re-raise this forever
        const first = await this.noticeOnce(
          this.prisma,
          tenantId,
          "billing_catchup_release_refused_paid",
          invoiceId,
          "NEEDS RULING: the October catch-up invoice was PAID while its claim was being released. The " +
            "subscription was NOT cancelled; refund or re-attach it in Stripe.",
          { invoiceId },
        ).catch(() => false);
        if (first) {
          this.logger.error(
            `billing.catchup.release_refused_paid tenant=${tenantId} invoice=${invoiceId}: NEEDS RULING (refund)`,
          );
        }
        return "needs_ruling";
      };
      const facts = await this.stripe.getInvoiceFacts(invoiceId);
      if (invoiceIsPaid(facts)) return refusedBecausePaid();
      try {
        if (facts.status === "draft") await this.stripe.deleteDraftInvoice(invoiceId);
        else if (facts.status === "open") await this.stripe.voidInvoice(invoiceId);
        // void / uncollectible / unknown to Stripe: nothing to void
      } catch (err) {
        // refused: re-read - if it was paid in the meantime this is the NEEDS RULING case, else retry later
        const again = await this.stripe.getInvoiceFacts(invoiceId).catch(() => null);
        if (again && invoiceIsPaid(again)) return refusedBecausePaid();
        throw err; // the row stays RELEASING; the sweep finishes it
      }
    }

    // ── Step 3: cancel the subscription (idempotent) ──
    if (subId) {
      try {
        await this.stripe.cancelSubscription(
          subId,
          { prorate: false, invoice_now: false },
          {
            idempotencyKey: `${tenantId}:catchup-release-cancel:${seen.catchupSessionId ?? subId}`,
          },
        );
      } catch (err) {
        const e = err as { code?: string; statusCode?: number };
        if (!(e?.code === "resource_missing" || e?.statusCode === 404)) throw err;
      }
    }

    // ── Step 4: clear the claim ──
    await this.inTenantTx(tenantId, async (tx) => {
      const { count } = await tx.tenantSubscription.updateMany({
        where: { tenantId, catchupState: "RELEASING" },
        data: { ...CLEAR_CLAIM },
      });
      if (count === 1) {
        await this.notice(
          tx,
          tenantId,
          "billing_catchup_released",
          "The October catch-up was released (the card subscription was cancelled unpaid); manual invoicing continues.",
          { reason: opts.reason, sessionId: seen.catchupSessionId },
        );
      }
    });
    return "released";
  }

  /**
   * (a) Put the manual period recorded at openClaim back (the latest record). Skipped, loudly, when none exists (a
   * claim opened before this record was written): the period is left as the completion wrote it.
   */
  private async restoreManualPeriodTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<void> {
    const saved = (await tx.auditLog.findFirst({
      where: {
        tenantId,
        entityType: ADMIN_AUDIT_ENTITY,
        action: AdminAuditAction.TENANT_CONFIG_UPDATED,
        AND: [{ meta: { path: ["kind"], equals: MANUAL_PERIOD_KIND } }],
      },
      orderBy: { createdAt: "desc" },
      select: { meta: true },
    })) as { meta?: { periodStart?: string | null; periodEnd?: string | null } } | null;
    const meta = saved?.meta;
    if (!meta || (!meta.periodStart && !meta.periodEnd)) {
      this.logger.warn(
        `catch-up release tenant=${tenantId}: no recorded manual period to restore - left as the completion wrote it`,
      );
      return;
    }
    await tx.tenantSubscription.updateMany({
      where: { tenantId },
      data: {
        periodStart: meta.periodStart ? new Date(meta.periodStart) : null,
        periodEnd: meta.periodEnd ? new Date(meta.periodEnd) : null,
      },
    });
  }

  // ─── the hourly sweep ─────────────────────────────────────────────────────

  @LeaderCron(CronExpression.EVERY_HOUR, "billing.catchupSweep")
  async sweepCron(): Promise<void> {
    const s = await this.sweep();
    if (s.touched) this.logger.log(`catch-up sweep: ${JSON.stringify(s)}`);
  }

  /**
   * Finishes RELEASING rows; settles or releases stale AWAITING_FIRST_PAYMENT rows (paid -> settle, definitively
   * failed -> release); and for SESSION_OPEN rows retrieves the session: expired -> release, complete -> advance
   * (a missed webhook), a session id that was never stored after 25 h -> release. A `complete` session is never
   * released. One row failing never stops the next.
   */
  async sweep(now: Date = new Date()): Promise<{
    touched: number;
    releasing: number;
    awaiting: number;
    sessionOpen: number;
    errors: number;
  }> {
    const out = { touched: 0, releasing: 0, awaiting: 0, sessionOpen: 0, errors: 0 };
    const rows = (await this.prisma.tenantSubscription.findMany({
      where: { catchupState: { not: null } },
      select: CLAIM_SELECT,
      orderBy: { updatedAt: "asc" },
    })) as ClaimRow[];
    for (const row of rows) {
      try {
        if (row.catchupState === "RELEASING") {
          out.releasing++;
          const r = await this.release(row.tenantId, {
            sessionId: row.catchupSessionId,
            reason: "sweep_finish",
          });
          if (r !== "none") out.touched++;
        } else if (row.catchupState === "AWAITING_FIRST_PAYMENT") {
          out.awaiting++;
          if (await this.sweepAwaiting(row)) out.touched++;
        } else if (row.catchupState === "SESSION_OPEN") {
          out.sessionOpen++;
          if (await this.sweepSessionOpen(row, now)) out.touched++;
        }
      } catch (err) {
        out.errors++;
        this.logger.error(
          `catch-up sweep: tenant ${row.tenantId} (${row.catchupState}) left for the next run: ${(err as Error).message}`,
        );
      }
    }
    return out;
  }

  private async sweepAwaiting(row: ClaimRow): Promise<boolean> {
    if (!row.stripeSubId) return false;
    let invoiceId = row.catchupInvoiceId;
    let facts: InvoiceFacts | null = null;
    if (invoiceId) {
      facts = await this.stripe.getInvoiceFacts(invoiceId);
    } else {
      // none stored yet: the first invoice with money on it settles (or fails) the claim
      // Stripe lists NEWEST first; "the first invoice with money" is the OLDEST one with money.
      const listed = await this.stripe.listSubscriptionInvoices(row.stripeSubId, 100);
      for (const inv of [...listed].reverse()) {
        const f = await this.stripe.getInvoiceFacts(inv.id);
        if (f.amountPaid > 0 || f.amountDue > 0) {
          invoiceId = inv.id;
          facts = f;
          break;
        }
      }
      if (invoiceId && facts)
        await this.setInvoiceIdBySub(row.tenantId, row.stripeSubId, invoiceId);
    }
    if (facts && invoiceIsPaid(facts)) {
      return this.settle(row.tenantId, row.stripeSubId, facts, invoiceId);
    }
    if (facts && invoiceDefinitivelyFailed(facts)) {
      const r = await this.release(row.tenantId, {
        sessionId: row.catchupSessionId,
        reason: "sweep_failed",
      });
      return r !== "none";
    }
    // (b) The subscription itself is gone at Stripe (cancelled by the customer, in the dashboard, by dunning's end)
    // with nothing paid: no invoice will ever settle or fail this claim, and it would freeze the tenant's RouteFlow
    // invoicing forever. Release it - Step 0 still defers to a PAID or PROCESSING invoice first.
    if (await this.subscriptionGoneAtStripe(row.stripeSubId)) {
      const r = await this.release(row.tenantId, {
        sessionId: row.catchupSessionId,
        reason: "sweep_subscription_cancelled",
      });
      return r !== "none";
    }
    return false;
  }

  /** Cancelled / expired / unknown at Stripe. Any other read error says nothing and is rethrown (next run retries). */
  private async subscriptionGoneAtStripe(subId: string): Promise<boolean> {
    try {
      const status = (await this.stripe.getSubscription(subId))?.status;
      return status === "canceled" || status === "incomplete_expired";
    } catch (err) {
      const e = err as { code?: string; statusCode?: number };
      if (e?.code === "resource_missing" || e?.statusCode === 404) return true;
      throw err;
    }
  }

  private async sweepSessionOpen(row: ClaimRow, now: Date): Promise<boolean> {
    if (!row.catchupSessionId) {
      if (now.getTime() - row.updatedAt.getTime() < CATCHUP_ORPHAN_AFTER_MS) return false;
      // the session id was never stored and a session cannot outlive 24 h: nothing can complete any more
      return this.releaseOrphan(row);
    }
    const session = await this.stripe.getCheckoutSession(row.catchupSessionId);
    if (session?.status === "expired") {
      await this.onSessionExpired({
        id: row.catchupSessionId,
        metadata: {
          ...(session.metadata ?? {}),
          tenantId: row.tenantId,
          [CATCHUP_META.catchup]: "sweep",
        },
      });
      return true;
    }
    if (session?.status === "complete") {
      // a missed / out-of-order completion: advance it (a no-op unless the ordinary completion applied it)
      await this.onSessionCompleted(session);
      return this.releaseStuckCompleted(row, session, now);
    }
    return false; // still open
  }

  /**
   * Opus SHOULD-FIX 6 + MF4. A catch-up session COMPLETED (and may have been paid) but its subscription is not the
   * stored one, so the claim cannot advance. It is cleared ONLY when the ordinary completion has DECIDED against the
   * session - its refusal / duplicate record exists for that session id - or a DIFFERENT live subscription is the
   * stored one. A bare timer is not enough: Stripe retries a webhook for up to 3 days, so a completion that has
   * simply not arrived yet must keep the claim (clearing it would unfreeze RouteFlow invoicing while a card
   * subscription is about to land). Otherwise the claim is HELD, and after CATCHUP_LATE_ALERT_DAYS past the session's
   * expiry ONE internal alert is raised (see {@link holdUndecidedCompletion}).
   */
  private async releaseStuckCompleted(row: ClaimRow, session: any, now: Date): Promise<boolean> {
    const sessionSub = stripeRefId(session?.subscription);
    const after = await this.readClaim(this.prisma, row.tenantId);
    if (
      !after ||
      after.catchupState !== "SESSION_OPEN" ||
      after.catchupSessionId !== row.catchupSessionId
    ) {
      return true; // it advanced (or was released) meanwhile
    }
    if (!sessionSub || after.stripeSubId === sessionSub) return true; // not stuck: the sub is the stored one

    const refused = await this.ordinaryHandlerRefused(String(row.catchupSessionId));
    const otherLive = refused ? false : await this.storedSubscriptionIsLive(after.stripeSubId);
    if (!refused && !otherLive) {
      await this.holdUndecidedCompletion(row, session, sessionSub, now);
      return false;
    }
    await this.inTenantTx(row.tenantId, async (tx) => {
      const { count } = await tx.tenantSubscription.updateMany({
        where: {
          tenantId: row.tenantId,
          catchupState: "SESSION_OPEN",
          catchupSessionId: row.catchupSessionId,
          stripeSubId: after.stripeSubId,
        },
        data: { ...CLEAR_CLAIM },
      });
      if (count === 1) {
        await this.noticeOnce(
          tx,
          row.tenantId,
          "billing_catchup_stuck_completed",
          String(row.catchupSessionId),
          `NEEDS RULING: the catch-up Checkout ${row.catchupSessionId} completed on subscription ${sessionSub}, but the ordinary completion did not apply it (duplicate / stale checkout). The tenant's stored subscription is ${after.stripeSubId ?? "(none)"}. The claim was cleared; refund or cancel ${sessionSub} in Stripe, and check whether ${after.stripeSubId ?? "the stored one"} is an ordinary subscription that also bills.`,
          {
            sessionId: row.catchupSessionId,
            subscriptionId: sessionSub,
            storedSubscriptionId: after.stripeSubId,
          },
        );
      }
    });
    return true;
  }

  /** Did the ordinary checkout handler record a duplicate / refusal decision for this session? */
  private async ordinaryHandlerRefused(sessionId: string): Promise<boolean> {
    for (const action of [STRIPE_CHECKOUT_DUPLICATE_ACTION, STRIPE_CHECKOUT_REFUSED_ACTION]) {
      const hit = await this.prisma.auditLog.findFirst({
        where: { entityType: STRIPE_CHECKOUT_ENTITY, entityId: sessionId, action },
        select: { id: true },
      });
      if (hit) return true;
    }
    return false;
  }

  /**
   * Is the tenant's stored subscription a LIVE one at Stripe? Only `resource_missing` means "no": any other error
   * says nothing, so it is rethrown (the row is left for the next run) rather than read as "not live".
   */
  private async storedSubscriptionIsLive(subId: string | null): Promise<boolean> {
    if (!subId) return false;
    try {
      return isLiveStripeSubscriptionStatus((await this.stripe.getSubscription(subId))?.status);
    } catch (err) {
      const e = err as { code?: string; statusCode?: number };
      if (e?.code === "resource_missing" || e?.statusCode === 404) return false;
      throw err;
    }
  }

  /**
   * The claim is held. Past CATCHUP_LATE_ALERT_DAYS after the session's expiry, one structured operator alert (log +
   * a once-per-session admin notice). INTERNAL ONLY: no tenant is emailed - an unresolved catch-up is the owner's to
   * chase, and a dark / unverified billing path stays silent to customers.
   */
  private async holdUndecidedCompletion(
    row: ClaimRow,
    session: any,
    sessionSub: string,
    now: Date,
  ): Promise<void> {
    const expiresAt = Number(session?.expires_at);
    if (!Number.isFinite(expiresAt)) return;
    if (now.getTime() < expiresAt * 1000 + CATCHUP_LATE_ALERT_DAYS * DAY_MS) return;
    const first = await this.noticeOnce(
      this.prisma,
      row.tenantId,
      "billing_catchup_late_completion",
      String(row.catchupSessionId),
      `NEEDS RULING: the catch-up Checkout ${row.catchupSessionId} completed on subscription ${sessionSub} more than ${CATCHUP_LATE_ALERT_DAYS} days ago, but the ordinary completion has neither applied nor refused it. The claim is HELD (RouteFlow invoicing stays frozen for this tenant). Check Stripe's webhook deliveries for the session, then cancel ${sessionSub} or clear the claim by the runbook.`,
      { sessionId: row.catchupSessionId, subscriptionId: sessionSub },
    ).catch(() => false);
    if (first) {
      this.logger.error(
        `billing.catchup.late_completion ${JSON.stringify({
          tenantId: row.tenantId,
          sessionId: row.catchupSessionId,
          subscriptionId: sessionSub,
          days: CATCHUP_LATE_ALERT_DAYS,
        })}`,
      );
    }
  }

  private async releaseOrphan(row: ClaimRow): Promise<boolean> {
    return this.inTenantTx(row.tenantId, async (tx) => {
      const { count } = await tx.tenantSubscription.updateMany({
        where: { tenantId: row.tenantId, catchupState: "SESSION_OPEN", catchupSessionId: null },
        data: { ...CLEAR_CLAIM },
      });
      return count === 1;
    });
  }
}

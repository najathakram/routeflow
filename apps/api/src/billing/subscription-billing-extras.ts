import { Injectable, Logger } from "@nestjs/common";
import { fromCents } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "./stripe.service";

/**
 * SA-733r6 (B4): the facts the subscription view adds so the web banner and the Billing card render from ONE read.
 *  - `billingContactName`: the OLDEST ACTIVE TENANT_ADMIN's name - a fixed, stated rule (a per-branch contact can
 *    replace the rule behind this one field later);
 *  - `openInvoiceAmount`: the `pastDueInvoiceId` invoice's amount remaining, in dollars (Stripe cents via `fromCents`);
 *  - `paymentMethodSummary` / `nextCharge`: the autopay card and what the next renewal charges.
 *
 * Stripe is read through the existing StripeService and cached per tenant (the web polls the view every 60 s); any
 * Stripe failure yields null for that field - the banner then says less, the view never throws.
 */

/** Stripe invoice statuses that still owe money (mirrors payment-overdue.ts). */
const OWED_STATUSES = new Set(["open", "uncollectible"]);
const INVOICE_TTL_MS = 60_000;
const CARD_TTL_MS = 5 * 60_000;

export interface PaymentMethodSummary {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface BillingViewExtras {
  billingContactName: string | null;
  openInvoiceAmount: number | null;
  paymentMethodSummary: PaymentMethodSummary | null;
  nextCharge: { amount: number; date: string } | null;
}

export interface BillingExtrasSubscription {
  pastDueInvoiceId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  periodEnd?: Date | null;
}

export const EMPTY_BILLING_VIEW_EXTRAS: BillingViewExtras = {
  billingContactName: null,
  openInvoiceAmount: null,
  paymentMethodSummary: null,
  nextCharge: null,
};

interface Cached<T> {
  value: T;
  expiresAt: number;
}

@Injectable()
export class SubscriptionBillingExtras {
  private readonly logger = new Logger(SubscriptionBillingExtras.name);
  private readonly cache = new Map<string, Cached<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async read(
    tenantId: string,
    sub: BillingExtrasSubscription | null | undefined,
  ): Promise<BillingViewExtras> {
    const [billingContactName, openInvoiceAmount, card] = await Promise.all([
      this.contactName(tenantId),
      this.openAmount(sub?.pastDueInvoiceId ?? null),
      this.cardAndNextCharge(tenantId, sub),
    ]);
    return { billingContactName, openInvoiceAmount, ...card };
  }

  /** The hosted invoice page for the admin's Pay button; null when Stripe has none or fails. */
  async hostedInvoiceUrl(invoiceId: string): Promise<string | null> {
    if (!this.stripe.isConfigured) return null;
    try {
      const facts = await this.stripe.getInvoiceFacts(invoiceId);
      return facts.hostedInvoiceUrl ?? null;
    } catch {
      return null;
    }
  }

  private async contactName(tenantId: string): Promise<string | null> {
    try {
      const admin = await this.prisma.user.findFirst({
        where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { username: true },
      });
      return admin?.username ?? null;
    } catch (err) {
      this.logger.warn(`billing contact lookup failed for ${tenantId}: ${(err as Error).message}`);
      return null;
    }
  }

  private async openAmount(invoiceId: string | null): Promise<number | null> {
    if (!invoiceId || !this.stripe.isConfigured) return null;
    return this.cached(`inv:${invoiceId}`, INVOICE_TTL_MS, async () => {
      try {
        const facts = await this.stripe.getInvoiceFacts(invoiceId);
        if (!facts.status || !OWED_STATUSES.has(facts.status)) return null;
        const remaining = facts.amountRemaining ?? Math.max(0, facts.amountDue - facts.amountPaid);
        return remaining > 0 ? fromCents(remaining) : null;
      } catch (err) {
        this.logger.warn(`open invoice read failed: ${(err as Error).message}`);
        return null;
      }
    });
  }

  private async cardAndNextCharge(
    tenantId: string,
    sub: BillingExtrasSubscription | null | undefined,
  ): Promise<Pick<BillingViewExtras, "paymentMethodSummary" | "nextCharge">> {
    const none = { paymentMethodSummary: null, nextCharge: null };
    if (!sub?.stripeCustomerId || !this.stripe.isConfigured) return none;
    const customerId = sub.stripeCustomerId;
    const subId = sub.stripeSubscriptionId ?? null;
    const periodEnd = sub.periodEnd ?? null;
    return this.cached(`card:${tenantId}`, CARD_TTL_MS, async () => {
      let paymentMethodSummary: PaymentMethodSummary | null = null;
      let nextCharge: BillingViewExtras["nextCharge"] = null;
      try {
        paymentMethodSummary = await this.stripe.getDefaultCardSummary(customerId);
      } catch (err) {
        this.logger.warn(`card read failed for ${tenantId}: ${(err as Error).message}`);
      }
      if (subId && periodEnd) {
        try {
          const preview = await this.stripe.previewNextInvoice(subId);
          const due = preview?.amount_due;
          if (Number.isInteger(due) && due > 0) {
            nextCharge = { amount: fromCents(due), date: periodEnd.toISOString() };
          }
        } catch (err) {
          this.logger.warn(`next charge read failed for ${tenantId}: ${(err as Error).message}`);
        }
      }
      return { paymentMethodSummary, nextCharge };
    });
  }

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key) as Cached<T> | undefined;
    if (hit && hit.expiresAt > now) return hit.value;
    const value = await load();
    this.cache.set(key, { value, expiresAt: now + ttlMs });
    if (this.cache.size > 500) {
      for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
    }
    return value;
  }
}

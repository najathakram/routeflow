import { Injectable, Logger } from "@nestjs/common";
import { fromCents } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { isInternalEmail } from "../common/internal-email";
import { isOwed } from "./dunning-core";
import { DUNNING_PAUSE_HOURS, DUNNING_FALLBACK_ZONE, HOUR_MS } from "./dunning-config";
import { dunningZone } from "./dunning-zone";
import { StripeService } from "./stripe.service";

/**
 * SA-733r6 (B4): the facts the subscription view adds so the web banner and the Billing card render from ONE read.
 *  - `billingContactEmail` (SA-776): the OLDEST ACTIVE TENANT_ADMIN's e-mail - a fixed, stated rule (a per-branch
 *    contact can replace the rule behind this one field later). There is NO contact name: the User model has no
 *    display-name column and a username is never shown (the field this replaced was the username). An internal
 *    sentinel address (`no-email+...@placeholder.local`) is never sent;
 *  - `openInvoiceAmount`: the `pastDueInvoiceId` invoice's amount remaining, in dollars (Stripe cents via `fromCents`);
 *  - `paymentMethodSummary` / `nextCharge`: the autopay card and what the next renewal charges;
 *  - `pastDueMonthLabel` / `graceEndsLabel` / `nextCharge.dateLabel`: calendar labels formatted HERE in the TENANT's
 *    zone (SA-738), so the web renders them verbatim and never re-derives a date in the browser's zone.
 *
 * Stripe is read through the existing StripeService, cached per tenant (the web polls the view every 30-60 s) and
 * bounded by a timeout; any Stripe failure yields null for that field - the banner then says less, the view never throws.
 */

const INVOICE_TTL_MS = 60_000;
const CARD_TTL_MS = 5 * 60_000;
/** An interactive Stripe read never holds the request longer than this (the #2476 cap for the portal route). */
export const INTERACTIVE_STRIPE_REQUEST = { timeoutMs: 8_000, maxNetworkRetries: 1 } as const;

export interface PaymentMethodSummary {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface BillingViewExtras {
  billingContactEmail: string | null;
  openInvoiceAmount: number | null;
  paymentMethodSummary: PaymentMethodSummary | null;
  nextCharge: { amount: number; date: string; dateLabel: string } | null;
  pastDueMonthLabel: string | null;
  graceEndsLabel: string | null;
}

export interface BillingExtrasSubscription {
  pastDueSince?: Date | null;
  pastDueInvoiceId?: string | null;
  stripeCustomerId?: string | null;
  /** The real column (platform.prisma `stripeSubId`). */
  stripeSubId?: string | null;
  periodEnd?: Date | null;
}

export const EMPTY_BILLING_VIEW_EXTRAS: BillingViewExtras = {
  billingContactEmail: null,
  openInvoiceAmount: null,
  paymentMethodSummary: null,
  nextCharge: null,
  pastDueMonthLabel: null,
  graceEndsLabel: null,
};

/** The role trim (S3): only a workspace admin sees the card, the next charge and the amount. */
export function trimBillingViewForRole<T extends Partial<BillingViewExtras>>(
  view: T,
  role: string | null | undefined,
): T {
  if (role === "TENANT_ADMIN" || role === "SUPER_ADMIN") return view;
  return { ...view, paymentMethodSummary: null, nextCharge: null, openInvoiceAmount: null };
}

interface Cached<T> {
  value: T;
  expiresAt: number;
}

/** Rejects (so the caller's catch answers null) when a Stripe read hangs. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const cut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("stripe read timed out")), ms);
  });
  return Promise.race([p, cut]).finally(() => clearTimeout(timer));
}

function formatInZone(at: Date, zone: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...opts }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: DUNNING_FALLBACK_ZONE, ...opts }).format(
      at,
    );
  }
}
const monthLabel = (at: Date, zone: string) => formatInZone(at, zone, { month: "long" });
const dayLabel = (at: Date, zone: string) =>
  formatInZone(at, zone, { month: "short", day: "numeric" });

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
    const [billingContactEmail, openInvoiceAmount, card, zone] = await Promise.all([
      this.contactEmail(tenantId),
      this.openAmount(sub?.pastDueInvoiceId ?? null),
      this.cardAndNextCharge(tenantId, sub),
      dunningZone(this.prisma, tenantId),
    ]);
    const since = sub?.pastDueInvoiceId ? (sub.pastDueSince ?? null) : null;
    return {
      billingContactEmail,
      openInvoiceAmount,
      paymentMethodSummary: card.paymentMethodSummary,
      nextCharge: card.nextCharge
        ? { ...card.nextCharge, dateLabel: dayLabel(new Date(card.nextCharge.date), zone) }
        : null,
      pastDueMonthLabel: since ? monthLabel(since, zone) : null,
      graceEndsLabel: since
        ? dayLabel(new Date(since.getTime() + DUNNING_PAUSE_HOURS * HOUR_MS), zone)
        : null,
    };
  }

  /**
   * The hosted invoice page for the admin's Pay button. Null unless Stripe still shows the invoice as OWED (B3's one
   * predicate: `open` with an amount remaining) - a paid / void / written-off invoice must never get a pay link.
   */
  async hostedInvoiceUrl(invoiceId: string): Promise<string | null> {
    if (!this.stripe.isConfigured) return null;
    try {
      const facts = await withTimeout(
        this.stripe.getInvoiceFacts(invoiceId),
        INTERACTIVE_STRIPE_REQUEST.timeoutMs,
      );
      return isOwed(facts) ? (facts.hostedInvoiceUrl ?? null) : null;
    } catch {
      return null;
    }
  }

  private async contactEmail(tenantId: string): Promise<string | null> {
    try {
      const admin = await this.prisma.user.findFirst({
        where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { email: true },
      });
      const email = admin?.email?.trim() || null;
      return email && !isInternalEmail(email) ? email : null;
    } catch (err) {
      this.logger.warn(`billing contact lookup failed for ${tenantId}: ${(err as Error).message}`);
      return null;
    }
  }

  private async openAmount(invoiceId: string | null): Promise<number | null> {
    if (!invoiceId || !this.stripe.isConfigured) return null;
    return this.cached(`inv:${invoiceId}`, INVOICE_TTL_MS, async () => {
      try {
        const facts = await withTimeout(
          this.stripe.getInvoiceFacts(invoiceId),
          INTERACTIVE_STRIPE_REQUEST.timeoutMs,
        );
        if (!isOwed(facts)) return null;
        const remaining = facts.amountRemaining ?? Math.max(0, facts.amountDue - facts.amountPaid);
        return fromCents(remaining);
      } catch (err) {
        this.logger.warn(`open invoice read failed: ${(err as Error).message}`);
        return null;
      }
    });
  }

  private async cardAndNextCharge(
    tenantId: string,
    sub: BillingExtrasSubscription | null | undefined,
  ): Promise<{
    paymentMethodSummary: PaymentMethodSummary | null;
    nextCharge: { amount: number; date: string } | null;
  }> {
    const none = { paymentMethodSummary: null, nextCharge: null };
    if (!sub?.stripeCustomerId || !this.stripe.isConfigured) return none;
    const customerId = sub.stripeCustomerId;
    const subId = sub.stripeSubId ?? null;
    const periodEnd = sub.periodEnd ?? null;
    return this.cached(`card:${tenantId}`, CARD_TTL_MS, async () => {
      let paymentMethodSummary: PaymentMethodSummary | null = null;
      let nextCharge: { amount: number; date: string } | null = null;
      try {
        paymentMethodSummary = await withTimeout(
          this.stripe.getDefaultCardSummary(customerId),
          INTERACTIVE_STRIPE_REQUEST.timeoutMs,
        );
      } catch (err) {
        this.logger.warn(`card read failed for ${tenantId}: ${(err as Error).message}`);
      }
      if (subId && periodEnd) {
        try {
          const preview = await withTimeout(
            this.stripe.previewNextInvoice(subId),
            INTERACTIVE_STRIPE_REQUEST.timeoutMs,
          );
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

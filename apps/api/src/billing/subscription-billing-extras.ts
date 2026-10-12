import { Injectable, Logger } from "@nestjs/common";
import { fromCents } from "@routeflow/pricing";
import {
  deriveBillingState,
  outstandingCents,
  owedInvoices,
  type BillingState,
  type OpenInvoiceFact,
} from "./billing-state";
import { PrismaService } from "../prisma/prisma.service";
import { isOwed } from "./dunning-core";
import { DUNNING_PAUSE_HOURS, DUNNING_FALLBACK_ZONE, HOUR_MS } from "./dunning-config";
import { dunningZone } from "./dunning-zone";
import { StripeService } from "./stripe.service";

/**
 * SA-733r6 (B4): the facts the subscription view adds so the web banner and the Billing card render from ONE read.
 *  - `billingContactName`: the OLDEST ACTIVE TENANT_ADMIN's `username` (the User model has no display-name column) - a
 *    fixed, stated rule (a per-branch contact can replace the rule behind this one field later);
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

/** SA-777: Stripe lists at most this many open invoices for the card (it sums what is owed, it never pages). */
export const OPEN_INVOICE_LIST_CAP = 10;

export interface BillingViewExtras {
  billingContactName: string | null;
  /** The same oldest-ACTIVE-admin pick as `billingContactName`; an operator is told who to ask. */
  billingContactEmail?: string | null;
  openInvoiceAmount: number | null;
  paymentMethodSummary: PaymentMethodSummary | null;
  nextCharge: { amount: number; date: string; dateLabel: string } | null;
  pastDueMonthLabel: string | null;
  graceEndsLabel: string | null;
  /**
   * SA-777 - present ONLY when Stripe answered: on a timeout / outage / no customer they are OMITTED (never zeroed:
   * a zero amount or "current" would be a claim the server cannot make). `outstandingTotal` is dollars from integer
   * cents (`fromCents`); `payNowUrl` is the OLDEST owed invoice's hosted page, omitted while a payment is processing.
   */
  outstandingTotal?: number;
  billingState?: BillingState;
  paymentProcessing?: boolean;
  /** "Oct 15", formatted in the TENANT's zone: when the oldest owed invoice fell due / went overdue. */
  openInvoiceDueLabel?: string;
  payNowUrl?: string;
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
  billingContactName: null,
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
  // SA-777: an operator keeps the state and the date label (no money) and loses the amount and the pay link.
  const { outstandingTotal: _amount, payNowUrl: _pay, ...rest } = view;
  return { ...rest, paymentMethodSummary: null, nextCharge: null, openInvoiceAmount: null } as T;
}

/** SA-777: the view's state fields, only the ones that are present (a spread leaves an absent one out). */
export function pickStateFacts(e: Partial<BillingViewExtras>): Partial<BillingViewExtras> {
  const out: Partial<BillingViewExtras> = { billingContactEmail: e.billingContactEmail ?? null };
  if (e.billingState !== undefined) out.billingState = e.billingState;
  if (e.outstandingTotal !== undefined) out.outstandingTotal = e.outstandingTotal;
  if (e.paymentProcessing !== undefined) out.paymentProcessing = e.paymentProcessing;
  if (e.openInvoiceDueLabel !== undefined) out.openInvoiceDueLabel = e.openInvoiceDueLabel;
  if (e.payNowUrl !== undefined) out.payNowUrl = e.payNowUrl;
  return out;
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
    const [contact, openInvoiceAmount, card, zone, open] = await Promise.all([
      this.contact(tenantId),
      this.openAmount(sub?.pastDueInvoiceId ?? null),
      this.cardAndNextCharge(tenantId, sub),
      dunningZone(this.prisma, tenantId),
      this.openInvoices(tenantId, sub?.stripeCustomerId ?? null),
    ]);
    const since = sub?.pastDueInvoiceId ? (sub.pastDueSince ?? null) : null;
    return {
      billingContactName: contact.name,
      billingContactEmail: contact.email,
      openInvoiceAmount,
      ...this.stateFacts(open, since, zone),
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

  private async contact(tenantId: string): Promise<{ name: string | null; email: string | null }> {
    try {
      const admin = await this.prisma.user.findFirst({
        where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { username: true, email: true },
      });
      return { name: admin?.username ?? null, email: admin?.email ?? null };
    } catch (err) {
      this.logger.warn(`billing contact lookup failed for ${tenantId}: ${(err as Error).message}`);
      return { name: null, email: null };
    }
  }

  /**
   * SA-777: the customer's open invoices as facts, or null when they could not be read (no customer, Stripe not
   * configured, a timeout or any Stripe failure). Cached 60 s on SUCCESS only: a failure is never remembered as
   * "nothing owed". The customer id is the tenant row's (the caller passes `sub.stripeCustomerId`).
   */
  private async openInvoices(
    tenantId: string,
    customerId: string | null,
  ): Promise<OpenInvoiceFact[] | null> {
    if (!customerId || !this.stripe.isConfigured) return null;
    const key = `open:${tenantId}`;
    const hit = this.cache.get(key) as Cached<OpenInvoiceFact[]> | undefined;
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    try {
      const facts = await withTimeout(
        (async () => {
          const rows = await this.stripe.listOpenCustomerInvoices(
            customerId,
            OPEN_INVOICE_LIST_CAP,
            INTERACTIVE_STRIPE_REQUEST,
          );
          return Promise.all(
            rows.map(async (r): Promise<OpenInvoiceFact> => {
              // a bank debit's PaymentIntent can still be `processing`: only the per-invoice facts expand it
              const f = await this.stripe.getInvoiceFacts(String(r.id));
              return {
                amountRemainingCents: Number.isFinite(r.amount_remaining)
                  ? r.amount_remaining
                  : (f.amountRemaining ?? Math.max(0, f.amountDue - f.amountPaid)),
                attemptCount: Number.isFinite(r.attempt_count) ? r.attempt_count : f.attemptCount,
                dueDateSec: typeof r.due_date === "number" ? r.due_date : null,
                paymentProcessing: f.paymentProcessing,
                hostedInvoiceUrl:
                  typeof r.hosted_invoice_url === "string"
                    ? r.hosted_invoice_url
                    : (f.hostedInvoiceUrl ?? null),
                createdSec: Number.isFinite(r.created) ? r.created : 0,
              };
            }),
          );
        })(),
        INTERACTIVE_STRIPE_REQUEST.timeoutMs,
      );
      this.cache.set(key, { value: facts, expiresAt: Date.now() + INVOICE_TTL_MS });
      return facts;
    } catch (err) {
      this.logger.warn(`open invoices read failed for ${tenantId}: ${(err as Error).message}`);
      return null;
    }
  }

  /** The SA-777 view fields: all omitted when `open` is null (the UI hides the amount and never says "current"). */
  private stateFacts(
    open: OpenInvoiceFact[] | null,
    since: Date | null,
    zone: string,
  ): Pick<
    BillingViewExtras,
    "outstandingTotal" | "billingState" | "paymentProcessing" | "openInvoiceDueLabel" | "payNowUrl"
  > {
    if (!open) return {};
    const owed = owedInvoices(open);
    const billingState = deriveBillingState(open, new Date());
    const oldest = owed[0];
    const dueAt =
      since ?? (oldest ? new Date((oldest.dueDateSec ?? oldest.createdSec) * 1000) : null);
    return {
      outstandingTotal: fromCents(outstandingCents(open)),
      billingState,
      paymentProcessing: billingState === "processing",
      ...(oldest && dueAt && dueAt.getTime() > 0
        ? { openInvoiceDueLabel: dayLabel(dueAt, zone) }
        : {}),
      ...(oldest?.hostedInvoiceUrl && billingState !== "processing"
        ? { payNowUrl: oldest.hostedInvoiceUrl }
        : {}),
    };
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

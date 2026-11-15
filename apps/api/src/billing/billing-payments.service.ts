import { Injectable, Logger } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import type { BillingPaymentRow, BillingPaymentsPage } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { dunningZone } from "./dunning-zone";
import { formatInZone, INTERACTIVE_STRIPE_REQUEST } from "./subscription-billing-extras";
import { StripeService } from "./stripe.service";

/** SA-1146 B-4: rows per page, and how many each source is asked for. */
export const PAYMENTS_PAGE_SIZE = 12;

/** The decoded compound cursor: where each source continues. Opaque to the web. */
interface PaymentsCursor {
  /** The last Stripe invoice id already shown (Stripe `starting_after`). */
  stripeAfter: string | null;
  /** The last RouteFlow invoice already shown (`issuedAt` instant + id: the stable order key). */
  rfBefore: { t: string; id: string } | null;
}

const EMPTY_CURSOR: PaymentsCursor = { stripeAfter: null, rfBefore: null };

function encodeCursor(c: PaymentsCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Anything that does not parse is the first page; a cursor only ever carries positions, never a customer or tenant. */
function decodeCursor(raw: string | null | undefined): PaymentsCursor {
  if (!raw) return EMPTY_CURSOR;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const stripeAfter =
      typeof v?.stripeAfter === "string" && v.stripeAfter.length > 0 && v.stripeAfter.length <= 255
        ? v.stripeAfter
        : null;
    const t = v?.rfBefore?.t;
    const id = v?.rfBefore?.id;
    const rfBefore =
      typeof t === "string" && typeof id === "string" && !Number.isNaN(new Date(t).getTime())
        ? { t, id }
        : null;
    return { stripeAfter, rfBefore };
  } catch {
    return EMPTY_CURSOR;
  }
}

let knownCurrencies: Set<string> | null = null;
const loggedUnknown = new Set<string>();

/**
 * A Stripe amount in the currency's MAJOR unit: the smallest-unit count divided by 10^exponent, the exponent being the
 * currency's own (USD 2, JPY 0), never a bare /100. Null for a currency this runtime does not know, or a non-whole
 * amount: that row then shows no amount rather than a wrong one.
 */
export function stripeMinorToMajor(minor: number, currency: string): number | null {
  const code = currency.toUpperCase();
  knownCurrencies ??= new Set(Intl.supportedValuesOf("currency"));
  if (!knownCurrencies.has(code) || !Number.isInteger(minor)) return null;
  const digits =
    new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return roundMoney(minor / 10 ** digits);
}

interface Candidate {
  row: BillingPaymentRow;
  at: number;
  source: "stripe" | "routeflow";
}

/**
 * SA-1146 B-4: the Billing "Payments" list - paid Stripe invoices of the tenant's OWN customer (read live, receipt link
 * = Stripe's hosted invoice page, never stored) merged newest first with the tenant's own paid RouteFlow invoices.
 *
 * Authority: the tenant id is the caller's (the JWT's); the Stripe customer id is read here from the tenant's own
 * subscription row, never from a request value. A Stripe failure never empties the list: the RouteFlow rows are still
 * returned and `stripeUnavailable` is true, so the web can say card payments cannot be shown right now.
 *
 * Paging: each page asks every source for up to PAYMENTS_PAGE_SIZE rows past its own cursor position and returns the
 * newest PAYMENTS_PAGE_SIZE of the union. A row older than a source's 12th fetched row cannot be in the top 12, so no
 * row is skipped; the cursor moves each source only past the rows actually returned, so none repeats.
 */
@Injectable()
export class BillingPaymentsService {
  private readonly logger = new Logger(BillingPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async list(tenantId: string, cursor?: string | null): Promise<BillingPaymentsPage> {
    const pos = decodeCursor(cursor);
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { stripeCustomerId: true },
    });
    const customerId = sub?.stripeCustomerId ?? null;

    const [stripeSide, rfSide, zone] = await Promise.all([
      this.readStripe(tenantId, customerId, pos.stripeAfter),
      this.readRouteFlow(tenantId, pos.rfBefore),
      dunningZone(this.prisma, tenantId),
    ]);

    const candidates: Candidate[] = [...stripeSide.rows, ...rfSide.rows].sort(
      (a, b) => b.at - a.at || (a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0),
    );
    const page = candidates.slice(0, PAYMENTS_PAGE_SIZE);

    const lastStripe = [...page].reverse().find((c) => c.source === "stripe");
    const lastRf = [...page].reverse().find((c) => c.source === "routeflow");
    const next: PaymentsCursor = {
      stripeAfter: lastStripe ? lastStripe.row.id : pos.stripeAfter,
      rfBefore: lastRf ? { t: new Date(lastRf.at).toISOString(), id: lastRf.row.id } : pos.rfBefore,
    };
    const more = candidates.length > PAYMENTS_PAGE_SIZE || stripeSide.hasMore || rfSide.hasMore;

    return {
      rows: page.map((c) => ({
        ...c.row,
        paidDayLabel: c.row.paidAt
          ? formatInZone(new Date(c.row.paidAt), zone, { month: "short", day: "numeric" })
          : null,
      })),
      nextCursor: more ? encodeCursor(next) : null,
      stripeUnavailable: stripeSide.unavailable,
    };
  }

  private stripeAmount(minor: number, currency: string): number | null {
    const amount = stripeMinorToMajor(minor, currency);
    if (amount === null && !loggedUnknown.has(currency)) {
      loggedUnknown.add(currency);
      this.logger.warn(`payments list: no amount for unknown Stripe currency ${currency}`);
    }
    return amount;
  }

  private async readStripe(
    tenantId: string,
    customerId: string | null,
    after: string | null,
  ): Promise<{ rows: Candidate[]; hasMore: boolean; unavailable: boolean }> {
    if (!customerId) return { rows: [], hasMore: false, unavailable: false };
    if (!this.stripe.isConfigured) return { rows: [], hasMore: false, unavailable: true };
    try {
      const res = await this.stripe.listPaidCustomerInvoices(
        customerId,
        { limit: PAYMENTS_PAGE_SIZE, ...(after ? { startingAfter: after } : {}) },
        INTERACTIVE_STRIPE_REQUEST,
      );
      const rows: Candidate[] = res.rows
        .filter((i: any) => typeof i?.id === "string")
        .map((i: any) => ({
          source: "stripe" as const,
          at: (Number(i.created) || 0) * 1000,
          row: {
            id: i.id,
            source: "stripe" as const,
            date: new Date((Number(i.created) || 0) * 1000).toISOString(),
            amount: this.stripeAmount(Number(i.amount_paid) || 0, String(i.currency ?? "usd")),
            currency: String(i.currency ?? "usd").toUpperCase(),
            paidAt: Number(i.status_transitions?.paid_at)
              ? new Date(Number(i.status_transitions.paid_at) * 1000).toISOString()
              : null,
            paidDayLabel: null,
            number: typeof i.number === "string" ? i.number : null,
            receiptUrl: typeof i.hosted_invoice_url === "string" ? i.hosted_invoice_url : null,
          },
        }));
      return { rows, hasMore: res.hasMore, unavailable: false };
    } catch (err) {
      this.logger.warn(
        `payments list: Stripe unavailable for tenant ${tenantId}: ${(err as Error)?.message ?? err}`,
      );
      return { rows: [], hasMore: false, unavailable: true };
    }
  }

  private async readRouteFlow(
    tenantId: string,
    before: PaymentsCursor["rfBefore"],
  ): Promise<{ rows: Candidate[]; hasMore: boolean }> {
    const t = before ? new Date(before.t) : null;
    const found: any[] = await this.prisma.rfInvoice.findMany({
      where: {
        tenantId,
        status: "PAID",
        ...(before && t
          ? { OR: [{ issuedAt: { lt: t } }, { issuedAt: t, id: { lt: before.id } }] }
          : {}),
      },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      // One extra row only tells us whether another page exists.
      take: PAYMENTS_PAGE_SIZE + 1,
      select: {
        id: true,
        number: true,
        amount: true,
        currency: true,
        issuedAt: true,
        paidAt: true,
      },
    });
    const rows: Candidate[] = found.slice(0, PAYMENTS_PAGE_SIZE).map((r) => ({
      source: "routeflow" as const,
      at: new Date(r.issuedAt).getTime(),
      row: {
        id: r.id,
        source: "routeflow" as const,
        date: new Date(r.issuedAt).toISOString(),
        amount: roundMoney(Number(r.amount)),
        currency: String(r.currency ?? "USD").toUpperCase(),
        paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
        paidDayLabel: null,
        number: r.number ?? null,
        receiptUrl: null,
      },
    }));
    return { rows, hasMore: found.length > PAYMENTS_PAGE_SIZE };
  }
}

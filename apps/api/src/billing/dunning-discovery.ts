import { type DunningDeps, dunningEligible, isOwed } from "./dunning-core";
import { type PagedRow, forEachRotated } from "./dunning-paging";
import { invoiceOwedSince } from "./dunning-resolve";
import { stampClock } from "./dunning-stamp";
import { HOUR_MS } from "./dunning-config";

/** A finalized open invoice younger than this is left alone: Stripe may still be about to collect it. */
export const DISCOVERY_MIN_AGE_HOURS = 24;
const DAY_MS = 24 * HOUR_MS;

export interface DiscoveryOutcome {
  tenants: number;
  stamped: number;
  failed: number;
}

export interface DiscoveryOptions {
  /** Tenant budget for one run (default 2000); over budget the start rotates daily. */
  maxTenants?: number;
  batchSize?: number;
  timeBudgetMs?: number;
}

/** The population: Stripe-billed, not manual-pay, no catch-up claim, no clock yet. There is NO couponFull exemption. */
export const DISCOVERY_WHERE = {
  stripeSubId: { not: null },
  externalPayment: false,
  catchupState: null,
  pastDueInvoiceId: null,
  tenant: { deletedAt: null },
} as const;

/**
 * SA-733r M2 / SA-733r7 r-note (3): `invoice.payment_failed` only fires for an invoice Stripe ATTEMPTED. An open
 * invoice that was never attempted (marked unpaid, no card, auto-collection off) would run uncharged and unseen. Once
 * a day, for every Stripe-billed tenant without a clock, list its open invoices (all pages) and stamp the OLDEST one
 * that was finalized more than 24 h ago and still has money remaining - through the same stamp helper, so a clock is
 * written once per invoice. The invoice is re-read first (M8) and a payment still processing is skipped (N6).
 * `paid` / `void` / `uncollectible` never qualify (the list is `open` only and the status is re-checked), and the
 * clock starts at the invoice's finalization time (SA-733r M2). It sends nothing: the hourly sweep owns the notices.
 * `BILLING_PAUSE_MODE=off` does nothing.
 */
export async function discoverUnstamped(
  deps: DunningDeps,
  now: Date,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryOutcome> {
  const out: DiscoveryOutcome = { tenants: 0, stamped: 0, failed: 0 };
  if (deps.mode() === "off") return out;
  const cutoff = now.getTime() - DISCOVERY_MIN_AGE_HOURS * HOUR_MS;

  const visit = async (row: PagedRow) => {
    out.tenants++;
    if (!dunningEligible(row)) return; // belt and braces: the query already excludes these
    try {
      const open: any[] = await deps.stripe.listOpenSubscriptionInvoices(row.stripeSubId as string);
      const candidate = open.find(
        (i) =>
          i?.id &&
          i.status === "open" &&
          (i.amount_remaining ?? 0) > 0 &&
          invoiceOwedSince(i, now).getTime() <= cutoff,
      );
      if (!candidate) return;
      const facts = await deps.stripe.getInvoiceFacts(candidate.id);
      if (!isOwed(facts) || facts.paymentProcessing) return;
      if (await stampClock(deps, row.tenantId, candidate.id, invoiceOwedSince(candidate, now))) {
        out.stamped++;
        deps.logger.warn(
          `billing.dunning.discovered tenant=${row.tenantId} invoice=${candidate.id} (open, never stamped by payment_failed)`,
        );
      }
    } catch (err) {
      out.failed++;
      deps.logger.warn(
        `billing.dunning.discovery_failed tenant=${row.tenantId}: ${(err as Error)?.message}`,
      );
    }
  };

  await forEachRotated(
    deps.prisma,
    DISCOVERY_WHERE,
    now,
    {
      maxRows: opts.maxTenants ?? 2000,
      batchSize: opts.batchSize ?? 200,
      timeBudgetMs: opts.timeBudgetMs ?? 20 * 60_000,
      unitMs: DAY_MS,
    },
    visit,
  );
  return out;
}

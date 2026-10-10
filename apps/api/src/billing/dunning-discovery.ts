import { clockStartFor, logClockStarted } from "./dunning-clock";
import { type DunningDeps, dunningEligible, isOwed, isOwedInvoice } from "./dunning-core";
import { type PagedRow, forEachRotated } from "./dunning-paging";
import { invoiceOwedSince } from "./dunning-resolve";
import { DUNNING_CLEAR } from "./transition-to-active";
import { stampClock } from "./dunning-stamp";
import { lockTenantForLedger } from "./addon-ledger";
import { HOUR_MS } from "./dunning-config";

/** A finalized open invoice younger than this is left alone: Stripe may still be about to collect it. */
export const DISCOVERY_MIN_AGE_HOURS = 24;
const DAY_MS = 24 * HOUR_MS;

export interface DiscoveryOutcome {
  tenants: number;
  stamped: number;
  failed: number;
  /** phase 2: a clock whose invoice left `open` (void / uncollectible) while the tenant is ACTIVE: cleared */
  cleared: number;
  /** phase 2: ...or moved to the oldest still-open owed invoice */
  moved: number;
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

/** Phase 2 population: clocked, ACTIVE and unpaused, Stripe-billed, not manual-pay, no catch-up claim. */
export const SETTLE_WHERE = {
  stripeSubId: { not: null },
  externalPayment: false,
  catchupState: null,
  pastDueInvoiceId: { not: null },
  pausedAt: null,
  tenant: { deletedAt: null, status: "ACTIVE" },
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
  const out: DiscoveryOutcome = { tenants: 0, stamped: 0, failed: 0, cleared: 0, moved: 0 };
  if (deps.mode() === "off") return out;
  const cutoff = now.getTime() - DISCOVERY_MIN_AGE_HOURS * HOUR_MS;

  const visit = async (row: PagedRow) => {
    out.tenants++;
    if (!dunningEligible(row)) return; // belt and braces: the query already excludes these
    try {
      const open: any[] = await deps.stripe.listOpenSubscriptionInvoices(row.stripeSubId as string);
      const candidate = open.find(
        (i) => isOwedInvoice(i) && invoiceOwedSince(i, now).getTime() <= cutoff,
      );
      if (!candidate) return;
      const facts = await deps.stripe.getInvoiceFacts(candidate.id);
      if (!isOwed(facts) || facts.paymentProcessing) return;
      // r7 r-note 2: the clock starts at the STAMP time (a full notice runway), unless this invoice's d0 already went out
      const since = await clockStartFor(deps, row.tenantId, candidate.id, now);
      if (await stampClock(deps, row.tenantId, candidate.id, since)) {
        out.stamped++;
        deps.logger.warn(
          `billing.dunning.discovered tenant=${row.tenantId} invoice=${candidate.id} (open, never stamped by payment_failed)`,
        );
        logClockStarted(deps, {
          tenantId: row.tenantId,
          invoiceId: candidate.id,
          via: "discovery",
          stampAt: now,
          since,
          finalizedAt: invoiceOwedSince(candidate, now),
        });
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
      cursors: deps.cursors,
      cursorKey: "discovery",
    },
    visit,
  );

  // PHASE 2 (r7 r-note 1): a clocked invoice that left `open` (voided, or marked uncollectible = the owner's
  // write-off) while the tenant is ACTIVE. Clear the clock, or move it to the oldest still-open owed invoice. NO
  // status change and NO MRR row; a PAUSED tenant is not in this population (its exit stays admin activation).
  const settle = async (row: PagedRow) => {
    out.tenants++;
    if (!dunningEligible(row) || !row.pastDueInvoiceId) return;
    const clockId = row.pastDueInvoiceId;
    try {
      const facts = await deps.stripe.getInvoiceFacts(clockId);
      if (facts.status === "paid" || isOwed(facts)) return; // paid: invoice.paid / the sweep; open: still chased
      const open: any[] = await deps.stripe.listOpenSubscriptionInvoices(row.stripeSubId as string);
      const next = open.find((i) => isOwedInvoice(i) && i.id !== clockId) ?? null;
      const since = next ? await clockStartFor(deps, row.tenantId, next.id, now) : null;
      const done = await deps.prisma.$transaction(async (tx) => {
        await lockTenantForLedger(tx, row.tenantId);
        const r = await tx.tenantSubscription.updateMany({
          where: { tenantId: row.tenantId, pastDueInvoiceId: clockId, pausedAt: null },
          data: next
            ? { pastDueInvoiceId: next.id, pastDueSince: since as Date }
            : { ...DUNNING_CLEAR },
        });
        return r.count === 1;
      });
      if (!done) return;
      if (next) {
        out.moved++;
        logClockStarted(deps, {
          tenantId: row.tenantId,
          invoiceId: next.id,
          via: "moved",
          stampAt: now,
          since: since as Date,
          finalizedAt: invoiceOwedSince(next, now),
        });
      } else {
        out.cleared++;
        deps.logger.warn(
          `billing.dunning.clock_cleared tenant=${row.tenantId} invoice=${clockId} (left open: ${facts.status ?? "gone"})`,
        );
      }
    } catch (err) {
      out.failed++;
      deps.logger.warn(
        `billing.dunning.settle_failed tenant=${row.tenantId}: ${(err as Error)?.message}`,
      );
    }
  };
  await forEachRotated(
    deps.prisma,
    SETTLE_WHERE,
    now,
    {
      maxRows: opts.maxTenants ?? 2000,
      batchSize: opts.batchSize ?? 200,
      timeBudgetMs: opts.timeBudgetMs ?? 20 * 60_000,
      unitMs: DAY_MS,
      cursors: deps.cursors,
      cursorKey: "discovery-settle",
    },
    settle,
  );
  return out;
}

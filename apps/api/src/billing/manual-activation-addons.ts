import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { withAdvisoryLock, LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { billableAddonWhere } from "./addon-row";
import { emitAddonDelta } from "./addon-ledger";
import { BillingEventService } from "./billing-event.service";
import { writeManualInvoiceNotice } from "./manual-invoice-notice";
import { addonSkuCode, isAddonIncludedAtPlan, isSelfServiceAddon } from "./plan-catalog.constants";

const logger = new Logger("ManualActivationAddons");

/**
 * A self-serve add-on that still has no price (the rows are read with `billableAddonWhere`, so a comp —
 * a platform grant that is never billed, SA-693 `isComp` — never reaches this: it is a query predicate,
 * not a check that could be forgotten per call site).
 */
function isUnpricedSelfServeRow(row: {
  sku?: string | null;
  addonKey: string;
  priceSnapshot?: unknown;
}): boolean {
  const code = addonSkuCode({ sku: row.sku, addonKey: row.addonKey });
  return code != null && isSelfServiceAddon(code) && Number(row.priceSnapshot ?? 0) === 0;
}

/**
 * SKUs of the tenant's active self-serve add-ons that a MANUAL activation will have to price (see
 * `priceUnbilledAddonsOnActivation`): read BEFORE the activation transaction so the billing add-on locks
 * are taken first (the house order: add-on lock, then the tenant row lock inside the transaction).
 * Sorted, so two activations can never take the same locks in opposite orders.
 */
export async function unpricedSelfServeSkus(
  db: { tenantAddon: { findMany(args: any): Promise<any[]> } },
  tenantId: string,
): Promise<string[]> {
  const rows = await db.tenantAddon.findMany({
    where: billableAddonWhere({ tenantId, active: true, stripeItemId: null }),
  });
  const skus = rows
    .filter(isUnpricedSelfServeRow)
    .map((r) => addonSkuCode({ sku: r.sku, addonKey: r.addonKey }) as string);
  return [...new Set(skus)].sort();
}

/**
 * Runs `fn` while holding the shared `addon:<tenant>:<sku>` billing lock of every SKU (the key
 * enable/disable/adoption hold), taken in sorted order. A lock that cannot be had is a 503 — nothing
 * has been written when it is thrown.
 */
export async function withAddonLocks<T>(
  tenantId: string,
  skus: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const run = async (i: number): Promise<T> => {
    if (i >= skus.length) return fn();
    const result = await withAdvisoryLock(
      { family: "billing", key: `addon:${tenantId}:${skus[i]}`, mode: "wait", waitMs: 10_000 },
      () => run(i + 1),
    ).catch((e: unknown) => {
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        logger.error(`Add-on "${skus[i]}" lock unavailable for tenant ${tenantId}: ${e.message}`);
        throw new ServiceUnavailableException(
          `Could not serialise add-on "${skus[i]}" for tenant ${tenantId} — retry shortly`,
        );
      }
      throw e;
    });
    if (!result.acquired) {
      throw new ServiceUnavailableException(
        `Could not serialise add-on "${skus[i]}" for tenant ${tenantId} — lock unavailable`,
      );
    }
    return result.value;
  };
  return run(0);
}

export interface PricedAddon {
  sku: string;
  quantity: number;
  monthlyPrice: number;
}

/**
 * SA-668c residual ("price them + notify"): a trial's self-serve add-ons are on at price 0 with no
 * Stripe item. A MANUAL activation turns the tenant into one the owner invoices by hand, so each such
 * row is priced at TODAY's catalog price (money rounded to cents), its MRR delta booked ONCE
 * ({0, qty} → {price, qty}) and the platform told to add it to the next manual invoice
 * (ADDON_MANUAL_INVOICE_DUE, kind "add"). Otherwise it would stay free forever.
 *
 * Runs INSIDE the activation transaction (after the tenant row lock and the crossing), under the
 * add-on locks `withAddonLocks` holds. Idempotent: only an unbilled, un-priced, NON-comp, ACTIVE
 * self-serve row qualifies, so a re-activation (rows now priced) or a Stripe-billed row books nothing
 * and writes no second notice. A SKU the plan already bundles, one the catalog no longer prices and
 * a free (0) catalog price are left alone. The row write is a compare-and-swap, so a concurrent
 * pricing cannot book twice.
 */
export async function priceUnbilledAddonsOnActivation(
  tx: any,
  events: BillingEventService,
  a: {
    tenantId: string;
    tenantLabel: string;
    planKey: string;
    catalogAddons: ReadonlyArray<{
      sku: string;
      name: string;
      monthlyPrice: unknown;
      includedAtPlan?: string | null;
    }>;
    actorId?: string | null;
  },
): Promise<PricedAddon[]> {
  const rows: any[] = await tx.tenantAddon.findMany({
    where: billableAddonWhere({ tenantId: a.tenantId, active: true, stripeItemId: null }),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const priced: PricedAddon[] = [];
  for (const row of rows.filter(isUnpricedSelfServeRow)) {
    const sku = addonSkuCode({ sku: row.sku, addonKey: row.addonKey }) as string;
    const def = a.catalogAddons.find((c) => c.sku === sku);
    if (!def) {
      logger.error(
        `Manual activation for tenant ${a.tenantId}: add-on "${sku}" is not in the published catalog — left unpriced`,
      );
      continue;
    }
    if (isAddonIncludedAtPlan(def.includedAtPlan, a.planKey)) continue;
    const price = roundMoney(Number(def.monthlyPrice));
    if (!(price > 0)) continue;
    const quantity = Math.max(1, Number(row.quantity) || 1);

    const { count } = await tx.tenantAddon.updateMany({
      where: {
        ...billableAddonWhere({ id: row.id, active: true, stripeItemId: null }),
        OR: [{ priceSnapshot: null }, { priceSnapshot: 0 }],
      },
      data: { priceSnapshot: price },
    });
    if (count !== 1) continue;
    await emitAddonDelta(tx, events, {
      tenantId: a.tenantId,
      sku,
      before: { priceSnapshot: 0, quantity },
      after: { priceSnapshot: price, quantity },
      actorId: a.actorId,
      payload: { quantity, billed: false, source: "manual_activation" },
    });
    await writeManualInvoiceNotice(tx, {
      tenantId: a.tenantId,
      actorId: a.actorId,
      action: AdminAuditAction.ADDON_MANUAL_INVOICE_DUE,
      sku,
      quantity,
      monthlyPrice: price,
      kind: "add",
      addonName: def.name,
      fromQty: 0,
      toQty: quantity,
      message: `Add-on ${def.name} enabled for ${a.tenantLabel}: add to their next manual invoice`,
    });
    priced.push({ sku, quantity, monthlyPrice: price });
  }
  return priced;
}

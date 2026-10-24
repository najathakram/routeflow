import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { withAdvisoryLocks, LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { billableAddonWhere, keepsTrialAddons } from "./addon-row";
import { emitAddonDelta } from "./addon-ledger";
import { updateAddonRowsTx } from "./tenant-addon-writer";
import { BillingEventService } from "./billing-event.service";
import { cyclePrice, Cycle } from "./billing-math";
import { includedAtPlanVerdict } from "./addon-catalog-invalid";
import { writeAdminNotice, writeManualInvoiceNotice } from "./manual-invoice-notice";
import { addonSkuCode, isSelfServiceAddon } from "./plan-catalog.constants";
import type { ActivationAddonChange, ActivationAddonState } from "@routeflow/types";

const logger = new Logger("ManualActivationAddons");

/**
 * Is this row one of the tenant's self-serve add-ons? (The rows are read with `billableAddonWhere`, so a
 * comp — a platform grant that is never billed, SA-693 `isComp` — never reaches here: it is a query
 * predicate, not a check that could be forgotten per call site.)
 */
function isSelfServeRow(row: { sku?: string | null; addonKey: string }): boolean {
  const code = addonSkuCode({ sku: row.sku, addonKey: row.addonKey });
  return code != null && isSelfServiceAddon(code);
}

/** A row with no price yet: stored snapshot 0 or NULL (the only rows whose MRR is booked at activation). */
const isUnpriced = (row: { priceSnapshot?: unknown }): boolean =>
  Number(row.priceSnapshot ?? 0) === 0;

/**
 * SKUs of the tenant's active, non-comp self-serve add-ons with no Stripe item (priced or not): the ones a
 * MANUAL activation prices and/or announces (see `priceUnbilledAddonsOnActivation`). Read BEFORE the
 * activation transaction so the billing add-on locks are taken first (the house order: add-on lock, then
 * the tenant row lock inside the transaction). Sorted, so two activations can never take the same locks
 * in opposite orders.
 */
export async function unbilledSelfServeSkus(
  db: { tenantAddon: { findMany(args: any): Promise<any[]> } },
  tenantId: string,
): Promise<string[]> {
  const rows = await db.tenantAddon.findMany({
    where: billableAddonWhere({ tenantId, active: true, stripeItemId: null }),
  });
  const skus = rows
    .filter(isSelfServeRow)
    .map((r) => addonSkuCode({ sku: r.sku, addonKey: r.addonKey }) as string);
  return [...new Set(skus)].sort();
}

/**
 * Runs `fn` while holding the shared `addon:<tenant>:<sku>` billing lock of every SKU (the key
 * enable/disable/adoption hold). `withAdvisoryLocks` takes them together on ONE pinned connection, in
 * sorted order (no nested single-key locks pinning a pool slot each). A lock that cannot be had is a
 * 503 — nothing has been written when it is thrown. No SKU, no lock.
 */
export async function withAddonLocks<T>(
  tenantId: string,
  skus: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  if (skus.length === 0) return fn();
  try {
    return await withAdvisoryLocks(
      {
        family: "billing",
        keys: skus.map((sku) => `addon:${tenantId}:${sku}`),
        waitMs: 10_000,
      },
      fn,
    );
  } catch (e: unknown) {
    if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
      logger.error(`Add-on locks unavailable for tenant ${tenantId}: ${e.message}`);
      throw new ServiceUnavailableException(
        `Could not serialise the add-ons of tenant ${tenantId} — retry shortly`,
      );
    }
    throw e;
  }
}

export interface ActivatedAddon {
  sku: string;
  quantity: number;
  monthlyPrice: number;
  /** Its price was written and its MRR delta booked by THIS call. */
  priced: boolean;
  /** A DUE notice was written by THIS call. */
  noticed: boolean;
  /** Why the row could not be priced (the notice then tells the owner to complete it). */
  reason?: "price_unknown" | "quantity_missing";
}

/** The manual-invoice notice state of one SKU: true when the LATEST notice for it is a DUE (not a STOP). */
async function manualInvoiceIsDue(tx: any, tenantId: string, sku: string): Promise<boolean> {
  const latest = await tx.auditLog.findFirst({
    where: {
      tenantId,
      entityType: ADMIN_AUDIT_ENTITY,
      action: {
        in: [AdminAuditAction.ADDON_MANUAL_INVOICE_DUE, AdminAuditAction.ADDON_MANUAL_INVOICE_STOP],
      },
      meta: { path: ["sku"], equals: sku },
    },
    orderBy: [{ createdAt: "desc" }],
    select: { action: true },
  });
  return latest?.action === AdminAuditAction.ADDON_MANUAL_INVOICE_DUE;
}

const dollars = (n: number): string => `$${roundMoney(n).toFixed(2)}`;

/**
 * SA-668c residual ("price them + notify"): a trial's self-serve add-ons are on at price 0 with no
 * Stripe item. The MANUAL activation that turns the trial into a tenant the owner invoices by hand is
 * the ONE moment they are priced and announced — the activation of a TRIAL, or of a LAPSED trial (READ_ONLY
 * with trial_expired / trial_cancelled; MUST-A1, `keepsTrialAddons`) and nothing else (M-A): a renewal of an
 * already-ACTIVE manual tenant (or any other prior status, such as READ_ONLY after a cancelled paid
 * subscription) prices NOTHING, books nothing and writes no notice, whatever add-on rows it carries. Inside
 * that activation:
 *  - each row with NO price (snapshot 0/null) AND a usable quantity AND a catalog price > 0 is priced at
 *    TODAY's catalog price (cents) and its MRR delta booked ONCE ({0, qty} → {price, qty}) — MRR is always
 *    monthly, whatever the tenant's invoice cycle;
 *  - EVERY such row (priced now, already priced but with no Stripe item, or one that could not be
 *    priced) gets the ADDON_MANUAL_INVOICE_DUE notice, so the owner invoices it. A row whose price is
 *    unknown (not in the catalog, or free) or whose quantity is below 1 is NOT priced — the notice says
 *    "price unknown / quantity missing — set it before invoicing"; a 0 row is never booked at price × 1.
 *    An ANNUAL tenant's notice carries the cycle and the per-cycle amount (annual price × quantity);
 *  - the notice is IDEMPOTENT (skipped when the latest manual notice for that SKU is already a DUE) and
 *    is never written for a tenant that is not PRODUCTION class (a test/demo tenant is never invoiced).
 *
 * Runs INSIDE the activation transaction (after the tenant row lock and the crossing), under the
 * add-on locks `withAddonLocks` holds. A Stripe-billed row, a comp, and a SKU the plan already bundles are
 * left alone. The row write is a compare-and-swap scoped to the tenant, so a concurrent pricing cannot
 * book twice.
 */
export async function priceUnbilledAddonsOnActivation(
  tx: any,
  events: BillingEventService,
  a: {
    tenantId: string;
    tenantLabel: string;
    /** The tenant's status BEFORE this activation, read in the tx under the tenant row lock. */
    fromStatus: string;
    /** `Tenant.readOnlyReason` BEFORE it (a lapsed trial is READ_ONLY + trial_expired / trial_cancelled). */
    readOnlyReason?: string | null;
    /** The tenant's class (DUE notices are written for PRODUCTION only; default PRODUCTION). */
    tenantClass?: string;
    /** The invoice cycle of the activation (default MONTHLY). */
    cycle?: Cycle;
    planKey: string;
    catalogAddons: ReadonlyArray<{
      sku: string;
      name: string;
      monthlyPrice: unknown;
      includedAtPlan?: string | null;
    }>;
    actorId?: string | null;
  },
): Promise<ActivatedAddon[]> {
  // M-A + MUST-A1: only a TRIAL, or a LAPSED trial (READ_ONLY because it expired or was cancelled), is
  // priced — the same predicate that keeps its add-ons across a plan pick. A renewal, or a READ_ONLY tenant
  // whose paid subscription was cancelled, prices nothing.
  if (!keepsTrialAddons({ status: a.fromStatus, readOnlyReason: a.readOnlyReason })) return [];
  const cycle: Cycle = a.cycle ?? "MONTHLY";
  const announce = (a.tenantClass ?? "PRODUCTION") === "PRODUCTION";
  const rows: any[] = await tx.tenantAddon.findMany({
    where: billableAddonWhere({ tenantId: a.tenantId, active: true, stripeItemId: null }),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const done: ActivatedAddon[] = [];
  for (const row of rows.filter(isSelfServeRow)) {
    const sku = addonSkuCode({ sku: row.sku, addonKey: row.addonKey }) as string;
    const def = a.catalogAddons.find((c) => c.sku === sku);
    const verdict = def ? includedAtPlanVerdict(def, a.planKey) : null;
    if (verdict?.kind === "INCLUDED") continue;
    if (verdict?.kind === "CATALOG_INVALID") {
      // B1102: never price a row against a catalog entry that names no plan; leave it as it is and say so.
      logger.error(
        `Manual activation: add-on "${sku}" catalog includedAtPlan "${verdict.value}" names no plan — left unpriced`,
      );
      await writeAdminNotice(tx, {
        tenantId: a.tenantId,
        actorId: a.actorId,
        action: AdminAuditAction.ADDON_CATALOG_INVALID,
        message: `Add-on ${sku} for ${a.tenantLabel} was not priced: the catalog's includedAtPlan "${verdict.value}" is not a plan — fix the catalog entry.`,
        meta: { sku, value: verdict.value },
      });
      continue;
    }
    const name = def?.name ?? sku;
    const rawQty = Number(row.quantity);
    const quantity = Number.isFinite(rawQty) && rawQty >= 1 ? rawQty : 0;

    let price = 0;
    let priced = false;
    let reason: ActivatedAddon["reason"];
    if (quantity < 1) {
      // Never book price × 1 against a row that has no quantity: say so instead.
      reason = "quantity_missing";
      price = isUnpriced(row)
        ? def
          ? roundMoney(Number(def.monthlyPrice) || 0)
          : 0
        : roundMoney(Number(row.priceSnapshot));
      if (!(price > 0)) price = 0;
    } else if (isUnpriced(row)) {
      price = def ? roundMoney(Number(def.monthlyPrice)) : 0;
      if (!(price > 0)) {
        price = 0;
        reason = "price_unknown";
        logger.error(
          `Manual activation for tenant ${a.tenantId}: add-on "${sku}" has no catalog price — left unpriced`,
        );
      } else {
        const { count } = await updateAddonRowsTx(tx, events, {
          where: {
            ...billableAddonWhere({
              id: row.id,
              tenantId: a.tenantId,
              active: true,
              stripeItemId: null,
            }),
            OR: [{ priceSnapshot: null }, { priceSnapshot: 0 }],
          },
          data: { priceSnapshot: price },
          actor: {
            kind: "PLATFORM_ADMIN",
            id: a.actorId ?? null,
            source: "manual_activation.price",
          },
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
        priced = true;
      }
    } else {
      // Already carries a price (e.g. an earlier manual enable) but no Stripe item: already booked, so no
      // MRR here — it only needs to be on the owner's invoice.
      price = roundMoney(Number(row.priceSnapshot));
    }

    const noticed = announce && !(await manualInvoiceIsDue(tx, a.tenantId, sku));
    if (noticed) {
      const cycleAmount = roundMoney(cyclePrice(price, cycle) * quantity);
      const message =
        reason === "quantity_missing"
          ? `Add-on ${name} enabled for ${a.tenantLabel}: quantity missing — set it before invoicing`
          : reason === "price_unknown"
            ? `Add-on ${name} enabled for ${a.tenantLabel}: price unknown — set it before invoicing`
            : cycle === "ANNUAL"
              ? `Add-on ${name} enabled for ${a.tenantLabel}: add ${dollars(cycleAmount)} per year to their next manual invoice (annual billing)`
              : `Add-on ${name} enabled for ${a.tenantLabel}: add to their next manual invoice`;
      await writeManualInvoiceNotice(tx, {
        tenantId: a.tenantId,
        actorId: a.actorId,
        action: AdminAuditAction.ADDON_MANUAL_INVOICE_DUE,
        sku,
        quantity,
        monthlyPrice: price,
        kind: "add",
        addonName: name,
        fromQty: 0,
        toQty: quantity,
        message,
        ...(cycle === "ANNUAL" && !reason ? { cycle, cycleAmount } : {}),
        ...(reason ? { reason } : {}),
      });
    }
    done.push({
      sku,
      quantity,
      monthlyPrice: price,
      priced,
      noticed,
      ...(reason ? { reason } : {}),
    });
  }
  return done;
}

/**
 * SA-788 (c): the tenant's add-on rows as the activation result shows them (`ManualActivationResult.addons`). Read
 * UNDER the tenant row lock at the start of the activation and again just before commit.
 */
export async function readActivationAddons(
  tx: { tenantAddon: { findMany(args: any): Promise<any[]> } },
  tenantId: string,
  catalogAddons: ReadonlyArray<{ sku: string; name: string }>,
): Promise<ActivationAddonState[]> {
  const rows = await tx.tenantAddon.findMany({
    where: { tenantId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return (rows ?? []).map((r) => {
    const sku = addonSkuCode({ sku: r.sku, addonKey: r.addonKey });
    return {
      addonKey: r.addonKey,
      sku,
      name: catalogAddons.find((c) => c.sku === sku)?.name ?? sku ?? r.addonKey,
      active: r.active === true,
      priceSnapshot: r.priceSnapshot != null ? Number(r.priceSnapshot) : null,
      isComp: r.isComp === true,
    };
  });
}

/** Per-field changes between two reads of the same rows (a row new to `after` counts as changed from nothing). */
export function diffActivationAddons(
  before: readonly ActivationAddonState[],
  after: readonly ActivationAddonState[],
): ActivationAddonChange[] {
  const out: ActivationAddonChange[] = [];
  for (const a of after) {
    const b = before.find((x) => x.addonKey === a.addonKey);
    for (const field of ["active", "priceSnapshot", "isComp"] as const) {
      const was = b ? b[field] : field === "priceSnapshot" ? null : false;
      if (was !== a[field]) out.push({ addonKey: a.addonKey, field, before: was, after: a[field] });
    }
  }
  return out;
}

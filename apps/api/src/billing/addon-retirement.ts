import type { Prisma } from "@prisma/client";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { emitAddonDelta } from "./addon-ledger";
import { BillingEventService } from "./billing-event.service";
import { writeManualInvoiceNotice } from "./manual-invoice-notice";
import { addonSkuCode, isAddonIncludedAtPlan } from "./plan-catalog.constants";
import { planChangeAddonsChanged, type PlanChangeProration } from "./plan-change-stripe";

/**
 * SA-733 D8 / B1103: a plan the catalog bundles an add-on into must not keep BILLING that add-on. On an
 * upgrade each active add-on row whose SKU the NEW plan includes (`includedAtPlan`, the same rule the
 * choose-plan quote prices with) is retired: its Stripe item is deleted inside the single plan-change
 * `subscriptions.update` (plan-change-stripe.ts), then — in the upgrade's own transaction — the row goes
 * inactive, its MRR contribution books to 0 exactly once, and a manual-pay tenant gets a STOP notice. A comp
 * row (`isComp`) is a platform grant that was never billed: it is deactivated with no Stripe item and no ledger
 * delta.
 */

export interface AddonSkuDef {
  sku: string;
  name: string;
  includedAtPlan?: string | null;
}

/** The slice of a TenantAddon row retirement reads. */
export interface AddonRowLike {
  id: string;
  addonKey: string;
  sku?: string | null;
  quantity: number;
  priceSnapshot?: unknown;
  stripeItemId?: string | null;
  isComp?: boolean | null;
  active?: boolean | null;
}

export type RetiredAddon<R extends AddonRowLike = AddonRowLike> = R & {
  code: string;
  name: string;
};

/**
 * The active rows whose SKU `toPlanKey` already includes. Pure. FLAT SKUs only: a row holding more than one
 * unit (a stackable SKU such as extra seats) is never retired wholesale — the plan bundles the SKU, not the
 * units the tenant bought on top, so switching the row off would drop paid-for units.
 */
export function addonsIncludedAtPlan<R extends AddonRowLike>(
  rows: readonly R[],
  addonSkus: readonly AddonSkuDef[],
  toPlanKey: string,
): RetiredAddon<R>[] {
  const out: RetiredAddon<R>[] = [];
  for (const row of rows) {
    if (row.active === false || Number(row.quantity) > 1) continue;
    const code = addonSkuCode({ sku: row.sku, addonKey: row.addonKey });
    const def = code ? addonSkus.find((s) => s.sku === code) : undefined;
    if (code && def && isAddonIncludedAtPlan(def.includedAtPlan, toPlanKey)) {
      out.push({ ...row, code, name: def.name });
    }
  }
  return out;
}

/** The tenant's active add-ons that `toPlanKey` already includes (the choose-plan preview's list). */
export async function readRetiredAddons(
  db: { tenantAddon: { findMany(args: any): Promise<unknown> } },
  tenantId: string,
  addonSkus: readonly AddonSkuDef[],
  toPlanKey: string,
): Promise<RetiredAddon[]> {
  const rows = (await db.tenantAddon.findMany({
    where: { tenantId, active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as AddonRowLike[];
  return addonsIncludedAtPlan(rows, addonSkus, toPlanKey);
}

/** What the plan-change push settled in Stripe — the retirement transaction proves its rows against it. */
export interface PlanChangeCtx {
  /** True when a Stripe update was sent. */
  pushed: boolean;
  /** Add-on item ids confirmed gone from Stripe (deleted now, or already absent). */
  settledItemIds: ReadonlySet<string>;
  /** The push's per-attempt idempotency key — recorded on the attempt's ledger event (SA-733r3 N4). */
  idempotencyKey?: string;
  /** The proration behaviour actually SENT (`none` on a trialing / past_due / unpaid subscription). */
  proration?: PlanChangeProration;
}

/** No Stripe push happened (no subscription, Stripe off, a terminal subscription): nothing to prove. */
export const NO_STRIPE_PUSH: PlanChangeCtx = { pushed: false, settledItemIds: new Set() };

/**
 * Whether the owner invoices this tenant by hand (no Stripe subscription it is billed through, `externalPayment`
 * set — the same rule as the add-on billing mode), and the label its STOP notice names. ONE rule for the tenant
 * upgrade and the admin plan edit.
 */
export async function manualPayContext(
  prisma: { tenant: { findUnique(args: any): Promise<unknown> } },
  tenantId: string,
  stripeConfigured: boolean,
  sub: { stripeSubId?: string | null; externalPayment?: boolean | null } | null | undefined,
): Promise<{ manualPay: boolean; tenantLabel: string }> {
  const manualPay = !(stripeConfigured && sub?.stripeSubId) && sub?.externalPayment === true;
  if (!manualPay) return { manualPay, tenantLabel: "" };
  const t = (await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true, name: true },
  })) as { slug?: string | null; name?: string | null } | null;
  return { manualPay, tenantLabel: t?.name ?? t?.slug ?? tenantId };
}

export interface RetireArgs {
  tenantId: string;
  toPlanKey: string;
  toPlanName: string;
  addonSkus: readonly AddonSkuDef[];
  ctx: PlanChangeCtx;
  /** The owner invoices this tenant by hand (no Stripe item): its retired, priced rows get a STOP notice. */
  manualPay: boolean;
  tenantLabel: string;
  actorId?: string | null;
}

/**
 * Retire the included add-ons INSIDE the plan-change transaction (the Tenant row lock is already held — the
 * house order is Tenant, then TenantAddon rows, then the ledger). Re-reads the rows under a row lock, so a
 * row a concurrent disable already switched off books nothing twice. A row that still owns a Stripe item the
 * push did NOT settle (an add-on enabled after the push read Stripe) throws a 409: the whole plan change —
 * and, via the caller's compensation, the Stripe push — is undone, never half-applied. Returns the rows
 * retired.
 */
export async function retireIncludedAddonsTx(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  a: RetireArgs,
): Promise<RetiredAddon[]> {
  await tx.$queryRaw`SELECT id FROM "TenantAddon" WHERE "tenantId" = ${a.tenantId} AND active = true FOR UPDATE`;
  const rows = (await tx.tenantAddon.findMany({
    where: { tenantId: a.tenantId, active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as unknown as AddonRowLike[];
  const due = addonsIncludedAtPlan(rows, a.addonSkus, a.toPlanKey);
  for (const row of due) {
    const billedItem = !row.isComp && row.stripeItemId ? row.stripeItemId : null;
    if (billedItem && a.ctx.pushed && !a.ctx.settledItemIds.has(billedItem)) {
      throw planChangeAddonsChanged();
    }
    await tx.tenantAddon.update({
      where: { id: row.id },
      data: { active: false, stripeItemId: null },
    });
    if (row.isComp) continue; // a platform grant: never billed, never booked
    await emitAddonDelta(tx, events, {
      tenantId: a.tenantId,
      sku: row.code,
      before: { priceSnapshot: row.priceSnapshot, quantity: row.quantity },
      after: { priceSnapshot: 0, quantity: 0 },
      actorId: a.actorId,
      payload: { retiredByPlan: a.toPlanKey },
    });
    const price = Number(row.priceSnapshot ?? 0);
    if (a.manualPay && !row.stripeItemId && price > 0) {
      await writeManualInvoiceNotice(tx, {
        tenantId: a.tenantId,
        actorId: a.actorId,
        action: AdminAuditAction.ADDON_MANUAL_INVOICE_STOP,
        sku: row.code,
        quantity: row.quantity,
        monthlyPrice: price,
        kind: "stop",
        addonName: row.name,
        fromQty: row.quantity,
        toQty: 0,
        message: `Add-on ${row.name} is now included in ${a.toPlanName} for ${a.tenantLabel}: stop invoicing it`,
      });
    }
  }
  return due;
}

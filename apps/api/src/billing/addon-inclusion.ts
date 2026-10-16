import type { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type { AddonBillingMode } from "@routeflow/types";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import type { PrismaService } from "../prisma/prisma.service";
import { emitAddonDelta } from "./addon-ledger";
import { BillingEventService } from "./billing-event.service";
import { markNeedsReconcile } from "./needs-reconcile";
import { writeAdminNotice, writeManualInvoiceNotice } from "./manual-invoice-notice";
import {
  addonCatalogInvalidException,
  includedAtPlanVerdict,
  type IncludedVerdict,
} from "./addon-catalog-invalid";
import { PlanNotInCatalogError, addonSkuCode, findPlanDefinition } from "./plan-catalog.constants";
import type { PlanVersionWithCatalog } from "./plan-catalog.service";
import { planChangeAddonsChanged, type PlanChangeProration } from "./plan-change-stripe";
import { updateAddonRowTx, updateAddonRowsTx, type AddonActorKind } from "./tenant-addon-writer";

/**
 * SA-786 (owner ruling 2026-10-15, decisions/D-2026-10-15-included-addon-meaning): when the plan includes an
 * add-on, the add-on is FREE once enabled and stays opt-in. Moving UP to that plan stops billing it and keeps
 * it ON (price 0, Stripe item gone, the row never deactivated); moving BELOW that plan bills it at the catalog
 * price of the target version. Access is never decided here: the TenantAddon row stays the entitlement.
 *
 * This is the ONE module that answers "does a plan include an add-on" for a plan MOVE (nobody re-derives a rank):
 *  - {@link inclusionOf}                     the verdict (INCLUDED / NOT_INCLUDED / CATALOG_INVALID);
 *  - {@link addonsEnteringInclusion}         rows a move up starts to include (preview + the Stripe delete list);
 *  - {@link addonsLeavingInclusion}          rows a move down stops including (preview + the re-price);
 *  - {@link stopBillingIncludedAddonsTx}     the up-move write (price 0, item pointer cleared, row stays active);
 *  - {@link repriceAddonsLeavingInclusionTx} the down-move write for MANUAL and UNBILLED tenants;
 *  - {@link billLeavingAddonsAfterCommit}    the down-move Stripe item for STRIPE tenants (after commit).
 */

/** The ONE verdict of a catalog `includedAtPlan` against a plan key (B1102: an unparseable value fails closed). */
export const inclusionOf = includedAtPlanVerdict;
export type { IncludedVerdict };

export interface AddonSkuDef {
  sku: string;
  name: string;
  includedAtPlan?: string | null;
  monthlyPrice?: unknown;
}

/** The slice of a TenantAddon row the inclusion helpers read. */
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

export type InclusionAddon<R extends AddonRowLike = AddonRowLike> = R & {
  code: string;
  name: string;
};

/** A row that leaves inclusion, with the catalog price (cents-rounded) it is re-priced at. */
export type LeavingAddon<R extends AddonRowLike = AddonRowLike> = InclusionAddon<R> & {
  monthlyPrice: number;
};

const resolve = (row: AddonRowLike, skus: readonly AddonSkuDef[]) => {
  const code = addonSkuCode({ sku: row.sku, addonKey: row.addonKey });
  return code ? { code, def: skus.find((s) => s.sku === code) } : null;
};

/** B1102: a held add-on whose includedAtPlan names no plan fails the plan move closed (409), never "not included". */
function verdictOrThrow(def: AddonSkuDef, planKey: string | null | undefined): IncludedVerdict {
  const verdict = inclusionOf(def, planKey);
  if (verdict.kind === "CATALOG_INVALID") {
    throw addonCatalogInvalidException(verdict.sku, verdict.value);
  }
  return verdict;
}

/**
 * The active rows whose SKU `toPlanKey` includes and `fromPlanKey` did NOT (each side judged by its own catalog
 * version). Pure. A row already INCLUDED at `fromPlanKey` is skipped, so a SCALE to ENTERPRISE move is a no-op and
 * the preview does not list it again. FLAT SKUs only: a row holding more than one unit (a stackable SKU such as
 * extra seats) is never touched wholesale - the plan bundles the SKU, not the units bought on top.
 */
export function addonsEnteringInclusion<R extends AddonRowLike>(
  rows: readonly R[],
  fromSkus: readonly AddonSkuDef[],
  fromPlanKey: string | null | undefined,
  toSkus: readonly AddonSkuDef[],
  toPlanKey: string,
): InclusionAddon<R>[] {
  const out: InclusionAddon<R>[] = [];
  for (const row of rows) {
    if (row.active === false || Number(row.quantity) > 1) continue;
    const to = resolve(row, toSkus);
    if (!to?.def) continue;
    if (verdictOrThrow(to.def, toPlanKey).kind !== "INCLUDED") continue;
    const from = resolve(row, fromSkus);
    if (from?.def && fromPlanKey && verdictOrThrow(from.def, fromPlanKey).kind === "INCLUDED") {
      continue; // already included where the tenant is: nothing changes
    }
    out.push({ ...row, code: to.code, name: to.def.name });
  }
  return out;
}

/**
 * The active, non-comp rows that `fromPlanKey` includes and `toPlanKey` does NOT: the add-ons a downgrade starts
 * to bill at the TARGET version's catalog price. Pure; flat SKUs only. CATALOG_INVALID on either side throws 409
 * (B1102) unless a background caller passes `onInvalid`, which reports it and leaves the row alone.
 */
export function addonsLeavingInclusion<R extends AddonRowLike>(
  rows: readonly R[],
  fromSkus: readonly AddonSkuDef[],
  fromPlanKey: string | null | undefined,
  toSkus: readonly AddonSkuDef[],
  toPlanKey: string,
  opts: { onInvalid?: (sku: string, value: string) => void } = {},
): LeavingAddon<R>[] {
  const out: LeavingAddon<R>[] = [];
  for (const row of rows) {
    if (row.active === false || row.isComp || Number(row.quantity) > 1) continue;
    const from = resolve(row, fromSkus);
    const to = resolve(row, toSkus);
    if (!from?.def || !to?.def || !fromPlanKey) continue;
    const sides: [AddonSkuDef, string, IncludedVerdict["kind"]][] = [
      [from.def, fromPlanKey, "INCLUDED"],
      [to.def, toPlanKey, "NOT_INCLUDED"],
    ];
    let leaves = true;
    for (const [def, plan, want] of sides) {
      const verdict = inclusionOf(def, plan);
      if (verdict.kind === "CATALOG_INVALID") {
        if (!opts.onInvalid) throw addonCatalogInvalidException(verdict.sku, verdict.value);
        opts.onInvalid(verdict.sku, verdict.value);
        leaves = false;
        break;
      }
      if (verdict.kind !== want) {
        leaves = false;
        break;
      }
    }
    if (!leaves) continue;
    out.push({
      ...row,
      code: to.code,
      name: to.def.name,
      monthlyPrice: roundMoney(Number(to.def.monthlyPrice ?? 0)),
    });
  }
  return out;
}

/** The tenant's active add-ons that `toPlanKey` newly includes (the choose-plan upgrade preview's list). */
export async function readEnteringInclusion(
  db: { tenantAddon: { findMany(args: any): Promise<unknown> } },
  tenantId: string,
  fromSkus: readonly AddonSkuDef[],
  fromPlanKey: string | null | undefined,
  toSkus: readonly AddonSkuDef[],
  toPlanKey: string,
): Promise<InclusionAddon[]> {
  return addonsEnteringInclusion(
    await readActiveRows(db, tenantId),
    fromSkus,
    fromPlanKey,
    toSkus,
    toPlanKey,
  );
}

/** The tenant's active rows, oldest first (the order every inclusion read uses). */
export async function readActiveRows(
  db: { tenantAddon: { findMany(args: any): Promise<unknown> } },
  tenantId: string,
): Promise<AddonRowLike[]> {
  return (await db.tenantAddon.findMany({
    where: { tenantId, active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as AddonRowLike[];
}

/**
 * The tenant's add-on billing mode: ONE rule (B1079). STRIPE is checked FIRST: nothing ever clears
 * `externalPayment`, so a tenant that was manually activated and LATER pays by card carries both, and must be
 * billed through Stripe. Only without a live Stripe subscription does `externalPayment` mean "the owner invoices
 * by hand". A live subscription with `couponFull` (a 100% coupon) is UNBILLED.
 */
export function addonBillingModeOf(
  stripeConfigured: boolean,
  sub:
    | { stripeSubId?: string | null; externalPayment?: boolean | null; couponFull?: boolean | null }
    | null
    | undefined,
): AddonBillingMode {
  if (stripeConfigured && sub?.stripeSubId) return sub.couponFull === true ? "UNBILLED" : "STRIPE";
  if (sub?.externalPayment) return "MANUAL";
  return "UNBILLED";
}

/**
 * The version a scheduled move to `targetPlanKey` re-pins to: the tenant's PINNED (grandfathered) version when it
 * lists the plan, else the currently published one (a plan shipped after the pin). The cron's own resolution,
 * extracted unchanged so the preview prices from the same version the sweep re-pins to.
 */
export async function targetVersionFor(
  catalog: { getPublishedVersion(): Promise<PlanVersionWithCatalog | null> },
  pinned: PlanVersionWithCatalog,
  targetPlanKey: string,
): Promise<{
  version: PlanVersionWithCatalog;
  def: PlanVersionWithCatalog["definitions"][number];
}> {
  const pinnedDef = findPlanDefinition(pinned.definitions, targetPlanKey);
  if (pinnedDef) return { version: pinned, def: pinnedDef };
  const published = await catalog.getPublishedVersion();
  const def = published ? findPlanDefinition(published.definitions, targetPlanKey) : undefined;
  if (!published || !def) {
    throw new PlanNotInCatalogError(
      targetPlanKey,
      [pinned.id, published?.id].filter((x): x is string => Boolean(x)),
    );
  }
  return { version: published, def };
}

/** What the plan-change push settled in Stripe - the stop-billing transaction proves its rows against it. */
export interface PlanChangeCtx {
  /** True when a Stripe update was sent. */
  pushed: boolean;
  /** Add-on item ids confirmed gone from Stripe (deleted now, or already absent). */
  settledItemIds: ReadonlySet<string>;
  /** The push's per-attempt idempotency key - recorded on the attempt's ledger event (SA-733r3 N4). */
  idempotencyKey?: string;
  /** The live Stripe subscription was read though nothing was sent (a price that did not change). */
  live?: boolean;
  /** The proration behaviour actually SENT (`none` on a trialing / past_due / unpaid subscription). */
  proration?: PlanChangeProration;
}

/** No Stripe push happened (no subscription, Stripe off, a terminal subscription): nothing to prove. */
export const NO_STRIPE_PUSH: PlanChangeCtx = { pushed: false, settledItemIds: new Set() };

/**
 * Whether the owner invoices this tenant by hand (no Stripe subscription it is billed through, `externalPayment`
 * set - the same rule as the add-on billing mode), and the label its notices name. ONE rule for the tenant
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

export interface StopBillingArgs {
  tenantId: string;
  /** The plan being left and the version it is judged by (a row already included there is not touched). */
  fromPlanKey?: string | null;
  fromAddonSkus?: readonly AddonSkuDef[];
  toPlanKey: string;
  toPlanName: string;
  /** The target plan's catalog version SKUs. */
  addonSkus: readonly AddonSkuDef[];
  ctx: PlanChangeCtx;
  /** The owner invoices this tenant by hand (no Stripe item): its stopped, priced rows get a STOP notice. */
  manualPay: boolean;
  tenantLabel: string;
  actorId?: string | null;
  /** Who is acting, for the add-on change record (SA-788): the tenant, a platform admin, or the system. */
  actorKind: AddonActorKind;
}

/**
 * Stop billing the add-ons the new plan includes INSIDE the plan-change transaction (the Tenant row lock is
 * already held - the house order is Tenant, then TenantAddon rows, then the ledger). The row stays ACTIVE
 * (access is the row; billing state - price and Stripe item - is a separate field): `priceSnapshot` goes to 0 and
 * the item pointer clears. Re-reads the rows under a row lock, so a row a concurrent disable already switched off
 * books nothing twice. A row that still owns a Stripe item the push did NOT settle (an add-on enabled after the
 * push read Stripe) throws a 409: the whole plan change - and, via the caller's compensation, the Stripe push -
 * is undone, never half-applied. Returns the rows touched.
 */
export async function stopBillingIncludedAddonsTx(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  a: StopBillingArgs,
): Promise<InclusionAddon[]> {
  await tx.$queryRaw`SELECT id FROM "TenantAddon" WHERE "tenantId" = ${a.tenantId} AND active = true FOR UPDATE`;
  const due = addonsEnteringInclusion(
    await readActiveRows(tx, a.tenantId),
    a.fromAddonSkus ?? a.addonSkus,
    a.fromPlanKey,
    a.addonSkus,
    a.toPlanKey,
  );
  for (const row of due) {
    const billedItem = !row.isComp && row.stripeItemId ? row.stripeItemId : null;
    if (billedItem && (a.ctx.pushed || a.ctx.live) && !a.ctx.settledItemIds.has(billedItem)) {
      throw planChangeAddonsChanged();
    }
    await updateAddonRowTx(tx, events, {
      id: row.id,
      data: { priceSnapshot: 0, stripeItemId: null },
      actor: { kind: a.actorKind, id: a.actorId ?? null, source: "plan.stop_billing" },
    });
    if (row.isComp) continue; // a platform grant: never billed, never booked
    await emitAddonDelta(tx, events, {
      tenantId: a.tenantId,
      sku: row.code,
      before: { priceSnapshot: row.priceSnapshot, quantity: row.quantity },
      after: { priceSnapshot: 0, quantity: row.quantity },
      actorId: a.actorId,
      payload: { includedByPlan: a.toPlanKey },
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

export const usd = (n: number): string => `$${roundMoney(n).toFixed(2)}`;

export interface RepriceArgs {
  tenantId: string;
  fromPlanKey: string | null | undefined;
  fromAddonSkus: readonly AddonSkuDef[];
  toPlanKey: string;
  toPlanName: string;
  /** The target version's SKUs: the catalog price the row is re-priced at. */
  toAddonSkus: readonly AddonSkuDef[];
  mode: AddonBillingMode;
  tenantLabel: string;
  /** The formatted effective date the notice names ("November 11, 2026"). */
  dateLabel: string;
  actorId?: string | null;
  /** Background callers (the cron) log an unparseable includedAtPlan and carry on; users get the 409. */
  onInvalid?: (sku: string, value: string) => void;
  /** Who is acting, for the add-on change record (SA-788). */
  actorKind: AddonActorKind;
}

/**
 * A move BELOW the including plan, inside the plan-write transaction and AFTER the `planKey` write (so
 * `emitAddonDelta` judges paying on the NEW plan).
 *  - MANUAL: each $0 non-comp row with no item is re-priced to the target version's catalog price (a guarded
 *    update, so a replay or a concurrent price books nothing twice), +price once on the ledger, and a DUE notice
 *    tells the owner to invoice it.
 *  - UNBILLED: no write (it stays at $0 and bills nothing, as an unbilled enable does).
 *  - STRIPE: nothing here; the rows to bill are returned and billed AFTER commit
 *    ({@link billLeavingAddonsAfterCommit}).
 */
export async function repriceAddonsLeavingInclusionTx(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  a: RepriceArgs,
): Promise<{ repriced: LeavingAddon[]; toBill: LeavingAddon[] }> {
  if (a.mode === "UNBILLED") return { repriced: [], toBill: [] };
  await tx.$queryRaw`SELECT id FROM "TenantAddon" WHERE "tenantId" = ${a.tenantId} AND active = true FOR UPDATE`;
  const leaving = addonsLeavingInclusion(
    await readActiveRows(tx, a.tenantId),
    a.fromAddonSkus,
    a.fromPlanKey,
    a.toAddonSkus,
    a.toPlanKey,
    { onInvalid: a.onInvalid },
  ).filter((r) => !r.stripeItemId && Number(r.priceSnapshot ?? 0) === 0 && r.monthlyPrice > 0);
  if (a.mode === "STRIPE") return { repriced: [], toBill: leaving };

  const repriced: LeavingAddon[] = [];
  for (const row of leaving) {
    const { count } = await updateAddonRowsTx(tx, events, {
      where: {
        id: row.id,
        tenantId: a.tenantId,
        active: true,
        isComp: false,
        stripeItemId: null,
        OR: [{ priceSnapshot: null }, { priceSnapshot: 0 }],
      },
      data: { priceSnapshot: row.monthlyPrice },
      actor: { kind: a.actorKind, id: a.actorId ?? null, source: "plan.reprice" },
    });
    if (count !== 1) continue;
    repriced.push(row);
    await emitAddonDelta(tx, events, {
      tenantId: a.tenantId,
      sku: row.code,
      before: { priceSnapshot: 0, quantity: row.quantity },
      after: { priceSnapshot: row.monthlyPrice, quantity: row.quantity },
      actorId: a.actorId,
      payload: { reprice: "left_inclusion", fromPlan: a.fromPlanKey ?? null, toPlan: a.toPlanKey },
    });
    await writeManualInvoiceNotice(tx, {
      tenantId: a.tenantId,
      actorId: a.actorId,
      action: AdminAuditAction.ADDON_MANUAL_INVOICE_DUE,
      sku: row.code,
      quantity: row.quantity,
      monthlyPrice: row.monthlyPrice,
      kind: "add",
      addonName: row.name,
      fromQty: 0,
      toQty: row.quantity,
      message: `Add-on ${row.name} is no longer included in ${a.toPlanName} for ${a.tenantLabel}: invoice it at ${usd(row.monthlyPrice)} a month from ${a.dateLabel}`,
    });
  }
  return { repriced, toBill: [] };
}

/** The proration the post-commit Stripe item is created with (R1 note: a plan change is `always_invoice`). */
export interface LeavingBillOpts {
  prorationBehavior: "create_prorations" | "always_invoice";
  /** Pinned to the new period's start (sent as unix seconds): one full period on its own invoice. */
  prorationDate?: Date;
}

/** What the SubscriptionMutationService wrapper offers {@link billLeavingAddonsAfterCommit}. */
export interface LeavingBiller {
  billAddonsLeavingInclusion(
    tenantId: string,
    rows: readonly { id: string; code: string; quantity: number }[],
    toSkus: readonly AddonSkuDef[],
    source: "plan_change",
    opts: LeavingBillOpts,
  ): Promise<unknown>;
}

/**
 * STRIPE mode, AFTER the plan change committed. A throw never rolls the plan change back: the tenant is flagged
 * (`markNeedsReconcile`) and the platform gets one notice per add-on, naming what to bill by hand. SA-788(b)'s
 * daily invariant (I2) detects the leftover state.
 */
export async function billLeavingAddonsAfterCommit(
  deps: { prisma: PrismaService; logger: Pick<Logger, "error" | "warn"> },
  biller: LeavingBiller,
  a: {
    tenantId: string;
    tenantLabel: string;
    fromPlanName: string;
    stripeSubId?: string | null;
    rows: readonly LeavingAddon[];
    toSkus: readonly AddonSkuDef[];
    opts: LeavingBillOpts;
    actorId?: string | null;
  },
): Promise<boolean> {
  if (a.rows.length === 0) return true;
  try {
    await biller.billAddonsLeavingInclusion(a.tenantId, a.rows, a.toSkus, "plan_change", a.opts);
    return true;
  } catch (err) {
    await markNeedsReconcile(
      { prisma: deps.prisma, logger: deps.logger },
      {
        tenantId: a.tenantId,
        stripeSubId: a.stripeSubId ?? undefined,
        local: { leavingInclusion: a.rows.map((r) => r.code) },
        error: err,
      },
    );
    for (const r of a.rows) {
      await writeAdminNotice(deps.prisma, {
        tenantId: a.tenantId,
        actorId: a.actorId,
        action: AdminAuditAction.TENANT_CONFIG_UPDATED,
        message: `Add-on ${r.name} for ${a.tenantLabel} left ${a.fromPlanName} and could not be billed: bill it`,
        meta: {
          kind: "addon_leaving_inclusion_unbilled",
          sku: r.code,
          monthlyPrice: r.monthlyPrice,
        },
      }).catch(() => undefined);
    }
    return false;
  }
}

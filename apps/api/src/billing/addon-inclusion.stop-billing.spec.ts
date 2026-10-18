/**
 * A plan change that sent NOTHING to Stripe must never clear a billed add-on's Stripe item pointer: clearing it
 * (priceSnapshot 0, stripeItemId null, -price on the ledger) while the item is still live in Stripe keeps the
 * customer charged and loses the only pointer to the item. `subscribe()` calls `stopBillingIncludedAddonsTx` with
 * `NO_STRIPE_PUSH` and does not itself refuse a tenant with a live subscription, so the helper is the guard:
 * a non-comp row holding an item the context did not settle is a 409 (the caller's transaction rolls back).
 *
 * Unit lane (mocked transaction); the DB-backed twin is in plan-change-addon-retirement.db.spec.ts.
 */
import { ConflictException } from "@nestjs/common";
import {
  NO_LIVE_SUBSCRIPTION,
  NO_STRIPE_PUSH,
  noPushCtx,
  stopBillingIncludedAddonsTx,
  type PlanChangeCtx,
} from "./addon-inclusion";
import { PLAN_CHANGE_ADDONS_CHANGED } from "./plan-change-stripe";

const SKUS = [
  { sku: "REGULATED_ITEMS", name: "Regulated items", monthlyPrice: 39, includedAtPlan: "SCALE" },
];

const row = (over: Record<string, unknown> = {}) => ({
  id: "ta_reg",
  tenantId: "t1",
  addonKey: "REGULATED_ITEMS",
  sku: "REGULATED_ITEMS",
  quantity: 1,
  priceSnapshot: 39,
  stripeItemId: "si_live" as string | null,
  isComp: false,
  active: true,
  ...over,
});

function make(rows: Record<string, unknown>[]) {
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(rows),
      // The one writer (tenant-addon-writer.ts) locks, reads `before`, then updates.
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      ),
      update: jest.fn(({ where, data }: any) =>
        Promise.resolve({ ...(rows.find((r) => r.id === where.id) ?? {}), ...data }),
      ),
    },
    tenant: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "GROWTH", couponFull: false },
      }),
    },
  };
  const events: any = { emit: jest.fn().mockResolvedValue({}) };
  const run = (ctx: PlanChangeCtx) =>
    stopBillingIncludedAddonsTx(tx, events, {
      tenantId: "t1",
      fromPlanKey: "GROWTH",
      toPlanKey: "SCALE",
      toPlanName: "Scale",
      addonSkus: SKUS,
      ctx,
      manualPay: false,
      tenantLabel: "",
      actorId: "u1",
    });
  return { tx, events, run };
}

describe("stopBillingIncludedAddonsTx - a Stripe item is never orphaned", () => {
  it("NO_STRIPE_PUSH + a billed non-comp row holding a Stripe item: 409, no row write, no ledger event", async () => {
    const { tx, events, run } = make([row()]);
    await expect(run(NO_STRIPE_PUSH)).rejects.toThrow(PLAN_CHANGE_ADDONS_CHANGED);
    await expect(run(NO_STRIPE_PUSH)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.tenantAddon.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a push that settled the item lets the row clear (the Stripe delete happened first)", async () => {
    const { tx, run } = make([row()]);
    const ctx: PlanChangeCtx = { pushed: true, settledItemIds: new Set(["si_live"]) };
    await run(ctx);
    expect(tx.tenantAddon.update).toHaveBeenCalledWith({
      where: { id: "ta_reg" },
      data: { priceSnapshot: 0, stripeItemId: null },
    });
  });

  it("a row with no item (manual / unbilled) clears under NO_STRIPE_PUSH", async () => {
    const { tx, run } = make([row({ stripeItemId: null })]);
    await run(NO_STRIPE_PUSH);
    expect(tx.tenantAddon.update).toHaveBeenCalledTimes(1);
  });

  // A comp is never billed, so it is never expected to hold a live Stripe item.
  it("a COMP row owns no billed item: clears under NO_STRIPE_PUSH even with a stale pointer", async () => {
    const { tx, run } = make([row({ isComp: true })]);
    await run(NO_STRIPE_PUSH);
    expect(tx.tenantAddon.update).toHaveBeenCalledTimes(1);
  });

  it("NO_LIVE_SUBSCRIPTION (no subscription can hold the item): a stale pointer clears", async () => {
    const { tx, run } = make([row()]);
    await run(NO_LIVE_SUBSCRIPTION);
    expect(tx.tenantAddon.update).toHaveBeenCalledTimes(1);
  });

  it("noPushCtx: a stored Stripe subscription stays strict, none means stale pointers", () => {
    expect(noPushCtx("sub_1")).toBe(NO_STRIPE_PUSH);
    expect(noPushCtx(null)).toBe(NO_LIVE_SUBSCRIPTION);
    expect(noPushCtx(undefined)).toBe(NO_LIVE_SUBSCRIPTION);
  });
});

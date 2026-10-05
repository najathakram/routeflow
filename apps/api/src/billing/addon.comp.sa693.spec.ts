/**
 * SA-693 (owner ruling 2026-10-05 "Mark grants as comps"): the ADMIN writers of `TenantAddon.isComp`.
 *
 *   - `enableAddon(..., { comp: true })` is an EXPLICIT choice, never derived from "no Stripe item":
 *     isComp true, priceSnapshot 0, NO Stripe item even on a subscribed tenant (and even when a
 *     price id rides along), nothing booked.
 *   - a billed enable (comp absent/false) writes isComp false.
 *   - `uncompAddon` never silently starts billing: a tenant without a Stripe subscription only has
 *     the flag flipped; a subscribed one goes through the normal billed enable (price required).
 *   - the DISABLE path takes NO advisory lock (see the last describe).
 */
const mockWithAdvisoryLock = jest.fn(
  async (_opts: { key: string }, fn: () => Promise<unknown>) => ({
    acquired: true as const,
    value: await fn(),
  }),
);
const mockWithAdvisoryLocks = jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
  acquired: true as const,
  value: await fn(),
}));

jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  withAdvisoryLocks: mockWithAdvisoryLocks,
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { AddonService } from "./addon.service";
import { fakeTenantAddonStore } from "../testing/fake-tenant-addon-store";

beforeEach(() => {
  mockWithAdvisoryLock.mockClear();
  mockWithAdvisoryLocks.mockClear();
});

const PAYING_TENANT = {
  status: "ACTIVE",
  class: "PRODUCTION",
  deletedAt: null,
  subscription: { planKey: "SCALE" },
};

function make(
  opts: {
    rows?: Array<Record<string, unknown>>;
    stripeSubId?: string | null;
    create?: jest.Mock;
  } = {},
) {
  const store = fakeTenantAddonStore(opts.rows as any);
  const create = opts.create ?? jest.fn().mockResolvedValue({ id: "si_new" });
  const del = jest.fn().mockResolvedValue({});
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme" }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(PAYING_TENANT),
    },
    tenantAddon: store,
    tenantSubscription: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.stripeSubId === undefined ? null : { stripeSubId: opts.stripeSubId },
        ),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
  const stripe = { isConfigured: true, client: { subscriptionItems: { create, del } } } as any;
  const entitlements = { invalidate: jest.fn() } as any;
  const catalog = {
    getPublishedCatalog: jest.fn().mockResolvedValue({
      addonSkus: [{ sku: "REGULATED_ITEMS", name: "Regulated", monthlyPrice: 10 }],
    }),
  } as any;
  const featureResolver = { invalidate: jest.fn() } as any;
  const authority = { assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined) } as any;
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const svc = new (AddonService as any)(
    prisma,
    stripe,
    entitlements,
    catalog,
    featureResolver,
    authority,
    events,
  );
  return { svc: svc as AddonService, prisma, store, create, del, events };
}

const compRow = (over: Record<string, unknown> = {}) => ({
  tenantId: "t1",
  addonKey: "REGULATED_ITEMS",
  sku: "REGULATED_ITEMS",
  active: true,
  quantity: 1,
  priceSnapshot: 0,
  stripeItemId: null,
  isComp: true,
  ...over,
});

const bookedTypes = (events: any) => events.emit.mock.calls.map((c: any[]) => c[1]);

describe("SA-693 admin comp enable", () => {
  it("a comp enable on a SUBSCRIBED tenant creates NO Stripe item, writes isComp true at price 0, books nothing", async () => {
    const { svc, create, store, events } = make({ stripeSubId: "sub_1" });

    await svc.enableAddon("t1", "REGULATED_ITEMS", undefined, undefined, { comp: true });

    expect(create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      active: true,
      isComp: true,
      priceSnapshot: 0,
      stripeItemId: null,
    });
    expect(bookedTypes(events)).not.toContain("addon.enabled");
  });

  it("a comp enable ignores a stripePriceId that rides along: still no Stripe item", async () => {
    const { svc, create, store } = make({ stripeSubId: "sub_1" });

    await svc.enableAddon("t1", "REGULATED_ITEMS", "price_x", undefined, { comp: true });

    expect(create).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ isComp: true, priceSnapshot: 0, stripeItemId: null });
  });

  it("a comp enable re-activating an inactive BILLED-history row clears the item pointer and writes isComp true", async () => {
    const { svc, store } = make({
      stripeSubId: "sub_1",
      rows: [compRow({ active: false, isComp: false, priceSnapshot: 10, stripeItemId: null })],
    });

    await svc.enableAddon("t1", "REGULATED_ITEMS", undefined, undefined, { comp: true });

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ active: true, isComp: true, priceSnapshot: 0 });
  });

  it("a BILLED enable (no comp flag) writes isComp false and does create the Stripe item", async () => {
    const { svc, create, store } = make({ stripeSubId: "sub_1" });

    await svc.enableAddon("t1", "REGULATED_ITEMS", "price_x");

    expect(create).toHaveBeenCalledTimes(1);
    expect(store.rows[0]).toMatchObject({
      isComp: false,
      stripeItemId: "si_new",
      priceSnapshot: 10,
    });
  });

  it("an unflagged FREE enable (no price, no Stripe item) is NOT a comp: isComp stays false (never derived from 'no item')", async () => {
    const { svc, store } = make({ stripeSubId: "sub_1" });

    await svc.enableAddon("t1", "REGULATED_ITEMS");

    expect(store.rows[0]).toMatchObject({ isComp: false, stripeItemId: null, priceSnapshot: 0 });
  });

  it("a billed re-enable of a disabled comp row resets isComp to false", async () => {
    const { svc, store } = make({
      stripeSubId: "sub_1",
      rows: [compRow({ active: false })],
    });

    await svc.enableAddon("t1", "REGULATED_ITEMS", "price_x", undefined, { comp: false });

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ active: true, isComp: false, stripeItemId: "si_new" });
  });
});

describe("SA-693 admin uncomp", () => {
  it("on a tenant WITHOUT a Stripe subscription only flips the flag: no Stripe call, nothing booked, row stays unbilled", async () => {
    const { svc, create, store, events } = make({ rows: [compRow()] });

    await svc.uncompAddon("t1", "REGULATED_ITEMS");

    expect(create).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({
      active: true,
      isComp: false,
      stripeItemId: null,
      priceSnapshot: 0,
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("on a SUBSCRIBED tenant it refuses without a price (never a silent unbilled row), leaving the comp untouched", async () => {
    const { svc, create, store } = make({ stripeSubId: "sub_1", rows: [compRow()] });

    const attempt = svc.uncompAddon("t1", "REGULATED_ITEMS");

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ isComp: true, priceSnapshot: 0 });
  });

  it("on a SUBSCRIBED tenant with a price it goes through the billed path: item created, isComp false, +price booked", async () => {
    const { svc, create, store, events } = make({ stripeSubId: "sub_1", rows: [compRow()] });

    await svc.uncompAddon("t1", "REGULATED_ITEMS", "price_x");

    expect(create).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      active: true,
      isComp: false,
      stripeItemId: "si_new",
      priceSnapshot: 10,
    });
    expect(events.emit).toHaveBeenCalledWith(
      "t1",
      "addon.enabled",
      expect.anything(),
      expect.objectContaining({ amountDelta: 10 }),
    );
  });

  it("a Stripe failure on the billed uncomp leaves the comp row intact (nothing lost)", async () => {
    const create = jest.fn().mockRejectedValue(new Error("stripe down"));
    const { svc, store } = make({ stripeSubId: "sub_1", rows: [compRow()], create });

    await expect(svc.uncompAddon("t1", "REGULATED_ITEMS", "price_x")).rejects.toThrow();

    expect(store.rows[0]).toMatchObject({ active: true, isComp: true, priceSnapshot: 0 });
  });

  it("404s a tenant with no such row; 409s a row that is not an active comp", async () => {
    await expect(make().svc.uncompAddon("t1", "REGULATED_ITEMS")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      make({ rows: [compRow({ isComp: false })] }).svc.uncompAddon("t1", "REGULATED_ITEMS"),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      make({ rows: [compRow({ active: false })] }).svc.uncompAddon("t1", "REGULATED_ITEMS"),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("SA-693 disabling a comp row", () => {
  it("is allowed, deactivates it and books nothing (a comp contributes 0)", async () => {
    const { svc, store, events } = make({ rows: [compRow()] });

    await svc.disableAddon("t1", "REGULATED_ITEMS");

    expect(store.rows[0]).toMatchObject({ active: false });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("SA-671d: the admin add-on DISABLE path takes no advisory lock", () => {
  // Business-profile confirm (#3199 `withConfirmLock`) calls `disableAddon` WHILE it already holds
  // the add-on advisory keys. A lock taken inside disableAddon (this one, or any comp/uncomp helper
  // it reaches) would wait on a key its own caller holds and self-block the confirm. Row-level
  // `FOR UPDATE` inside the transaction is the only serialisation here, by design.
  it("disableAddon calls neither withAdvisoryLock nor withAdvisoryLocks", async () => {
    const { svc } = make({ rows: [compRow({ isComp: false, priceSnapshot: 10 })] });

    await svc.disableAddon("t1", "REGULATED_ITEMS");

    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
    expect(mockWithAdvisoryLocks).not.toHaveBeenCalled();
  });

  it("disabling a comp row takes no advisory lock either", async () => {
    const { svc } = make({ rows: [compRow()] });

    await svc.disableAddon("t1", "REGULATED_ITEMS");

    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
    expect(mockWithAdvisoryLocks).not.toHaveBeenCalled();
  });
});

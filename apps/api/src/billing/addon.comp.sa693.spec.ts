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
    /** A manually-invoiced tenant: externalPayment set, no Stripe subscription. */
    externalPayment?: boolean;
    create?: jest.Mock;
  } = {},
) {
  const store = fakeTenantAddonStore(opts.rows as any);
  const create = opts.create ?? jest.fn().mockResolvedValue({ id: "si_new" });
  const del = jest.fn().mockResolvedValue({});
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme", name: "Acme Foods" }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(PAYING_TENANT),
    },
    tenantAddon: store,
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(
        opts.stripeSubId === undefined && !opts.externalPayment
          ? null
          : {
              stripeSubId: opts.stripeSubId ?? null,
              externalPayment: opts.externalPayment ?? false,
            },
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
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
  return { svc: svc as AddonService, prisma, store, create, del, events, audit: prisma.auditLog };
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

  it("a comp enable never keeps a stale Stripe item pointer on the row", async () => {
    const { svc, store } = make({
      stripeSubId: "sub_1",
      rows: [compRow({ active: false, isComp: false, stripeItemId: "si_stale" })],
    });

    await svc.enableAddon("t1", "REGULATED_ITEMS", undefined, undefined, { comp: true });

    expect(store.rows[0]).toMatchObject({ isComp: true, stripeItemId: null });
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

  it("M3: a billed uncomp PRESERVES the comp's quantity: the Stripe item, the row and the booking all carry it", async () => {
    const { svc, create, store, events } = make({
      stripeSubId: "sub_1",
      rows: [compRow({ quantity: 3 })],
    });

    await svc.uncompAddon("t1", "REGULATED_ITEMS", "price_x");

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ quantity: 3 }));
    expect(store.rows[0]).toMatchObject({ isComp: false, quantity: 3, priceSnapshot: 10 });
    expect(events.emit).toHaveBeenCalledWith(
      "t1",
      "addon.enabled",
      expect.anything(),
      expect.objectContaining({ amountDelta: 30 }),
    );
  });

  it("the result says how it was billed: STRIPE / MANUAL / UNBILLED", async () => {
    const stripe = make({ stripeSubId: "sub_1", rows: [compRow()] });
    expect((await stripe.svc.uncompAddon("t1", "REGULATED_ITEMS", "price_x")).billing).toBe(
      "STRIPE",
    );
    const manual = make({ externalPayment: true, rows: [compRow()] });
    expect((await manual.svc.uncompAddon("t1", "REGULATED_ITEMS")).billing).toBe("MANUAL");
    const plain = make({ rows: [compRow()] });
    expect((await plain.svc.uncompAddon("t1", "REGULATED_ITEMS")).billing).toBe("UNBILLED");
  });

  it("a subscribed tenant while Stripe is NOT configured: refused with a coded 409, the comp untouched, nothing written", async () => {
    const m = make({ stripeSubId: "sub_1", rows: [compRow()] });
    (m.svc as any).stripe.isConfigured = false;

    const err: any = await m.svc.uncompAddon("t1", "REGULATED_ITEMS", "price_x").catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "ADDON_UNCOMP_STRIPE_UNAVAILABLE" });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.store.rows[0]).toMatchObject({ active: true, isComp: true, priceSnapshot: 0 });
  });

  it("a comp DISABLED between uncomp's read and the lock is refused under the lock: never re-activated and billed", async () => {
    const m = make({ stripeSubId: "sub_1", rows: [compRow({ active: false })] });
    // the pre-lock read still saw an active comp; the read under the lock sees the truth
    m.store.findFirst.mockImplementationOnce((async () => ({ id: "row1", ...compRow() })) as any);

    await expect(m.svc.uncompAddon("t1", "REGULATED_ITEMS", "price_x")).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(m.create).not.toHaveBeenCalled();
    expect(m.store.rows[0]).toMatchObject({ active: false, isComp: true, stripeItemId: null });
  });

  it("a comp disabled AFTER the Stripe item was created is refused in the transaction and the orphan item is deleted", async () => {
    const m = make({ stripeSubId: "sub_1", rows: [compRow({ active: false })] });
    const active = (async () => ({ id: "row1", ...compRow() })) as any;
    // reads: 1 uncomp pre-read, 2 under the lock (both active); 3 in the transaction (inactive: the real row)
    m.store.findFirst.mockImplementationOnce(active).mockImplementationOnce(active);

    await expect(m.svc.uncompAddon("t1", "REGULATED_ITEMS", "price_x")).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.del).toHaveBeenCalledWith("si_new");
    expect(m.store.rows[0]).toMatchObject({ active: false, isComp: true, stripeItemId: null });
  });

  it("M3: a flag-only uncomp leaves the quantity alone", async () => {
    const { svc, store } = make({ rows: [compRow({ quantity: 4 })] });

    await svc.uncompAddon("t1", "REGULATED_ITEMS");

    expect(store.rows[0]).toMatchObject({ isComp: false, quantity: 4 });
  });

  it("a MANUALLY-invoiced tenant: uncomp raises the manual-invoice notice and books the catalog price (the owner now invoices it)", async () => {
    const { svc, store, events, audit } = make({
      externalPayment: true,
      rows: [compRow({ quantity: 2 })],
    });

    await svc.uncompAddon("t1", "REGULATED_ITEMS");

    expect(store.rows[0]).toMatchObject({
      isComp: false,
      quantity: 2,
      priceSnapshot: 10,
      stripeItemId: null,
    });
    expect(events.emit).toHaveBeenCalledWith(
      "t1",
      "addon.enabled",
      expect.anything(),
      expect.objectContaining({ amountDelta: 20 }),
    );
    expect(audit.create).toHaveBeenCalledTimes(1);
    expect(audit.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      action: "ADDON_MANUAL_INVOICE_DUE",
      meta: expect.objectContaining({ sku: "REGULATED_ITEMS", quantity: 2, monthlyPrice: 10 }),
    });
  });

  it("a tenant that is neither Stripe-billed nor manually invoiced raises no manual-invoice notice", async () => {
    const { svc, audit } = make({ rows: [compRow()] });

    await svc.uncompAddon("t1", "REGULATED_ITEMS");

    expect(audit.create).not.toHaveBeenCalled();
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

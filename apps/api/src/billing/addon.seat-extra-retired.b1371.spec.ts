/**
 * B1371 (SA-1175 K8 + K12): SEAT_EXTRA is retired (no seat limit on any plan).
 *  - `enableAddon` refuses it in every mode, before any lock, Stripe call or row write.
 *  - `disableAddon` removes its Stripe item with `proration_behavior: "none"` (stop at next renewal, no
 *    refund); every other SKU keeps today's `del(id)`. A priced MANUAL holder gets the stop notice.
 */
const mockWithAdvisoryLock = jest.fn(
  async (_opts: { key: string }, fn: () => Promise<unknown>) => ({
    acquired: true as const,
    value: await fn(),
  }),
);
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  withAdvisoryLocks: jest.fn(async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true as const,
    value: await fn(),
  })),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { BadRequestException } from "@nestjs/common";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { AddonService } from "./addon.service";
import { fakeTenantAddonStore } from "../testing/fake-tenant-addon-store";

function make(opts: { rows?: Array<Record<string, unknown>>; manual?: boolean } = {}) {
  const store = fakeTenantAddonStore(opts.rows as any);
  const create = jest.fn().mockResolvedValue({ id: "si_new" });
  const del = jest.fn().mockResolvedValue({});
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme", name: "Acme Foods" }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "SCALE" },
      }),
    },
    tenantAddon: store,
    tenantSubscription: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.manual
            ? { stripeSubId: null, externalPayment: true, planKey: null, planVersionId: null }
            : { stripeSubId: "sub_1", externalPayment: false, planKey: null, planVersionId: null },
        ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
  const stripe = { isConfigured: true, client: { subscriptionItems: { create, del } } } as any;
  const catalog = {
    getPublishedCatalog: jest.fn().mockResolvedValue({
      id: "v_pub",
      definitions: [{ planKey: "SCALE", name: "Scale", monthlyPrice: 499 }],
      addonSkus: [
        { sku: "SEAT_EXTRA", name: "Extra seats", monthlyPrice: 5 },
        { sku: "REGULATED_ITEMS", name: "Regulated", monthlyPrice: 10 },
      ],
    }),
    getVersionForTenant: jest.fn().mockResolvedValue(null),
  } as any;
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const svc = new (AddonService as any)(
    prisma,
    stripe,
    { invalidate: jest.fn() },
    catalog,
    { invalidate: jest.fn() },
    { assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined) },
    events,
  );
  return { svc: svc as AddonService, prisma, store, create, del, events };
}

const row = (over: Record<string, unknown> = {}) => ({
  tenantId: "t1",
  addonKey: "SEAT_EXTRA",
  sku: "SEAT_EXTRA",
  active: true,
  quantity: 2,
  priceSnapshot: 5,
  stripeItemId: "si_1",
  isComp: false,
  ...over,
});

beforeEach(() => mockWithAdvisoryLock.mockClear());

describe("B1371 K8 enableAddon refuses SEAT_EXTRA", () => {
  it.each([
    ["billed", undefined, "price_x"],
    ["comp", { comp: true }, undefined],
    ["uncomp", { uncomp: true }, "price_x"],
  ])("%s: refused, no lock, no Stripe call, no row", async (_n, opts, price) => {
    const { svc, create, store, prisma } = make();
    await expect(
      svc.enableAddon("t1", "SEAT_EXTRA", price, undefined, opts as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("message says seats are unlimited", async () => {
    const { svc } = make();
    await expect(svc.enableAddon("t1", "SEAT_EXTRA")).rejects.toThrow(
      "Extra seats is retired: every plan includes unlimited users.",
    );
  });

  it("another SKU still enables (guard)", async () => {
    const { svc, store } = make();
    await svc.enableAddon("t1", "REGULATED_ITEMS", undefined, undefined, { comp: true });
    expect(store.rows).toHaveLength(1);
  });
});

describe("B1371 K12 disableAddon", () => {
  it("SEAT_EXTRA with a Stripe item: del with proration none, row inactive, one delta emit", async () => {
    const { svc, del, store, events } = make({ rows: [row()] });
    await svc.disableAddon("t1", "SEAT_EXTRA");
    expect(del).toHaveBeenCalledWith("si_1", { proration_behavior: "none" });
    expect(store.rows[0]).toMatchObject({ active: false });
    expect(events.emit.mock.calls.length).toBeGreaterThan(0);
  });

  it("another SKU keeps today's call: del(id) with no options", async () => {
    const { svc, del } = make({
      rows: [row({ addonKey: "REGULATED_ITEMS", sku: "REGULATED_ITEMS", stripeItemId: "si_2" })],
    });
    await svc.disableAddon("t1", "REGULATED_ITEMS");
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]).toEqual(["si_2"]);
  });

  it("SEAT_EXTRA, MANUAL, priced: writes the stop notice", async () => {
    const { svc, prisma } = make({ rows: [row({ stripeItemId: null })], manual: true });
    await svc.disableAddon("t1", "SEAT_EXTRA");
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data.action).toBe("ADDON_MANUAL_INVOICE_STOP");
    expect(data.meta).toMatchObject({
      kind: "stop",
      sku: "SEAT_EXTRA",
      message:
        "Add-on Extra seats turned off for Acme Foods: stop invoicing it from the next invoice. No refund.",
    });
  });

  it("SEAT_EXTRA, MANUAL, unpriced: no notice", async () => {
    const { svc, prisma } = make({
      rows: [row({ stripeItemId: null, priceSnapshot: 0 })],
      manual: true,
    });
    await svc.disableAddon("t1", "SEAT_EXTRA");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("B1371 census: callers of AddonService.enableAddon", () => {
  const ALLOWED = [
    "platform-admin/platform-admin.controller.ts",
    "billing/addon.service.ts",
    "billing/business-profile-apply.service.ts",
  ];
  function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts") && !p.endsWith(".spec.ts")) out.push(p);
    }
    return out;
  }
  it("only the reviewed callers call it (a new one is red until reviewed against K8)", () => {
    const root = join(__dirname, "..");
    const hits = walk(root)
      // subscription-mutation's own `this.enableAddon` / `this.mutations.enableAddon` is a different method
      .filter((p) => !p.endsWith("subscription-mutation.service.ts"))
      .filter((p) => /\b(addonService|addons|this)\.enableAddon\(/.test(readFileSync(p, "utf8")))
      .map((p) => relative(root, p).replace(/\\/g, "/"))
      .sort();
    expect(hits).toEqual([...ALLOWED].sort());
  });
});

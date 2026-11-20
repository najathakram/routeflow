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

// #4393 read A L-1: uncomping a legacy SEAT_EXTRA comp on a MANUAL tenant priced it and wrote the
// "add to their next manual invoice" notice without passing through enableAddon. K8 says every mode.
describe("B1371 K8 uncompAddon refuses SEAT_EXTRA", () => {
  it.each([
    ["MANUAL tenant", true],
    ["Stripe tenant", false],
  ])("%s: refused before any read, lock, price or notice; the comp stays", async (_n, manual) => {
    const { svc, store, prisma, create } = make({
      manual,
      rows: [row({ isComp: true, priceSnapshot: 0, stripeItemId: null })],
    });
    await expect(svc.uncompAddon("t1", "SEAT_EXTRA", "price_x")).rejects.toThrow(
      "Extra seats is retired: every plan includes unlimited users.",
    );
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ isComp: true, priceSnapshot: 0 });
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

describe("B1371 census: callers of AddonService.enableAddon and .uncompAddon", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts") && !p.endsWith(".spec.ts")) out.push(p);
    }
    return out;
  }
  /** Call sites per file, any receiver (#4393 read A L-5), comment lines skipped. */
  function callSites(method: string): Record<string, number> {
    const root = join(__dirname, "..");
    const call = new RegExp(`\\.${method}\\(`, "g");
    const sites: Record<string, number> = {};
    for (const p of walk(root)) {
      // subscription-mutation's own enableAddon is a different method (the tenant path, refused by
      // isSelfServiceAddon), and so is its injected handle `this.mutations.enableAddon`.
      if (p.endsWith("subscription-mutation.service.ts")) continue;
      const n = readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .reduce(
          (k, l) => k + (l.replace(/\.mutations\.enableAddon\(/g, "").match(call)?.length ?? 0),
          0,
        );
      if (n > 0) sites[relative(root, p).replace(/\\/g, "/")] = n;
    }
    return sites;
  }
  it("enableAddon: only the 3 reviewed call sites (a new one is red until reviewed against K8)", () => {
    expect(callSites("enableAddon")).toEqual({
      "billing/addon.service.ts": 1,
      "billing/business-profile-apply.service.ts": 1,
      "platform-admin/platform-admin.controller.ts": 1,
    });
  });
  it("uncompAddon: only the platform-admin call site (L-1: refused for SEAT_EXTRA)", () => {
    expect(callSites("uncompAddon")).toEqual({ "platform-admin/platform-admin.controller.ts": 1 });
  });
});

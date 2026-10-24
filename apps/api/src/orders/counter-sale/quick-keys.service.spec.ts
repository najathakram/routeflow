import { ForbiddenException } from "@nestjs/common";
import { QuickKeysRankCache } from "../../system-config/quick-keys-rank.cache";
import { parseQuickKeysSettings } from "../../system-config/quick-keys-settings";
import { findScanMatches } from "../../products/scan-match";
import { scanReadInclude } from "../../products/scan-product-view";
import { tenantSafeParent } from "../../products/product-parent";
import { QuickKeysService } from "./quick-keys.service";

/**
 * GET /orders/counter-sale/quick-keys, the service, against an in-memory product table. The product read is
 * a stand-in that APPLIES the `where` the service sends (id in, tenantId, isActive), so tenant isolation and
 * liveness are about the real arguments, not a canned answer. Placeholders only (acme).
 */
const T = "tenant-a";
const OTHER = "tenant-b";
const HOUR = 60 * 60 * 1000;

type Row = Record<string, any>;
const prod = (id: string, over: Row = {}): Row => ({
  id,
  tenantId: T,
  name: `Acme ${id}`,
  isActive: true,
  unitsPerBox: null,
  barcode: `B-${id}`,
  imageKeys: [],
  pricePerUnit: "5.00",
  priceTier2: "4.00",
  barcodes: [],
  variants: [],
  parent: null,
  ...over,
});

function setup(opts: {
  products: Row[];
  ranked?: string[];
  stored?: unknown;
  tenant?: string | null;
}) {
  const findMany = jest.fn(async (args: any) =>
    opts.products.filter(
      (p) =>
        args.where.id.in.includes(p.id) &&
        p.tenantId === args.where.tenantId &&
        p.isActive === args.where.isActive,
    ),
  );
  const queryRaw = jest.fn(async () => (opts.ranked ?? []).map((productId) => ({ productId })));
  const tenant = opts.tenant === undefined ? T : opts.tenant;
  const prisma: any = {
    getTenantId: () => tenant,
    $queryRaw: queryRaw,
    forTenant: () => ({ product: { findMany } }),
  };
  let stored = opts.stored;
  const settings: any = {
    read: jest.fn(async () =>
      parseQuickKeysSettings(stored === undefined ? null : JSON.stringify(stored)),
    ),
  };
  const storage: any = {
    presignedUrl: jest.fn(async (k: string) => `https://signed.example/${k}`),
  };
  const cache = new QuickKeysRankCache();
  let now = 5_000_000;
  cache.clock = () => now;
  const svc = new QuickKeysService(prisma, settings, cache, storage);
  return {
    svc,
    findMany,
    queryRaw,
    settings,
    storage,
    cache,
    setStored: (v: unknown) => (stored = v),
    advance: (ms: number) => (now += ms),
  };
}

const ids = (res: { keys: { productId: string }[] }) => res.keys.map((k) => k.productId);

describe("QuickKeysService.get: grid composition", () => {
  it("pinned first in pin order, then the ranking minus hidden minus pinned, up to the cap", async () => {
    const products = ["a", "b", "c", "d", "e", "f"].map((i) => prod(i));
    const s = setup({
      products,
      ranked: ["a", "b", "c", "d", "e"],
      stored: { counter: { default: { pinned: ["f", "c"], hidden: ["b"] }, cap: 4 } },
    });
    const res = await s.svc.get();
    expect(ids(res)).toEqual(["f", "c", "a", "d"]);
    expect(res.keys.map((k) => k.pinned)).toEqual([true, true, false, false]);
    expect(res.cap).toBe(4);
    expect(res.register).toBe("main");
  });

  it("the default cap is 12 and the hard maximum 24 is never exceeded", async () => {
    const products = Array.from({ length: 40 }, (_, i) => prod(`p${i}`));
    const ranked = products.map((p) => p.id);
    expect(ids(await setup({ products, ranked }).svc.get())).toHaveLength(12);
    const big = setup({
      products,
      ranked,
      stored: { counter: { default: { pinned: [], hidden: [] }, cap: 24 } },
    });
    expect(ids(await big.svc.get())).toHaveLength(24);
  });

  it("an empty tenant gets an empty grid without a product read", async () => {
    const s = setup({ products: [], ranked: [] });
    const res = await s.svc.get();
    expect(res).toEqual({ register: "main", keys: [], cap: 12 });
    expect(s.findMany).not.toHaveBeenCalled();
  });

  it("a missing or unknown register is answered as the default register", async () => {
    const s = setup({
      products: [prod("a")],
      ranked: ["a"],
      stored: { counter: { default: { pinned: ["a"], hidden: [] } } },
    });
    for (const reg of [undefined, "", "main", "nope", "__proto__"]) {
      const res = await s.svc.get(reg);
      expect(res.register).toBe("main");
      expect(ids(res)).toEqual(["a"]);
    }
  });

  it("an inactive product, pinned or ranked, takes no slot", async () => {
    const s = setup({
      products: [prod("a", { isActive: false }), prod("b"), prod("c", { isActive: false })],
      ranked: ["a", "b"],
      stored: { counter: { default: { pinned: ["c"], hidden: [] } } },
    });
    expect(ids(await s.svc.get())).toEqual(["b"]);
  });

  it("dead pins ahead of the cap do not starve valid later pins", async () => {
    const s = setup({
      products: [prod("c"), prod("d"), prod("e")],
      ranked: ["e"],
      stored: { counter: { default: { pinned: ["x", "y", "c", "d"], hidden: [] }, cap: 2 } },
    });
    const res = await s.svc.get();
    expect(ids(res)).toEqual(["c", "d"]);
    expect(res.keys.map((k) => k.pinned)).toEqual([true, true]);
  });

  it("sellLevel is BOX when unitsPerBox > 1, else UNIT", async () => {
    const s = setup({
      products: [
        prod("a", { unitsPerBox: 12 }),
        prod("b", { unitsPerBox: 1 }),
        prod("c", { unitsPerBox: null }),
      ],
      ranked: ["a", "b", "c"],
    });
    const res = await s.svc.get();
    expect(Object.fromEntries(res.keys.map((k) => [k.productId, k.sellLevel]))).toEqual({
      a: "BOX",
      b: "UNIT",
      c: "UNIT",
    });
  });

  it("imageUrl is the signed FIRST own-prefix image, omitted when there is none or it is foreign", async () => {
    const s = setup({
      products: [
        prod("a", { imageKeys: ["products/a/one.jpg", "products/a/two.jpg"] }),
        prod("b", { imageKeys: [] }),
        prod("c", { imageKeys: ["products/other/x.jpg"] }),
      ],
      ranked: ["a", "b", "c"],
    });
    const res = await s.svc.get();
    expect(res.keys[0].imageUrl).toBe("https://signed.example/products/a/one.jpg");
    expect("imageUrl" in res.keys[1]).toBe(false);
    expect("imageUrl" in res.keys[2]).toBe(false);
    expect(s.storage.presignedUrl).toHaveBeenCalledTimes(1);
  });

  it("a signing failure omits the image instead of failing the grid", async () => {
    const s = setup({
      products: [prod("a", { imageKeys: ["products/a/one.jpg"] })],
      ranked: ["a"],
    });
    s.storage.presignedUrl.mockRejectedValue(new Error("no storage"));
    const res = await s.svc.get();
    expect(ids(res)).toEqual(["a"]);
    expect("imageUrl" in res.keys[0]).toBe(false);
  });
});

describe("QuickKeysService.get: product is the scan lookup's product", () => {
  const row = prod("a", {
    unitsPerBox: 6,
    variants: [{ id: "v1", tenantId: T, isActive: true }],
    parent: { id: "par", tenantId: T, name: "Acme Parent" },
  });

  it("has the same keys as the scan lookup product for the same row, and no scanMatch", async () => {
    const s = setup({ products: [row], ranked: ["a"] });
    const key = (await s.svc.get()).keys[0];
    const db = {
      productBarcode: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([row]) },
    };
    const hit = await findScanMatches(db, ["B-a"], {}, scanReadInclude(T));
    const scan = { ...hit!.product, parent: tenantSafeParent(hit!.product.parent, T) };
    expect(Object.keys(key.product).sort()).toEqual(Object.keys(scan).sort());
    expect(key.product).toEqual(scan);
    expect(key.product).not.toHaveProperty("scanMatch");
    expect(key.product.id).toBe("a");
  });

  it("reads with the scan include: this tenant's ACTIVE variants, the parent, and the barcodes", async () => {
    const s = setup({ products: [row], ranked: ["a"] });
    await s.svc.get();
    expect(s.findMany).toHaveBeenCalledTimes(1);
    expect(s.findMany.mock.calls[0][0].include).toEqual({
      variants: { where: { isActive: true, tenantId: T } },
      parent: true,
      barcodes: true,
    });
  });

  it("drops a cross-tenant parent link (tenantSafeParent)", async () => {
    const foreign = { ...row, parent: { id: "par-x", tenantId: OTHER, name: "Other" } };
    const s = setup({ products: [foreign], ranked: ["a"] });
    expect((await s.svc.get()).keys[0].product.parent).toBeNull();
  });
});

describe("QuickKeysService.get: tenant isolation", () => {
  it("the product read carries the caller's tenant and a pinned id of another tenant never appears", async () => {
    const s = setup({
      products: [prod("mine"), prod("theirs", { tenantId: OTHER })],
      ranked: ["mine"],
      stored: { counter: { default: { pinned: ["theirs"], hidden: [] } } },
    });
    const res = await s.svc.get();
    expect(ids(res)).toEqual(["mine"]);
    const where = s.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(T);
    expect(where.isActive).toBe(true);
  });

  it("the ranking query is asked for the caller's tenant", async () => {
    const s = setup({ products: [prod("a")], ranked: ["a"] });
    await s.svc.get();
    // tagged template: strings array first, then the bound values in order: tenant, since, tenant, take
    const bound = (s.queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(bound[0]).toBe(T);
    expect(bound[2]).toBe(T);
  });

  it("refuses a session with no tenant before any query", async () => {
    const s = setup({ products: [prod("a")], ranked: ["a"], tenant: null });
    await expect(s.svc.get()).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.queryRaw).not.toHaveBeenCalled();
    expect(s.findMany).not.toHaveBeenCalled();
  });

  it("two tenants never share a cached ranking", async () => {
    const a = setup({ products: [prod("a")], ranked: ["a"] });
    await a.svc.get();
    expect(a.cache.get(T, "main", 30)).toEqual(["a"]);
    expect(a.cache.get(OTHER, "main", 30)).toBeUndefined();
  });
});

describe("QuickKeysService.get: ranking cache", () => {
  it("a second call within the TTL does not re-run the ranking", async () => {
    const s = setup({ products: [prod("a")], ranked: ["a"] });
    await s.svc.get();
    await s.svc.get();
    expect(s.queryRaw).toHaveBeenCalledTimes(1);
    expect(s.findMany).toHaveBeenCalledTimes(2); // the product read is per request
  });

  it("pins and hides changed in settings show immediately, with no re-rank", async () => {
    const s = setup({ products: ["a", "b", "c"].map((i) => prod(i)), ranked: ["a", "b", "c"] });
    expect(ids(await s.svc.get())).toEqual(["a", "b", "c"]);
    s.setStored({ counter: { default: { pinned: ["c"], hidden: ["a"] } } });
    expect(ids(await s.svc.get())).toEqual(["c", "b"]);
    expect(s.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("the ranking is recomputed once the TTL has passed", async () => {
    const s = setup({ products: [prod("a")], ranked: ["a"] });
    await s.svc.get();
    s.advance(HOUR + 1);
    await s.svc.get();
    expect(s.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("a settings PATCH (invalidateTenant) forces a re-rank", async () => {
    const s = setup({ products: [prod("a")], ranked: ["a"] });
    await s.svc.get();
    s.cache.invalidateTenant(T);
    await s.svc.get();
    expect(s.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("a changed look-back window is never answered from the cache", async () => {
    const s = setup({ products: [prod("a")], ranked: ["a"] });
    await s.svc.get();
    s.setStored({ counter: { default: { pinned: [], hidden: [] }, windowDays: 7 } });
    await s.svc.get();
    expect(s.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("the query count per request: uncached 1 settings + 1 rank + 1 products; cached 1 settings + 1 products", async () => {
    const s = setup({ products: [prod("a")], ranked: ["a"] });
    await s.svc.get();
    expect([
      s.settings.read.mock.calls.length,
      s.queryRaw.mock.calls.length,
      s.findMany.mock.calls.length,
    ]).toEqual([1, 1, 1]);
    await s.svc.get();
    expect([
      s.settings.read.mock.calls.length,
      s.queryRaw.mock.calls.length,
      s.findMany.mock.calls.length,
    ]).toEqual([2, 1, 2]);
  });
});

/**
 * #2717 M4a-1 — the ONE server-side scan lookup (SA-578 Q3/Q5, SA-580), unit level (mocked prisma).
 *
 * RED (M4a-1): ./scan-match does not exist — fails on "Cannot find module './scan-match'"
 * (findScanMatches). The `findByBarcode` cases additionally go red on behaviour (404 on a
 * ProductBarcode row code; no `barcodes`/`scanMatch` on the response).
 *
 * Contract pinned (the builder satisfies it; names chosen here):
 *   findScanMatches(db, candidates: string[], baseWhere?: object, include?: object)
 *     -> Promise<null | { product, scanMatch: { code: string; levels: SellLevel[] }, barcodes: ProductBarcodeView[] }>
 *   - row tier: db.productBarcode.findMany({ where: { code: { in: candidates } } }) FIRST, then the legacy
 *     barcode/sku/unitSku tiers, then pickBestScanMatch with a row hit ranking as `barcode` (SA-578 Q5).
 *   - `baseWhere` is the caller's own visibility scope; it is applied to every product query (a row code on a
 *     product outside it must not resolve).
 *   - barcodes[]: the product's rows via barcodeRowsToView, else synthesizeLegacyBarcodes (ONE presence check, L-159).
 *   - a row-tier hit that yields >= 2 DISTINCT products for one candidate: deterministic pick + exactly ONE
 *     Logger.warn carrying the count only (no tenant id / slug / product name).
 */
import { Logger, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { normalizeScanCode } from "@routeflow/scanning";
import { ProductsService } from "./products.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import * as scanMatch from "./scan-match";
import { findScanMatches } from "./scan-match";
import { synthesizeLegacyBarcodes, barcodeRowsToView } from "./product-barcode-rules";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";

const product = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "Sample Cola 6pk",
  sku: "COLA-6",
  unitSku: null,
  barcode: "4000000000019",
  unitsPerBox: 6,
  isActive: true,
  barcodes: [],
  ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  productId: "p1",
  code: "X-ROWCODE",
  level: "UNIT",
  symbology: "CODE128",
  origin: "ENTERED",
  copiedFromLevel: null,
  primaryFor: null,
  ...over,
});

function makeDb(opts: { rows?: any[]; products?: any[] }) {
  return {
    productBarcode: { findMany: jest.fn().mockResolvedValue(opts.rows ?? []) },
    product: { findMany: jest.fn().mockResolvedValue(opts.products ?? []) },
  };
}

describe("findScanMatches — row tier (#2717 M4a-1)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a ProductBarcode row code X != Product.barcode resolves the product, with scanMatch{code, levels}", async () => {
    const p = product({ barcodes: [row()] });
    const db = makeDb({ rows: [row()], products: [p] });

    const hit = await findScanMatches(db as any, normalizeScanCode("X-ROWCODE"), {});

    expect(hit?.product.id).toBe("p1");
    expect(hit?.scanMatch).toEqual({ code: "X-ROWCODE", levels: ["UNIT"] });
    // the row tier queried ProductBarcode by the candidate SET, not the raw string
    expect(db.productBarcode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ code: { in: expect.arrayContaining(["X-ROWCODE"]) } }),
      }),
    );
  });

  it("a code held at BOTH levels reports both (shared) so the client rule R2 can pick BOX", async () => {
    const rows = [row({ code: "SH", level: "BOX" }), row({ code: "SH", level: "UNIT" })];
    const db = makeDb({ rows, products: [product({ barcodes: rows })] });
    const hit = await findScanMatches(db as any, ["SH"], {});
    expect([...(hit?.scanMatch.levels ?? [])].sort()).toEqual(["BOX", "UNIT"]);
  });

  it("a row with a level outside BOX/UNIT never reaches scanMatch.levels (Opus nit, #2764)", async () => {
    const rows = [row({ code: "SH", level: "CASE" }), row({ code: "SH", level: "UNIT" })];
    const db = makeDb({ rows, products: [product({ barcodes: rows })] });
    const hit = await findScanMatches(db as any, ["SH"], {});
    expect(hit?.scanMatch.levels).toEqual(["UNIT"]);
  });

  it("returns null when nothing matches on any tier", async () => {
    const db = makeDb({});
    await expect(findScanMatches(db as any, ["NOPE"], {})).resolves.toBeNull();
  });

  it("baseWhere is the caller's scope: it reaches EVERY product query, and a row whose product it excludes does not resolve", async () => {
    const scope = { isActive: true, marker: "buyer-scope" };
    const db = makeDb({ rows: [row()], products: [] }); // the scoped product query excludes the product
    await expect(findScanMatches(db as any, ["X-ROWCODE"], scope)).resolves.toBeNull();
    expect(db.product.findMany.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of db.product.findMany.mock.calls) {
      expect(JSON.stringify(args.where)).toContain("buyer-scope");
    }
  });
});

describe("findScanMatches — held-tenant legacy fallback (L-159: one presence check)", () => {
  it("no rows anywhere: resolves by barcode/sku/unitSku as today; barcodes[] === synthesizeLegacyBarcodes (called, not re-derived)", async () => {
    const p = product({ barcodes: [] });
    const db = makeDb({ rows: [], products: [p] });

    const hit = await findScanMatches(db as any, ["4000000000019"], {});

    expect(hit?.product.id).toBe("p1");
    expect(hit?.barcodes).toEqual(
      synthesizeLegacyBarcodes({ barcode: p.barcode, unitsPerBox: p.unitsPerBox }),
    );
    expect(hit?.barcodes.every((b) => b.origin === "LEGACY")).toBe(true);
    // legacy barcode hit on a boxed product: shared BOX+UNIT
    expect([...(hit?.scanMatch.levels ?? [])].sort()).toEqual(["BOX", "UNIT"]);
  });

  it("legacy sku hit -> [BOX]; legacy unitSku-only hit -> [UNIT] (mobile scanUnitKind parity at upb>1)", async () => {
    const p = product({ unitSku: "COLA-1", barcode: "4000000000019" });
    const bySku = await findScanMatches(makeDb({ products: [p] }) as any, ["COLA-6"], {});
    expect(bySku?.scanMatch.levels).toEqual(["BOX"]);
    const byUnit = await findScanMatches(makeDb({ products: [p] }) as any, ["COLA-1"], {});
    expect(byUnit?.scanMatch.levels).toEqual(["UNIT"]);
  });

  it("a backfilled twin returns its ROWS via barcodeRowsToView; same key shape as the synthesized LEGACY view", async () => {
    const rows = [
      row({ code: "4000000000019", level: "BOX", origin: "ENTERED", primaryFor: "BOX" }),
      row({
        code: "4000000000019",
        level: "UNIT",
        origin: "COPIED",
        copiedFromLevel: "BOX",
        primaryFor: "UNIT",
      }),
    ];
    const twin = await findScanMatches(
      makeDb({ rows, products: [product({ barcodes: rows })] }) as any,
      ["4000000000019"],
      {},
    );
    const legacy = await findScanMatches(
      makeDb({ products: [product({ barcodes: [] })] }) as any,
      ["4000000000019"],
      {},
    );
    expect(twin?.barcodes).toEqual(barcodeRowsToView(rows as any));
    expect(Object.keys(twin!.barcodes[0]).sort()).toEqual(Object.keys(legacy!.barcodes[0]).sort());
    expect(twin!.barcodes.map((b) => b.code)).toEqual(legacy!.barcodes.map((b) => b.code));
  });
});

describe("findScanMatches — ranking (row > sku > unitSku, then id; deterministic)", () => {
  it("a row code equal to ANOTHER product's sku at the same candidate: the row wins even with the larger id", async () => {
    const owner = product({
      id: "zzz-owner",
      sku: "OWN",
      barcode: null,
      barcodes: [row({ productId: "zzz-owner", code: "CODE" })],
    });
    const skuHolder = product({ id: "aaa-skuholder", sku: "CODE", barcode: null, barcodes: [] });
    for (const order of [
      [owner, skuHolder],
      [skuHolder, owner],
    ]) {
      const db = makeDb({ rows: [row({ productId: "zzz-owner", code: "CODE" })], products: order });
      const hit = await findScanMatches(db as any, ["CODE"], {});
      expect(hit?.product.id).toBe("zzz-owner");
    }
  });

  it("sku beats unitSku at equal candidates (unchanged rank), and ties break on the lowest id, in any input order", async () => {
    const a = product({ id: "a", sku: "T", barcode: null, unitSku: null });
    const b = product({ id: "b", sku: "T", barcode: null, unitSku: null });
    const u = product({ id: "0-unit", sku: null, barcode: null, unitSku: "T" });
    const orders = [
      [a, b, u],
      [u, b, a],
      [b, u, a],
    ];
    for (const products of orders) {
      const hit = await findScanMatches(makeDb({ products }) as any, ["T"], {});
      expect(hit?.product.id).toBe("a");
    }
  });
});

describe("findScanMatches — invariant breach: >= 2 DISTINCT products for one candidate (SA-578 Q5 i)", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // Bypasses the writer (which serialises under the advisory lock): two products, the same code, at
  // different levels — @@unique([tenantId, code, level]) allows it.
  const breachDb = () => {
    const rows = [
      row({ productId: "p-b", code: "DUP", level: "UNIT" }),
      row({ productId: "p-a", code: "DUP", level: "BOX" }),
    ];
    return makeDb({
      rows,
      products: [
        product({ id: "p-b", name: "SECRET-NAME-B", barcodes: [rows[0]] }),
        product({ id: "p-a", name: "SECRET-NAME-A", barcodes: [rows[1]] }),
      ],
    });
  };

  it("keeps a deterministic pick (lowest id) and warns exactly ONCE", async () => {
    const hit = await findScanMatches(breachDb() as any, ["DUP"], {});
    expect(hit?.product.id).toBe("p-a");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("the warn carries the collision COUNT only — no tenant id, slug, product id or name", async () => {
    await findScanMatches(breachDb() as any, ["DUP"], {
      tenantId: "tenant-uuid-1234",
      slug: "acme",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toMatch(/\b2\b/);
    for (const forbidden of ["tenant-uuid-1234", "acme", "SECRET-NAME", "p-a", "p-b"]) {
      expect(logged).not.toContain(forbidden);
    }
  });

  it("the deterministic pick does not depend on row/product order across runs", async () => {
    const picks = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const db = breachDb();
      if (i % 2) {
        db.productBarcode.findMany.mockResolvedValue(
          [...(await db.productBarcode.findMany())].reverse(),
        );
        db.product.findMany.mockResolvedValue([...(await db.product.findMany())].reverse());
      }
      picks.add((await findScanMatches(db as any, ["DUP"], {}))!.product.id);
    }
    expect([...picks]).toEqual(["p-a"]);
  });

  it("NO warn when the one code sits at both levels of the SAME product (the normal shared code)", async () => {
    const rows = [row({ code: "SH", level: "BOX" }), row({ code: "SH", level: "UNIT" })];
    await findScanMatches(
      makeDb({ rows, products: [product({ barcodes: rows })] }) as any,
      ["SH"],
      {},
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("ProductsService.findByBarcode via findScanMatches (#2717 M4a-1)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: { presignedUrl: jest.fn(), presignedUrls: jest.fn() },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
  });
  afterEach(() => jest.restoreAllMocks());

  it("a ProductBarcode row code != Product.barcode resolves (was a 404: only the legacy columns were queried)", async () => {
    const p = product({ barcode: "LEGACY-ONE", barcodes: [row()] });
    prisma.productBarcode.findMany.mockResolvedValue([row()] as any);
    prisma.product.findMany.mockResolvedValue([p] as any);

    const result: any = await service.findByBarcode("X-ROWCODE");

    expect(result.id).toBe("p1");
    expect(result.scanMatch).toEqual({ code: "X-ROWCODE", levels: ["UNIT"] });
  });

  it("additive response: barcodes[] + scanMatch are added; every existing key keeps its value", async () => {
    const p = product({ variants: [], parent: null, barcodes: [] });
    prisma.productBarcode.findMany.mockResolvedValue([] as any);
    prisma.product.findMany.mockResolvedValue([p] as any);

    const result: any = await service.findByBarcode("4000000000019");

    const { barcodes: _drop, ...legacyKeys } = p;
    expect(result).toMatchObject(legacyKeys);
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining([...Object.keys(legacyKeys), "barcodes", "scanMatch"]),
    );
    expect(result.barcodes).toEqual(
      synthesizeLegacyBarcodes({ barcode: p.barcode, unitsPerBox: 6 }),
    );
  });

  it("calls the shared findScanMatches exactly once with the normalised candidate set (L-167)", async () => {
    const spy = jest.spyOn(scanMatch, "findScanMatches");
    prisma.productBarcode.findMany.mockResolvedValue([] as any);
    prisma.product.findMany.mockResolvedValue([product()] as any);

    await service.findByBarcode("4000000000019");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual(normalizeScanCode("4000000000019"));
  });

  it("no match -> NotFoundException; a blank code never queries", async () => {
    prisma.productBarcode.findMany.mockResolvedValue([] as any);
    prisma.product.findMany.mockResolvedValue([] as any);
    await expect(service.findByBarcode("NOPE")).rejects.toThrow(NotFoundException);
    prisma.product.findMany.mockClear();
    prisma.productBarcode.findMany.mockClear();
    await expect(service.findByBarcode("   ")).rejects.toThrow(NotFoundException);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.productBarcode.findMany).not.toHaveBeenCalled();
  });
});

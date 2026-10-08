/**
 * SA-747 — real-Postgres pin for the quick keys ranking SQL (rankCounterProducts) and the one product read the
 * grid is built from (QuickKeysService.get): the look-back window to the millisecond, CANCELLED orders and
 * inactive products excluded, DISTINCT-order counting (two lines of one product in one order count once), the
 * tie-break (units, then name), non-counter orders and unlisted lines ignored, tenant isolation (also against a
 * foreign product linked onto this tenant's order), and the scan-shaped product (active variants only, a
 * cross-tenant parent link dropped).
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test tenants
 * only, collected only by jest.db.config.js).
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { QuickKeysRankCache } from "../../system-config/quick-keys-rank.cache";
import { defaultQuickKeys } from "../../system-config/quick-keys-settings";
import { QuickKeysService } from "./quick-keys.service";
import { rankCounterProducts } from "./quick-keys-rank";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const NOW = new Date("2026-10-08T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const SINCE = new Date(NOW.getTime() - 30 * DAY); // 2026-09-08T12:00:00.000Z
const at = (offsetMs: number) => new Date(SINCE.getTime() + offsetMs);

describeDb("SA-747 — quick keys ranking on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-qk-a-${run}`, "quick-keys-rank.db.spec.ts");
  const slugB = assertTestTenant(`qa-qk-b-${run}`, "quick-keys-rank.db.spec.ts");
  const tenants = { A: "", B: "" };
  const userIds: string[] = [];
  const customers = { A: "", B: "" };
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const p: Record<string, string> = {};
  let n = 0;

  async function product(
    key: string,
    tenant: "A" | "B",
    name: string,
    over: Record<string, unknown> = {},
  ) {
    const row = await raw.product.create({
      data: {
        name: `${name} ${run}`,
        unit: "each",
        pricePerUnit: "2.50",
        tenantId: tenants[tenant],
        ...over,
      },
    });
    p[key] = row.id;
    productIds.push(row.id);
  }

  /** One order with its lines: [productKey | null (an unlisted line), qty]. */
  async function order(
    tenant: "A" | "B",
    createdAt: Date,
    lines: [string | null, number][],
    over: { counterSale?: boolean; status?: string } = {},
  ) {
    n += 1;
    const o = await raw.order.create({
      data: {
        customerId: customers[tenant],
        tenantId: tenants[tenant],
        counterSale: over.counterSale ?? true,
        status: (over.status ?? "DELIVERED") as never,
        orderNumber: `Q${run}-${n}`,
        total: 1,
        createdAt,
      },
    });
    orderIds.push(o.id);
    for (const [key, qty] of lines) {
      await raw.orderItem.create({
        data: {
          orderId: o.id,
          productId: key ? p[key] : null,
          name: key ? null : "Misc item",
          qty,
          unitPrice: "1.00",
          subtotal: "1.00",
          tenantId: tenants[tenant],
        },
      });
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenants.A = (await raw.tenant.create({ data: { slug: slugA, name: `QK A ${slugA}` } })).id;
    tenants.B = (await raw.tenant.create({ data: { slug: slugB, name: `QK B ${slugB}` } })).id;
    for (const t of ["A", "B"] as const) {
      const user = await raw.user.create({
        data: {
          email: `c-${t}-${run}@example.test`,
          username: `c-qk-${t}-${run}`,
          role: "CUSTOMER",
          tenantId: tenants[t],
        },
      });
      userIds.push(user.id);
      customers[t] = (
        await raw.customer.create({
          data: {
            userId: user.id,
            businessName: `Acme QK ${t} ${run}`,
            contactName: "Tester",
            tenantId: tenants[t],
          },
        })
      ).id;
    }

    // tenant A products
    await product("distinct", "A", "Acme Distinct");
    await product("uHigh", "A", "Acme Zulu High");
    await product("nApple", "A", "Acme Apple");
    await product("nBanana", "A", "Acme Banana");
    await product("uLow", "A", "Acme Cherry");
    await product("manyLines", "A", "Acme Many Lines");
    await product("edgeIn", "A", "Acme Aardvark");
    await product("edgeOut", "A", "Acme Edge Out");
    await product("cancelled", "A", "Acme Cancelled Only");
    await product("inactive", "A", "Acme Inactive", { isActive: false });
    await product("nonCounter", "A", "Acme Non Counter");
    // tenant B products (one is also linked onto an A order below)
    await product("bOnly", "B", "Acme B Only");
    await product("bOnA", "B", "Acme B On A");

    // distinct: 3 orders, one carries TWO lines of it -> counts 3, not 4
    await order("A", at(1 * DAY), [["distinct", 1]]);
    await order("A", at(2 * DAY), [["distinct", 1]]);
    await order("A", at(3 * DAY), [
      ["distinct", 1],
      ["distinct", 1],
    ]);
    // 2 orders each; units decide first (uHigh 20 > the 2-unit group), then name
    await order("A", at(4 * DAY), [
      ["uHigh", 10],
      ["nApple", 1],
      ["nBanana", 1],
      ["uLow", 1],
    ]);
    await order("A", at(5 * DAY), [
      ["uHigh", 10],
      ["nApple", 1],
      ["nBanana", 1],
      ["uLow", 1],
    ]);
    // 1 order: many lines (units 50) outranks edgeIn (units 1) although "Aardvark" sorts first by name
    await order("A", at(6 * DAY), [
      ["manyLines", 10],
      ["manyLines", 10],
      ["manyLines", 10],
      ["manyLines", 10],
      ["manyLines", 10],
    ]);
    // the window edge: exactly at the start is IN, one millisecond earlier is OUT
    await order("A", at(0), [["edgeIn", 1]]);
    await order("A", at(-1), [["edgeOut", 99]]);
    // excluded: cancelled, non-counter, inactive product, an unlisted line, a foreign product on an A order
    await order("A", at(7 * DAY), [["cancelled", 5]], { status: "CANCELLED" });
    await order("A", at(8 * DAY), [["nonCounter", 5]], { counterSale: false });
    await order("A", at(9 * DAY), [
      ["inactive", 5],
      [null, 7],
      ["bOnA", 50],
    ]);
    // tenant B's own sales
    await order("B", at(1 * DAY), [["bOnly", 3]]);
    await order("B", at(2 * DAY), [["bOnA", 1]]);
  }, 120_000);

  afterAll(async () => {
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.product.deleteMany({ where: { tenantId: { in: Object.values(tenants) } } });
    await raw.customer.deleteMany({ where: { id: { in: Object.values(customers) } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenant.deleteMany({ where: { id: { in: Object.values(tenants) } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const names = (ids: string[]) => ids.map((id) => Object.keys(p).find((k) => p[k] === id));

  it("ranks by DISTINCT counter orders, then units, then name; window edge, cancelled, inactive, non-counter and unlisted excluded", async () => {
    const ids = await rankCounterProducts(prisma, tenants.A, 30, NOW);
    expect(names(ids)).toEqual([
      "distinct", // 3 orders (the double line in one order counts once)
      "uHigh", // 2 orders, 20 units
      "nApple", // 2 orders, 2 units, name Apple
      "nBanana", // 2 orders, 2 units, name Banana
      "uLow", // 2 orders, 2 units, name Cherry
      "manyLines", // 1 order, 50 units
      "edgeIn", // 1 order exactly at the window start, 1 unit
    ]);
  });

  it("counts a product on one order once, however many lines it has", async () => {
    // manyLines has FIVE lines on ONE order: it must sit below the 2-order products
    const ids = await rankCounterProducts(prisma, tenants.A, 30, NOW);
    expect(ids.indexOf(p.manyLines)).toBeGreaterThan(ids.indexOf(p.uLow));
  });

  it("the window is exact to the millisecond", async () => {
    const ids = await rankCounterProducts(prisma, tenants.A, 30, NOW);
    expect(ids).toContain(p.edgeIn);
    expect(ids).not.toContain(p.edgeOut);
    // a window one day shorter than the oldest in-window order drops edgeIn
    const shorter = await rankCounterProducts(prisma, tenants.A, 29, NOW);
    expect(shorter).not.toContain(p.edgeIn);
  });

  it("never returns another tenant's product, even one linked onto this tenant's order", async () => {
    const a = await rankCounterProducts(prisma, tenants.A, 30, NOW);
    expect(a).not.toContain(p.bOnly);
    expect(a).not.toContain(p.bOnA);
    const b = await rankCounterProducts(prisma, tenants.B, 30, NOW);
    expect(names(b).sort()).toEqual(["bOnA", "bOnly"]);
    expect(b).not.toContain(p.distinct);
  });

  it("takes at most 40", async () => {
    const many = 45;
    const extra: string[] = [];
    for (let i = 0; i < many; i += 1) {
      const row = await raw.product.create({
        data: {
          name: `Acme Bulk ${String(i).padStart(2, "0")} ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          tenantId: tenants.B,
        },
      });
      extra.push(row.id);
      productIds.push(row.id);
    }
    n += 1;
    const o = await raw.order.create({
      data: {
        customerId: customers.B,
        tenantId: tenants.B,
        counterSale: true,
        status: "DELIVERED",
        orderNumber: `Q${run}-${n}`,
        total: 1,
        createdAt: at(10 * DAY),
      },
    });
    orderIds.push(o.id);
    for (const id of extra) {
      await raw.orderItem.create({
        data: {
          orderId: o.id,
          productId: id,
          qty: 1,
          unitPrice: "1",
          subtotal: "1",
          tenantId: tenants.B,
        },
      });
    }
    expect(await rankCounterProducts(prisma, tenants.B, 30, NOW)).toHaveLength(40);
  });

  describe("QuickKeysService.get on the real tables", () => {
    const service = (tenant: "A" | "B") => {
      const settings = { read: async () => defaultQuickKeys() } as never;
      const storage = { presignedUrl: async (k: string) => `https://signed.example/${k}` } as never;
      return {
        svc: new QuickKeysService(prisma, settings, new QuickKeysRankCache(), storage),
        run: <T>(fn: () => Promise<T>) => tenantCtx.run(tenants[tenant], fn),
      };
    };

    it("answers the tenant's grid in rank order with the scan-shaped product", async () => {
      const { svc, run: inTenant } = service("A");
      const res = await inTenant(() => svc.get(undefined, NOW));
      expect(res.keys.map((k) => k.productId)).toEqual(
        (await rankCounterProducts(prisma, tenants.A, 30, NOW)).slice(0, 12),
      );
      const key = res.keys[0];
      expect(key.product.id).toBe(p.distinct);
      expect(Array.isArray((key.product as { barcodes?: unknown }).barcodes)).toBe(true);
      expect(key.product).not.toHaveProperty("scanMatch");
    });

    it("follows only active variants of this tenant and drops a cross-tenant parent", async () => {
      const activeVariant = await raw.product.create({
        data: {
          name: `Acme Variant Live ${run}`,
          unit: "each",
          pricePerUnit: "1",
          tenantId: tenants.A,
          parentProductId: p.distinct,
        },
      });
      const deadVariant = await raw.product.create({
        data: {
          name: `Acme Variant Dead ${run}`,
          unit: "each",
          pricePerUnit: "1",
          tenantId: tenants.A,
          parentProductId: p.distinct,
          isActive: false,
        },
      });
      productIds.push(activeVariant.id, deadVariant.id);
      // a tenant-A product whose stored parent link points at a tenant-B product
      await raw.product.update({ where: { id: p.uHigh }, data: { parentProductId: p.bOnly } });
      const { svc, run: inTenant } = service("A");
      const res = await inTenant(() => svc.get(undefined, NOW));
      const distinct = res.keys.find((k) => k.productId === p.distinct)!.product as unknown as {
        variants: { id: string }[];
      };
      expect(distinct.variants.map((v) => v.id)).toEqual([activeVariant.id]);
      const uHigh = res.keys.find((k) => k.productId === p.uHigh)!.product as unknown as {
        parent: unknown;
      };
      expect(uHigh.parent).toBeNull();
    });
  });
});

/**
 * SA-984 §4 E0 / SA-987 / SA-996, DB lane (T2): the REAL `OrdersService.create()` on Postgres, once in a tenant that holds
 * none of the three `flag.units_*` keys (OLD) and once in a tenant that holds all three (NEW), seeded identically. What
 * every cell compares is what create() STORED and MOVED: the stored line, the order header (subtotal, tax, total), the
 * SALE stock the sale took, and the printed quantity text, plus how many times each key was consulted.
 *
 * Documents here: ORD (staff order), BUY (buyer order, with and without a promotion), CTR (counter sale + its audit
 * baseline). INV-a (invoice from an order), INV-b (manual invoice) and CN (credit note write) are ONE assertion each in the
 * readers spec ("unchanged by construction": no path under invoices/ or credit-notes/ reads a units key or
 * customerPricing), not repeated here; INV-c and CRD are listed in the T3 file's header.
 *
 * Equal with `consulted = 0` is "equal by short-circuit" (the flag was never read), NOT flag coverage: the positive
 * controls PC-1/PC-2/PC-3 reach the computed branches and MUST differ, and the dead-stub probe proves they go red when
 * the stub loses `hasFlagStrict`.
 *
 * STOP RULE (SA-984 §5): a red `expectSameRuns` is a finding. Never edit its expectation; report OLD and NEW.
 *
 * SAFETY: throwaway `qa-ufold-*` tenants approved by assertTestTenant; afterAll deletes what this run made.
 * Run alone: node scripts/local-db-specs.mjs -- node apps/api/scripts/run-db-tests.mjs src/orders/units-fold-e0-documents.db.spec.ts
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { resolveTierPrices } from "./counter-sale/counter-sale-tier-price";
import {
  FLAG_PRICES_V2,
  FLAG_SETTINGS,
  FLAG_V1,
  expectDiffers,
  expectSame,
  expectSameRuns,
  reportCells,
  type Fig,
  type LineReq,
  type LineRun,
} from "./testing/units-fold-battery";
import {
  boxedShape,
  cleanupFoldTenants,
  createDoc,
  formsOf,
  makeFoldOrders,
  makeTenantFlags,
  seedFoldTenant,
  type DocArgs,
  type FoldTenant,
  type FoldWorld,
  type Mode,
  type PromoRule,
} from "./testing/units-fold-db-harness";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const ALL_KEYS = [FLAG_V1, FLAG_PRICES_V2, FLAG_SETTINGS];

describeDb("units-fold E0 documents: create() flag off vs flag on, real Postgres", () => {
  let pool: Pool;
  let w: FoldWorld;
  let OFF: FoldTenant;
  let ON: FoldTenant;
  const promos = { current: [] as PromoRule[] };
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 6 });
    const raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    const tenantCtx = new TenantContextService();
    const prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as never),
    );
    const flags = makeTenantFlags();
    const orders = makeFoldOrders({ prisma, tenantCtx, systemConfig, flags }, promos);
    w = { raw, prisma, tenantCtx, flags, orders };
    OFF = await seedFoldTenant(
      raw,
      assertTestTenant(`qa-ufold-off-${run}`, "units-fold-e0-documents.db.spec.ts"),
      "off",
    );
    ON = await seedFoldTenant(
      raw,
      assertTestTenant(`qa-ufold-on-${run}`, "units-fold-e0-documents.db.spec.ts"),
      "on",
    );
    tenantIds.push(OFF.id, ON.id);
    flags.grant(OFF.id, []);
    flags.grant(ON.id, ALL_KEYS);
  }, 240_000);

  afterAll(async () => {
    reportCells("units-fold E0 documents: cell, equal?, label, flag consulted (NEW side)");
    promos.current = [];
    await cleanupFoldTenants(w.raw, tenantIds);
    await w.prisma?.$disconnect();
    await w.raw?.$disconnect();
    await pool?.end();
  }, 240_000);

  const pair = async (a: Omit<DocArgs, "tenant">): Promise<{ off: LineRun; on: LineRun }> => ({
    off: await createDoc(w, { ...a, tenant: OFF }),
    on: await createDoc(w, { ...a, tenant: ON }),
  });
  const both = (mode: Mode) => async (customer: string, shape: string, line: LineReq) =>
    pair({ customer, line: { ...line, shape }, mode });

  it("R4: the two tenants are seeded identically (settings snapshot, product and ladder counts) before any cell", async () => {
    const snap = async (t: FoldTenant) => ({
      config: (await w.raw.systemConfig.findMany({ where: { tenantId: t.id } })).map((r) => [
        r.key,
        r.value,
      ]),
      products: await w.raw.product.count({ where: { tenantId: t.id } }),
      ladder: await w.raw.productUnit.count({ where: { tenantId: t.id } }),
      cp: await w.raw.customerPrice.count({ where: { tenantId: t.id } }),
      typed: await w.raw.customerUnitPrice.count({ where: { tenantId: t.id } }),
      customers: await w.raw.customer.count({ where: { tenantId: t.id } }),
    });
    expect(await snap(OFF)).toEqual(await snap(ON));
    expect((await snap(OFF)).products).toBeGreaterThan(8);
  });

  // ─── ORD: a staff order line ──────────────────────────────────────────────────────────────────────────────────────
  describe("E0 ORD: a staff order, flag off vs flag on (existing data)", () => {
    const ord = both("staff");
    for (const shape of ["N-null", "N-0", "N-1", "B12", "B12-reg", "LAD"]) {
      for (const cust of ["C1", "C3"]) {
        for (const [fName, line] of Object.entries(formsOf(shape))) {
          it(`ORD ${shape} ${cust} ${fName}: the same stored line, header, stock and print; no key asked`, async () => {
            const { off, on } = await ord(cust, shape, line);
            expectSameRuns(`DB ORD ${shape} ${cust} ${fName}`, off, on);
            // a vacuous "equal" (both created nothing) is not a test
            expect(off.fig.error).toBeUndefined();
            expect(off.fig.subtotal as number).toBeGreaterThan(0);
            expect(off.fig.stockPieces as number).toBeGreaterThan(0);
          });
        }
      }
    }
    it("PIN B12 qty 3 at tier 1: 3 x 11.00 = 33.00, header total 35.72, 36 pieces of stock, printed with its box word", async () => {
      const { off, on } = await ord("C1", "B12", { qty: 3 });
      expectSameRuns("DB PIN B12 qty3", off, on);
      expect(off.fig).toMatchObject({
        qty: 3,
        unitPrice: 11,
        subtotal: 33,
        headerSubtotal: 33,
        headerTotal: 35.72,
        stockPieces: 36,
      });
    });
    it("PIN B12 split 1 box + 3 at tier 1: 11.00 x 15/12 = 13.75, 15 pieces of stock", async () => {
      const { off, on } = await ord("C1", "B12", { boxes: 1, pieces: 3 });
      expectSameRuns("DB PIN B12 split", off, on);
      expect(off.fig).toMatchObject({ subtotal: 13.75, stockPieces: 15, boxes: 1, pieces: 3 });
    });
    it("PIN B12-reg: the per-unit levy follows the piece count (0.50 x 5 = 2.50 on 5 pieces, 0.50 x 15 = 7.50 on the split)", async () => {
      const five = await ord("C1", "B12-reg", { pieces: 5 });
      expectSameRuns("DB PIN B12-reg pieces5", five.off, five.on);
      expect(five.off.fig).toMatchObject({
        subtotal: 4.58,
        categoryTaxAmount: 2.5,
        stockPieces: 5,
      });
      const split = await ord("C1", "B12-reg", { boxes: 1, pieces: 3 });
      expectSameRuns("DB PIN B12-reg split", split.off, split.on);
      expect(split.off.fig).toMatchObject({ categoryTaxAmount: 7.5, stockPieces: 15 });
    });
    it("PIN N-1: the web's boxes:1 payload keeps the operator's qty (4 x 11.00 = 44.00)", async () => {
      const { off, on } = await ord("C1", "N-1", { qty: 4, boxes: 1 });
      expectSameRuns("DB PIN N-1 boxes1", off, on);
      expect(off.fig).toMatchObject({ subtotal: 44, stockPieces: 4 });
    });
  });

  // ─── BUY: a buyer order ───────────────────────────────────────────────────────────────────────────────────────────
  describe("E0 BUY: a buyer order, with and without a promotion", () => {
    const buy = both("buyer");
    for (const shape of ["N-1", "B12", "B12-reg", "LAD"]) {
      for (const [fName, line] of Object.entries(formsOf(shape)).filter(([k]) => k !== "pieces5")) {
        it(`BUY ${shape} C1 ${fName}: the same stored line, header, stock and print; no key asked`, async () => {
          const { off, on } = await buy("C1", shape, line);
          expectSameRuns(`DB BUY ${shape} C1 ${fName}`, off, on);
          expect(off.fig.error).toBeUndefined();
          expect(off.fig.subtotal as number).toBeGreaterThan(0);
        });
      }
    }
    for (const shape of ["B12", "B12-reg"]) {
      it(`BUY ${shape} with a 10% promotion: the same flag off and flag on (SA-987 Q1 guard c)`, async () => {
        promos.current = [{ id: "pr-pct", type: "PERCENT", value: 10, minQty: null }];
        try {
          const { off, on } = await buy(
            "C1",
            shape,
            boxedShape(shape) ? { boxes: 1, pieces: 3 } : { qty: 3 },
          );
          expectSameRuns(`DB BUY ${shape} promo`, off, on);
          expect(off.fig.priceType).toBe("PROMO"); // the promo path ran
        } finally {
          promos.current = [];
        }
      });
    }
  });

  // ─── CTR: a counter sale, and its audit baseline ──────────────────────────────────────────────────────────────────
  describe("E0 CTR: a counter sale and its tier-price baseline, flag off vs flag on", () => {
    const ctr = both("counter");
    for (const shape of ["N-1", "B12", "B12-reg", "LAD"]) {
      for (const cust of ["C1", "C3"]) {
        for (const [fName, line] of Object.entries(formsOf(shape)).filter(
          ([k]) => k !== "pieces5",
        )) {
          it(`CTR ${shape} ${cust} ${fName}: the same stored line, header, stock and print; no key asked`, async () => {
            const { off, on } = await ctr(cust, shape, line);
            expectSameRuns(`DB CTR ${shape} ${cust} ${fName}`, off, on);
            expect(off.fig.error).toBeUndefined();
            expect(off.fig.subtotal as number).toBeGreaterThan(0);
          });
        }
      }
    }
    const baseline = async (t: FoldTenant, cust: string, shape: string): Promise<LineRun> => {
      const from = w.flags.calls.length;
      const map = await w.tenantCtx.run(t.id, () =>
        resolveTierPrices(w.prisma.forTenant(), t.customers[cust].customerId, [t.products[shape]], {
          prisma: w.prisma,
          entitlements: w.flags.entitlements as never,
        }),
      );
      // keyed by shape, not by the (per-tenant) product id
      return {
        fig: { [shape]: map.get(t.products[shape]) },
        consulted: w.flags.consulted(t.id, from),
      };
    };
    const expected: Record<string, number> = { C1: 11, C3: 10 };
    for (const shape of ["N-1", "B12", "LAD"]) {
      for (const cust of ["C1", "C3"]) {
        it(`CTR baseline ${shape} ${cust}: ${expected[cust]}, same both ways, no key asked`, async () => {
          const off = await baseline(OFF, cust, shape);
          const on = await baseline(ON, cust, shape);
          expectSameRuns(`DB CTR baseline ${shape} ${cust}`, off, on);
          // resolveTierPrices swallows errors into an empty map: an empty map would make "equal" vacuous
          expect(off.fig).toEqual({ [shape]: expected[cust] });
        });
      }
    }
  });

  // ─── positive controls: the toggle is live in the DB lane ─────────────────────────────────────────────────────────
  describe("positive controls: the three keys move a stored figure when the data reaches them", () => {
    const staff = both("staff");
    const pc1 = async () => staff("CT", "LAD", { qty: 3 });
    const pc2 = async () => staff("E1", "B12", { qty: 3 });

    it("PC-1: a typed pack price for the customer (CustomerUnitPrice) is billed flag on and ignored flag off, and the key is asked", async () => {
      const { off, on } = await pc1();
      expect(off.fig.error).toBeUndefined();
      expect(on.fig.error).toBeUndefined();
      expectDiffers("DB PC-1", off.fig, on.fig, {
        ruling: "SA-984 §4 E0 / SA-811a",
        fields: ["unitPrice", "subtotal"],
      });
      expect(off.fig).toMatchObject({ unitPrice: 11, subtotal: 33 }); // OLD: master's tier price
      expect(on.fig).toMatchObject({ unitPrice: 9.5, subtotal: 28.5, priceType: "SPECIAL" }); // NEW: the typed price
      expect(off.consulted.units_prices_v2).toBeGreaterThan(0); // asked on both sides: the typed row reaches the flag
      expect(on.consulted.units_prices_v2).toBeGreaterThan(0);
    });
    it("PC-2: an odd customer tier (7) takes the COMPUTED branch of loadUnitsPricesV2 (SA-812a G-1): flag on normalises it to tier 1", async () => {
      const { off, on } = await pc2();
      expect(off.fig.error).toBeUndefined();
      expect(on.fig.error).toBeUndefined();
      expectDiffers("DB PC-2", off.fig, on.fig, {
        ruling: "SA-984 §0 isOddTier / SA-812a G-1 / PF-14",
        fields: ["priceType", "originalPrice"],
      });
      expect(off.fig).toMatchObject({ priceType: "SPECIAL", originalPrice: 11 });
      expect(on.fig).toMatchObject({ priceType: "STANDARD", originalPrice: null });
      expect(on.consulted.units_prices_v2).toBeGreaterThan(0);
    });
    it("PC-3: a unit request needs flag.units_v1: refused off, a Case line on (new write, by design)", async () => {
      const { off, on } = await staff("C1", "LAD", { qty: 2, unitLabel: "Case" });
      expectDiffers("DB PC-3", off.fig, on.fig, { ruling: "SA-984 §0 units_v1 (new write)" });
      expect(String(off.fig.error)).toMatch(/Forbidden|BadRequest/);
      expect(on.fig).toMatchObject({ unitLabel: "Case", unitsPerBox: 48, unitPrice: 44 });
      expect(on.consulted.units_v1).toBeGreaterThan(0);
    });
    it("R1 dead-stub probe: a stub without hasFlagStrict makes PC-1 and PC-2 read EQUAL, so their expectDiffers goes red", async () => {
      w.flags.setStrict(false);
      try {
        for (const [name, make] of [
          ["PC-1", pc1],
          ["PC-2", pc2],
        ] as const) {
          const { off, on } = await make();
          let message = "";
          try {
            expectDiffers(`DB ${name}`, off.fig, on.fig, { ruling: "dead-stub probe" });
          } catch (e) {
            message = (e as Error).message;
          }
          expect(message).toMatch(/POSITIVE CONTROL IS DEAD/);
          console.log(`R1 dead-stub probe (DB lane), ${name}: ${message}`);
        }
      } finally {
        w.flags.setStrict(true);
      }
    });
  });

  it("sanity: expectSame reports both figures (the form every cell above uses)", () => {
    const wrong: Fig = { subtotal: -1 };
    expect(() => expectSame("DB form", { subtotal: 33 }, wrong)).toThrow(/OLD=33 {2}NEW=-1/);
  });
});

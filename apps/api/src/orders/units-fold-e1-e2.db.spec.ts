/**
 * SA-984 §4 E1 + E2 / SA-987 / SA-996, DB lane (T3): the REAL `OrdersService.create()` on Postgres. Four tenants are seeded
 * by one function and differ only in the key set the flag stub grants them:
 *   OFF = {}          a tenant that holds none of the three keys (OLD)
 *   ON  = all three   (NEW)
 *   H1  = {units_v1}  a real holder of ProductUnit rows (the writer sits behind flag.units_v1)
 *   H2  = {units_v1, units_prices_v2}  a real holder of typed customer prices (the writer sits behind flag.units_prices_v2)
 *
 * E1 (5 loose pieces of a 12-pack at $11.00, today's split vs the Piece pick):
 *   E1-a  the web's derived Piece ({boxes 0, pieces 5}): a guard row, the pack branch, equal.
 *   E1-b  the API "Piece" on a product with a level row but no Piece row: the normaliser rewrites it to the pack's pieces: equal.
 *   E1-c  an OWN-priced Piece row: count x P. INTENDED DIFFERENCE (SA-996), OLD and NEW pinned beside their formulas; the
 *         stock, the tax basis and the flag-consulted counts stay expectSame.
 * Q1 guards: (a) a buyer "Piece" is refused 400 and writes nothing, (b) a staff own-priced Piece line stores promoFreeUnits
 *   null, (c) a promoted pack line is equal flag off and on.
 * Q3: holder-only data (a level ladder, a typed pack price) compared from the key set the holder's writer gate grants, vs all three.
 *   Writer gates, read at 6395541ab: ProductUnit rows behind flag.units_v1 (products/product-units.controller.ts
 *   @RequirePlanFlag), CustomerUnitPrice rows behind flag.units_prices_v2 (customers/customer-unit-prices.controller.ts:19).
 *   ProductTierUnit (TU) and the customer's own order unit (CU) are read only inside the typed-price branch
 *   (units-prices-v2.ts:193-203), so they ride the H2 cells; no separate writer transition exists for them.
 * E2 (an odd tier, PF-14 / SA-996): the difference is pinned at OLD and NEW, and each cell has a REPAIR row (the junk tier
 *   replaced by 1, never null) that is equal flag off and on and keeps today's bill.
 *
 * Listed, not built here: CRD-a/CRD-b (the inline-return quote) and INV-c (invoice line override) need the real
 * InvoicesService/InlineReturnsQuoteService wiring; an odd tier on a unit line (off: 400 InvalidTierError, on: priced) is a
 * holder-only new write.
 *
 * STOP RULE (SA-984 §5): a red `expectSameRuns`/`expectSame` is a finding. Never edit its expectation; report OLD and NEW.
 *
 * SAFETY: throwaway `qa-ufold-*` tenants approved by assertTestTenant; afterAll deletes what this run made.
 * Run alone: node scripts/local-db-specs.mjs -- node apps/api/scripts/run-db-tests.mjs src/orders/units-fold-e1-e2.db.spec.ts
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
import { computeLineSubtotal, regulatedUnitBasis, roundMoney } from "@routeflow/pricing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { resolveTierPrices } from "./counter-sale/counter-sale-tier-price";
import { orderTotalsOf } from "./order-totals";
import {
  FLAG_PRICES_V2,
  FLAG_SETTINGS,
  FLAG_V1,
  TAX_RATE,
  expectSame,
  expectSameRuns,
  reportCells,
  type Fig,
  type LineReq,
  type LineRun,
} from "./testing/units-fold-battery";
import {
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

describeDb("units-fold E1 + E2 billed end to end: create() on real Postgres", () => {
  let pool: Pool;
  let w: FoldWorld;
  let OFF: FoldTenant;
  let ON: FoldTenant;
  let H1: FoldTenant;
  let H2: FoldTenant;
  const promos = { current: [] as PromoRule[] };
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 8 });
    const raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    const tenantCtx = new TenantContextService();
    const prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as never),
    );
    const flags = makeTenantFlags();
    w = {
      raw,
      prisma,
      tenantCtx,
      flags,
      orders: makeFoldOrders({ prisma, tenantCtx, systemConfig, flags }, promos),
    };
    const seed = async (label: string, keys: readonly string[]) => {
      const t = await seedFoldTenant(
        raw,
        assertTestTenant(`qa-ufold-${label}-${run}`, "units-fold-e1-e2.db.spec.ts"),
        label,
      );
      tenantIds.push(t.id);
      flags.grant(t.id, keys);
      return t;
    };
    OFF = await seed("off", []);
    ON = await seed("on", ALL_KEYS);
    H1 = await seed("h1", [FLAG_V1]);
    H2 = await seed("h2", [FLAG_V1, FLAG_PRICES_V2]);
  }, 300_000);

  afterAll(async () => {
    reportCells("units-fold E1/E2 billed: cell, equal?, label, flag consulted (NEW side)");
    promos.current = [];
    await cleanupFoldTenants(w.raw, tenantIds);
    await w.prisma?.$disconnect();
    await w.raw?.$disconnect();
    await pool?.end();
  }, 300_000);

  const doc = (
    tenant: FoldTenant,
    customer: string,
    shape: string,
    line: LineReq,
    mode: Mode = "staff",
  ) => createDoc(w, { tenant, customer, line: { ...line, shape }, mode } as DocArgs);
  const pair = async (customer: string, shape: string, line: LineReq, mode: Mode = "staff") => ({
    off: await doc(OFF, customer, shape, line, mode),
    on: await doc(ON, customer, shape, line, mode),
  });
  const header = (subtotal: number, levy: number) =>
    orderTotalsOf([{ subtotal, categoryTaxAmount: levy }], {
      taxRate: TAX_RATE,
      isTaxExempt: false,
      discount: 0,
    });
  const taxBasis = (fig: Fig, upb: number) =>
    regulatedUnitBasis(
      {
        qty: fig.qty as number,
        boxes: fig.boxes as number | null,
        pieces: fig.pieces as number | null,
        unitLabel: fig.unitLabel as string | null,
      },
      upb,
    ).unitBasisQty;
  /** SA-984 §4 E1 compares money, stock and the printed line; the stored SHAPE differs by construction and is not money. */
  const E1_FIELDS = [
    "subtotal",
    "categoryTaxAmount",
    "headerSubtotal",
    "headerTax",
    "headerTotal",
    "stockPieces",
    "printedQty",
  ];
  const pick = (f: Fig): Fig => Object.fromEntries(E1_FIELDS.map((k) => [k, f[k]]));

  // ─── E1-a: the web's derived Piece is the pack branch (a guard row) ─────────────────────────────────────────────────
  describe("E1-a: the web's derived Piece {boxes 0, pieces 5} is a pack line (guard row)", () => {
    for (const shape of ["B12", "LADC", "LADC-reg"]) {
      it(`E1-a ${shape}: the same stored line, header, stock and print flag off and on; no key asked`, async () => {
        const { off, on } = await pair("C1", shape, { boxes: 0, pieces: 5 });
        expectSameRuns(`DB E1-a ${shape}`, off, on);
        expect(off.fig).toMatchObject({
          pieces: 5,
          stockPieces: 5,
          printedQty: "5 pcs",
          subtotal: 4.58,
        });
      });
    }
  });

  // ─── E1-b: the API Piece with no Piece row is the pack's pieces (equal) ─────────────────────────────────────────────
  describe("E1-b: an API 'Piece' with a level row but no Piece row is rewritten to the pack's pieces", () => {
    const parity = async (cell: string, customer: string, shape: string, newLine: LineReq) => {
      const old = await doc(OFF, customer, shape, { pieces: 5 }); // today: nothing asked
      const next = await doc(ON, customer, shape, newLine); // the pick needs flag.units_v1
      expect(old.fig.error).toBeUndefined();
      expect(next.fig.error).toBeUndefined();
      expect(old.consulted.units_v1).toBe(0);
      expect(next.consulted.units_v1).toBeGreaterThan(0);
      expectSame(cell, pick(old.fig), pick(next.fig));
      return { old, next };
    };
    it("E1-b tier 1 (LADC): subtotal, stock and print equal", async () => {
      const { old } = await parity("DB E1-b LADC tier1", "C1", "LADC", {
        qty: 5,
        unitLabel: "Piece",
      });
      expect(old.fig).toMatchObject({ subtotal: 4.58, stockPieces: 5 });
    });
    it("E1-b tier 3 (LADC)", async () => {
      await parity("DB E1-b LADC tier3", "C3", "LADC", { qty: 5, unitLabel: "Piece" });
    });
    it("E1-b with the picker's displayed derived price sent back (0.92) is still the pack's pieces", async () => {
      await parity("DB E1-b LADC +displayed price", "C1", "LADC", {
        qty: 5,
        unitLabel: "Piece",
        unitPrice: 0.92,
      });
    });
    it("E1-b on the regulated twin: the levy follows the piece count, equal (0.50 x 5 = 2.50)", async () => {
      const { old } = await parity("DB E1-b LADC-reg tier1", "C1", "LADC-reg", {
        qty: 5,
        unitLabel: "Piece",
      });
      expect(old.fig.categoryTaxAmount).toBe(2.5);
    });
  });

  // ─── E1-c: an own-priced Piece row is count x P (INTENDED DIFFERENCE, SA-996) ───────────────────────────────────────
  describe("E1-c intended difference (SA-996): an own-priced Piece is charged per piece, count x P", () => {
    // Ruling SA-996 E1-c: someone who types $0.92 a piece charges $0.92 a piece; the gap to today's prorated split is only P
    // rounded to cents. Flag-on changes no existing line (a non-holder holds no ProductUnit row and the fold invents none).
    // Still expectSame: the SALE stock, the tax-basis pieces, the tax amount, and the flag-consulted counts.
    const cell = async (
      name: string,
      customer: string,
      shape: string,
      want: {
        packPrice: number;
        pieceP: number;
        oldSubtotal: number;
        newSubtotal: number;
        levy: number;
      },
    ) => {
      const old = await doc(OFF, customer, shape, { pieces: 5 });
      const next = await doc(ON, customer, shape, { qty: 5, unitLabel: "Piece" });
      expect(old.fig.error).toBeUndefined();
      expect(next.fig.error).toBeUndefined();
      expectSame(
        name + " (stock, tax basis, tax)",
        {
          stockPieces: old.fig.stockPieces,
          saleMovements: old.fig.saleMovements,
          taxBasisPieces: taxBasis(old.fig, 12),
          levy: old.fig.categoryTaxAmount,
        },
        {
          stockPieces: next.fig.stockPieces,
          saleMovements: next.fig.saleMovements,
          taxBasisPieces: taxBasis(next.fig, 12),
          levy: next.fig.categoryTaxAmount,
        },
      );
      expect(old.fig.stockPieces).toBe(5);
      expect(old.fig.categoryTaxAmount).toBe(want.levy);
      expect([old.consulted.units_v1, next.consulted.units_v1 > 0]).toEqual([0, true]);
      // PINNED beside the formula: OLD the prorated split of the pack price, NEW count x the typed Piece price
      expect(old.fig.subtotal).toBe(
        computeLineSubtotal({
          unitPrice: want.packPrice,
          qty: 5,
          boxes: 0,
          pieces: 5,
          unitsPerBox: 12,
        }),
      );
      expect(next.fig.subtotal).toBe(roundMoney(5 * want.pieceP));
      expect([old.fig.subtotal, next.fig.subtotal]).toEqual([want.oldSubtotal, want.newSubtotal]); // OBSERVED
      // header: the house helper on each side's own subtotal, never hand-typed (Order.tax is its regularTax: the levy is in the total only)
      expect(old.fig).toMatchObject({
        headerSubtotal: want.oldSubtotal,
        headerTax: header(want.oldSubtotal, want.levy).regularTax,
        headerTotal: header(want.oldSubtotal, want.levy).total,
      });
      expect(next.fig).toMatchObject({
        headerSubtotal: want.newSubtotal,
        headerTax: header(want.newSubtotal, want.levy).regularTax,
        headerTotal: header(want.newSubtotal, want.levy).total,
      });
      // the stored shape: today's split vs a factor-1 unit line; the print is the unit's own word as typed
      expect(old.fig).toMatchObject({ boxes: 0, pieces: 5, unitsPerBox: 12, unitLabel: null });
      expect(next.fig).toMatchObject({
        unitLabel: "Piece",
        unitsPerBox: 1,
        boxes: null,
        pieces: null,
        qty: 5,
      });
      expect([old.fig.printedQty, next.fig.printedQty]).toEqual(["5 pcs", "5 Piece"]);
      return { old, next };
    };
    it("E1-c intended difference (SA-996), tier 1, Piece at 0.92: 4.58 split vs 4.60 count x P", async () => {
      const { old, next } = await cell("DB E1-c LADP tier1", "C1", "LADP", {
        packPrice: 11,
        pieceP: 0.92,
        oldSubtotal: 4.58,
        newSubtotal: 4.6,
        levy: 0,
      });
      expect([old.fig.headerTotal, next.fig.headerTotal]).toEqual([4.96, 4.98]); // OBSERVED (SA-996)
    });
    it("E1-c intended difference (SA-996), tier 3, Piece at 0.83: 4.17 split vs 4.15 count x P", async () => {
      const { old, next } = await cell("DB E1-c LADP tier3", "C3", "LADP", {
        packPrice: 10,
        pieceP: 0.83,
        oldSubtotal: 4.17,
        newSubtotal: 4.15,
        levy: 0,
      });
      expect([old.fig.headerTotal, next.fig.headerTotal]).toEqual([4.51, 4.49]); // OBSERVED (SA-996)
    });
    it("E1-c intended difference (SA-996) on the regulated twin: the subtotal moves, the levy (0.50 x 5 pieces = 2.50) does not", async () => {
      await cell("DB E1-c LADP-reg tier1", "C1", "LADP-reg", {
        packPrice: 11,
        pieceP: 0.92,
        oldSubtotal: 4.58,
        newSubtotal: 4.6,
        levy: 2.5,
      });
    });
  });

  // ─── Q1 guards ──────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Q1 guards (SA-987)", () => {
    it("(a) a buyer create with unitLabel 'Piece' is refused 400 with the flag on, and writes nothing", async () => {
      const customerId = ON.customers.C1.customerId;
      const orders = await w.raw.order.count({ where: { customerId } });
      const movements = await w.raw.stockMovement.count({ where: { productId: ON.products.B12 } });
      const stock = (await w.raw.product.findUniqueOrThrow({ where: { id: ON.products.B12 } }))
        .currentStock;
      const run1 = await doc(ON, "C1", "B12", { qty: 5, unitLabel: "Piece" }, "buyer");
      expect(run1.fig).toEqual({
        error: "BadRequestException: Only staff can choose a selling unit on an order line.",
      });
      expect(await w.raw.order.count({ where: { customerId } })).toBe(orders);
      expect(await w.raw.stockMovement.count({ where: { productId: ON.products.B12 } })).toBe(
        movements,
      );
      expect(
        (await w.raw.product.findUniqueOrThrow({ where: { id: ON.products.B12 } })).currentStock,
      ).toEqual(stock);
    });
    it("(b) a staff own-priced Piece line stores promoFreeUnits null, even when a BUY_N_GET_M promotion is active", async () => {
      promos.current = [{ id: "pr-bogo", type: "BUY_N_GET_M", value: 1, minQty: 1 }];
      try {
        const next = await doc(ON, "C1", "LADP", { qty: 5, unitLabel: "Piece" });
        expect(next.fig.error).toBeUndefined();
        expect(next.fig.unitLabel).toBe("Piece");
        expect(next.fig.promoFreeUnits).toBeNull();
      } finally {
        promos.current = [];
      }
    });
    it("(c) a promoted pack line (buyer, 10% off) is equal flag off and on", async () => {
      promos.current = [{ id: "pr-pct", type: "PERCENT", value: 10, minQty: null }];
      try {
        const { off, on } = await pair("C1", "B12", { qty: 3 }, "buyer");
        expectSameRuns("DB Q1c promo pack line", off, on);
        expect(off.fig.priceType).toBe("PROMO");
        expect(off.fig.promoFreeUnits).toBeNull();
      } finally {
        promos.current = [];
      }
    });
  });

  // ─── Q3: holder-only data, compared from the holder's own key set vs all three ──────────────────────────────────────
  describe("Q3 holder-only data: a real holder's bill is unchanged when the other keys arrive", () => {
    const holderPair = async (
      holder: FoldTenant,
      customer: string,
      shape: string,
      line: LineReq,
    ) => ({
      off: await doc(holder, customer, shape, line),
      on: await doc(ON, customer, shape, line),
    });
    for (const [fName, line] of Object.entries(formsOf("LAD"))) {
      it(`LAD ${fName}: a {units_v1} holder (ProductUnit rows present) gets the same figures with all three keys`, async () => {
        const { off, on } = await holderPair(H1, "C1", "LAD", line);
        expectSameRuns(`DB Q3 LAD ${fName} {v1}->all`, off, on, { consulted: {} });
        expect(off.fig.error).toBeUndefined();
      });
    }
    for (const [fName, line] of Object.entries(formsOf("LAD")).filter(([k]) => k !== "pieces5")) {
      it(`LAD + typed pack price ${fName}: a {units_v1, units_prices_v2} holder bills the typed price already; adding the settings key moves nothing`, async () => {
        const { off, on } = await holderPair(H2, "CT", "LAD", line);
        expectSameRuns(`DB Q3 LAD+typed ${fName} {v1,v2}->all`, off, on, {
          consulted: { units_prices_v2: "some" },
        });
        expect(off.fig.unitPrice).toBe(9.5); // the holder already bills the typed price: nothing moves at D5
      });
    }
    it("a Case request: allowed for a {units_v1} holder and for all three keys, the same Case line", async () => {
      const { off, on } = await holderPair(H1, "C1", "LAD", { qty: 2, unitLabel: "Case" });
      expectSameRuns("DB Q3 LAD Case {v1}->all", off, on, { consulted: { units_v1: "some" } });
      expect(off.fig).toMatchObject({ unitLabel: "Case", unitsPerBox: 48, unitPrice: 44 });
    });
  });

  // ─── E2: an odd tier (PF-14, SA-996) ────────────────────────────────────────────────────────────────────────────────
  describe("E2 odd tier (PF-14, SA-996): flag-on normalises a tier outside 1-5; master used it raw", () => {
    // SA-996 E2: flag-on's value is the house rule (customerTierFor, PF-14), but D5 never changes an existing customer's
    // bill (census C-4 stays a D5 stop). The difference is pinned at OLD and NEW; a REPAIR row per cell proves the junk
    // tier replaced by 1 (never null) keeps today's bill and makes flag off equal flag on.
    type Side = { unitPrice: number; priceType: string; originalPrice: number | null };
    const subtotalOf = (form: LineReq, unitPrice: number): number =>
      form.boxes != null
        ? computeLineSubtotal({
            unitPrice,
            qty: 12 * form.boxes + (form.pieces ?? 0),
            boxes: form.boxes,
            pieces: form.pieces ?? 0,
            unitsPerBox: 12,
          })
        : roundMoney((form.qty ?? 0) * unitPrice);
    const FORMS: Record<string, LineReq> = { qty3: { qty: 3 }, split: { boxes: 1, pieces: 3 } };
    const LIST: Side = { unitPrice: 11, priceType: "STANDARD", originalPrice: null };
    const SPECIAL_AT_LIST: Side = { unitPrice: 11, priceType: "SPECIAL", originalPrice: 11 };
    const pinned = async (customer: string, fName: string, want: { off: Side; on: Side }) => {
      const form = FORMS[fName];
      const { off, on } = await pair(customer, "B12", form);
      expect(off.fig.error).toBeUndefined();
      expect(on.fig.error).toBeUndefined();
      // the dead-stub probe still covers these cells: an odd tier takes the computed branch, so the key is asked
      expect(off.consulted.units_prices_v2).toBeGreaterThan(0);
      expect(on.consulted.units_prices_v2).toBeGreaterThan(0);
      for (const [side, run1, s] of [
        ["OLD", off, want.off],
        ["NEW", on, want.on],
      ] as const) {
        const subtotal = subtotalOf(form, s.unitPrice);
        expect({ side, ...run1.fig }).toMatchObject({
          side,
          ...s,
          subtotal,
          headerSubtotal: subtotal,
          headerTax: header(subtotal, 0).regularTax,
          headerTotal: header(subtotal, 0).total,
        });
      }
      return off;
    };
    const repaired = async (customer: string, fName: string, junkOff: LineRun) => {
      const { off, on } = await pair(customer, "B12", FORMS[fName]);
      expectSameRuns(`DB E2 repair ${customer} ${fName}`, off, on); // flag off equals flag on; a difference stays a STOP
      const money = (f: Fig): Fig => ({
        unitPrice: f.unitPrice,
        subtotal: f.subtotal,
        headerTax: f.headerTax,
        headerTotal: f.headerTotal,
      });
      expectSame(
        `DB E2 repair ${customer} ${fName} vs the junk cell's flag-off bill`,
        money(junkOff.fig),
        money(on.fig),
      );
      expect(off.fig.priceType).toBe("STANDARD");
      expect(on.fig.priceType).toBe("STANDARD");
      expect(on.fig.originalPrice).toBeNull();
    };
    const cells: Array<[string, string, string, Side, Side]> = [
      // [cell, junk customer, repair customer, OLD, NEW]
      ["E2-1 customer tier 7, no CustomerPrice", "E1", "E1R", SPECIAL_AT_LIST, LIST],
      ["E2-2 customer tier 0, no CustomerPrice", "E2", "E2R", SPECIAL_AT_LIST, LIST],
      [
        "E2-3 CustomerPrice.pricingTier 7, customer tier 3",
        "E3",
        "E3R",
        SPECIAL_AT_LIST,
        { unitPrice: 10, priceType: "SPECIAL", originalPrice: 11 },
      ],
      [
        "E2-4 CustomerPrice.pricingTier 0, customer tier 2",
        "E4",
        "E4R",
        SPECIAL_AT_LIST,
        { unitPrice: 10.5, priceType: "SPECIAL", originalPrice: 11 },
      ],
    ];
    for (const [name, junk, repair, oldSide, newSide] of cells) {
      for (const fName of Object.keys(FORMS)) {
        it(`${name} (PF-14, SA-996) ORD ${fName}: OLD ${oldSide.unitPrice} ${oldSide.priceType} vs NEW ${newSide.unitPrice} ${newSide.priceType}; the repair row keeps today's bill`, async () => {
          const junkOff = await pinned(junk, fName, { off: oldSide, on: newSide });
          await repaired(repair, fName, junkOff);
        });
      }
    }
    // the counter's audit baseline (resolveTierPrices: raw getTierPrice flag off, the customer layer flag on)
    const baseline = async (t: FoldTenant, customer: string): Promise<LineRun> => {
      const from = w.flags.calls.length;
      const map = await w.tenantCtx.run(t.id, () =>
        resolveTierPrices(
          w.prisma.forTenant(),
          t.customers[customer].customerId,
          [t.products.B12],
          {
            prisma: w.prisma,
            entitlements: w.flags.entitlements as never,
          },
        ),
      );
      return { fig: { B12: map.get(t.products.B12) }, consulted: w.flags.consulted(t.id, from) };
    };
    for (const [name, junk, repair, oldSide, newSide] of cells) {
      it(`${name} (PF-14, SA-996) CTR baseline: OLD ${oldSide.unitPrice} vs NEW ${newSide.unitPrice}; the repair twin is equal`, async () => {
        const off = await baseline(OFF, junk);
        const on = await baseline(ON, junk);
        expect(off.fig).toEqual({ B12: oldSide.unitPrice });
        expect(on.fig).toEqual({ B12: newSide.unitPrice });
        expect(on.consulted.units_prices_v2).toBeGreaterThan(0);
        const repOff = await baseline(OFF, repair);
        const repOn = await baseline(ON, repair);
        expectSameRuns(`DB E2 repair baseline ${repair}`, repOff, repOn);
        expect(repOff.fig).toEqual(off.fig);
      });
    }
  });
});

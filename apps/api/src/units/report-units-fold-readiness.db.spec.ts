/**
 * SA-984 section 2 (D4) + SA-983 C1, real Postgres: scripts/report-units-fold-readiness.mjs, driven as the real CLI
 * (child process, --json) against throwaway approved test tenants (`qa-ufr-<run>-*`, assertTestTenant).
 *
 * Fixture:
 *   nh      non-holder: a ProductUnit on a unitsPerBox=1 product (C-1 > 0 => STOP), a CustomerUnitPrice (C-5),
 *           an open order line / DRAFT invoice line / DRAFT estimate line with a unitLabel (C-6), a customer on
 *           tier 7 and a CustomerPrice on tier 9 (C-4), no-pack products incl. a '12CT' / 'box' one (C-2 HIGH)
 *           and a 'Gum 6 PK' one (C-2 MEDIUM), a product whose tiers copy Retail (C-7), and a stale
 *           ProductBarcode row the planner would not produce (SA-983 C1)
 *   holder  holds flag.units_v1 and flag.units_prices_v2 by active override: the same C-1/C-5/C-6 rows => no STOP
 *   over    holds flag.units_v1; 201 distinct unit words => the 200 cap leaves one unlinked (C-3 STOP)
 *   plan    holds flag.units_settings_v1 through its plan's featureFlags (source "plan")
 *   prot    Stripe-linked tenant => reported as protected
 * A dry run writes nothing: row counts and a content hash of every touched table are identical before and after.
 * Runs only under `npm run local:test:db`. Needs `npm run build -w apps/api` (the script reads dist/).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SCRIPT = path.resolve(__dirname, "../../scripts/report-units-fold-readiness.mjs");
const RUN = randomUUID().slice(0, 8);
const SPEC = "report-units-fold-readiness.db.spec.ts";
const KEYS = ["nh", "holder", "over", "plan", "prot"] as const;
type Key = (typeof KEYS)[number];

describeDb("units fold-in readiness census (SA-984 D4), real Postgres, through the script", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let url: string;
  const ids = {} as Record<Key, string>;
  const slug = (k: string) => assertTestTenant(`qa-ufr-${RUN}-${k}`, SPEC);
  let planVersionId = "";

  const census = (...extra: string[]) =>
    spawnSync(process.execPath, [SCRIPT, "--target-host=127.0.0.1", ...extra], {
      env: { ...process.env, DATABASE_URL: url, PROTECTED_TENANT_SLUGS: "" },
      encoding: "utf8",
    });
  const one = (key: Key) => {
    const res = census("--json", "--tenant", ids[key]);
    expect(res.stderr).not.toMatch(/Error|refus/i);
    expect(res.status).toBe(0);
    const rep = JSON.parse(res.stdout);
    expect(rep.tenants).toHaveLength(1);
    return rep.tenants[0];
  };

  async function customerOf(tenantId: string, tag: string, pricingTier = 1) {
    const user = await prisma.user.create({
      data: {
        email: `ufr-${tag}-${RUN}@example.test`,
        username: `ufr-${tag}-${RUN}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    return prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `Acme ${tag}`,
        contactName: "T",
        tenantId,
        pricingTier,
      },
    });
  }

  const prod = (tenantId: string, name: string, over: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: { tenantId, name, unit: "each", pricePerUnit: 5, ...over },
    });

  const lineData = (tenantId: string, productId: string, unitLabel: string | null) => ({
    tenantId,
    productId,
    qty: 1,
    boxes: 0,
    pieces: 1,
    unitsPerBox: 1,
    unitPrice: "5.00",
    subtotal: "5.00",
    priceType: "STANDARD" as const,
    unitLabel,
  });

  async function openOrder(
    tenantId: string,
    customerId: string,
    productId: string,
    status: "PENDING" | "DELIVERED",
    unitLabel: string | null,
  ) {
    await prisma.order.create({
      data: {
        customerId,
        tenantId,
        status,
        subtotal: "5.00",
        total: "5.00",
        lineItems: { create: [lineData(tenantId, productId, unitLabel)] },
      },
    });
  }

  async function unitLinesInFlight(tenantId: string, customerId: string, productId: string) {
    await openOrder(tenantId, customerId, productId, "PENDING", "Case"); // counted
    await openOrder(tenantId, customerId, productId, "PENDING", ""); // empty label: not a unit line
    await openOrder(tenantId, customerId, productId, "DELIVERED", "Case"); // terminal: not counted
    const n = `${tenantId.slice(0, 6)}`;
    const item = {
      description: "x",
      qty: 1,
      unitPrice: "5.00",
      subtotal: "5.00",
      unitLabel: "Case",
    };
    await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `UFR-D-${n}`,
        status: "DRAFT",
        subtotal: "5.00",
        total: "5.00",
        items: { create: [{ ...item, tenantId }] },
      },
    });
    await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `UFR-S-${n}`,
        status: "SENT",
        subtotal: "5.00",
        total: "5.00",
        items: { create: [{ ...item, tenantId }] },
      },
    });
    await prisma.estimate.create({
      data: {
        tenantId,
        customerId,
        estimateNumber: `UFR-E-${n}`,
        status: "DRAFT",
        subtotal: "5.00",
        total: "5.00",
        items: { create: [{ ...item, tenantId }] },
      },
    });
  }

  const grant = (tenantId: string, featureKey: string, extra: Record<string, unknown> = {}) =>
    prisma.tenantFeatureOverride.create({
      data: { tenantId, featureKey, effect: "GRANT", reason: `qa ufr ${RUN}`, ...extra },
    });

  /** Row counts and a content hash of every table the census reads, for the given tenants. */
  async function checksum() {
    const t = { in: Object.values(ids) };
    const tables: Record<string, unknown[]> = {
      product: await prisma.product.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
      productUnit: await prisma.productUnit.findMany({
        where: { tenantId: t },
        orderBy: { id: "asc" },
      }),
      productBarcode: await prisma.productBarcode.findMany({
        where: { tenantId: t },
        orderBy: { id: "asc" },
      }),
      tenantUnit: await prisma.tenantUnit.findMany({
        where: { tenantId: t },
        orderBy: { id: "asc" },
      }),
      customer: await prisma.customer.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
      customerPrice: await prisma.customerPrice.findMany({
        where: { tenantId: t },
        orderBy: { id: "asc" },
      }),
      customerUnitPrice: await prisma.customerUnitPrice.findMany({
        where: { tenantId: t },
        orderBy: { id: "asc" },
      }),
      order: await prisma.order.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
      orderItem: await prisma.orderItem.findMany({
        where: { tenantId: t },
        orderBy: { id: "asc" },
      }),
      invoice: await prisma.invoice.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
      invoiceItem: await prisma.invoiceItem.findMany({
        where: { invoice: { tenantId: t } },
        orderBy: { id: "asc" },
      }),
      estimate: await prisma.estimate.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
      estimateItem: await prisma.estimateItem.findMany({
        where: { estimate: { tenantId: t } },
        orderBy: { id: "asc" },
      }),
      override: await prisma.tenantFeatureOverride.findMany({
        where: { tenantId: t },
        orderBy: { id: "asc" },
      }),
      subscription: await prisma.tenantSubscription.findMany({
        where: { tenantId: t },
        orderBy: { id: "asc" },
      }),
    };
    return Object.fromEntries(
      Object.entries(tables).map(([k, rows]) => [
        k,
        `${rows.length}:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`,
      ]),
    );
  }

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    for (const k of KEYS) {
      ids[k] = (await prisma.tenant.create({ data: { slug: slug(k), name: `ufr ${k}` } })).id;
    }

    // ── nh: the non-holder with every stop row ─────────────────────────────────────────────────────
    const nhCustomer = await customerOf(ids.nh, "nh", 7); // C-4: odd tier 7
    const nhBuyer2 = await customerOf(ids.nh, "nh2", 3); // an integer tier: not odd
    const p1 = await prod(ids.nh, "ufr single", { unitsPerBox: 1 });
    await prisma.productUnit.createMany({
      data: [
        { tenantId: ids.nh, productId: p1.id, label: "Case", factorToBase: 12 },
        { tenantId: ids.nh, productId: p1.id, label: "Each", factorToBase: 1 },
      ],
    });
    await prod(ids.nh, "ufr Cola 12CT", { unit: "box" }); // C-2 HIGH (unitsPerBox null)
    await prod(ids.nh, "ufr plain", { unitsPerBox: 0, unit: "" }); // no pack, no proposal
    await prod(ids.nh, "ufr Gum 6 PK", { unit: "" }); // C-2 MEDIUM
    await prod(ids.nh, "ufr boxed", {
      unitsPerBox: 12,
      pricePerUnit: 5,
      priceTier2: 5,
      priceTier3: 5,
      priceTier4: 0,
      priceTier5: 7,
    }); // C-7: two tier values equal Retail
    await prisma.customerPrice.create({
      data: { tenantId: ids.nh, customerId: nhCustomer.id, productId: p1.id, pricingTier: 9 },
    });
    await prisma.customerPrice.create({
      data: { tenantId: ids.nh, customerId: nhBuyer2.id, productId: p1.id, pricingTier: 3 },
    });
    await prisma.customerUnitPrice.create({
      data: {
        tenantId: ids.nh,
        customerId: nhCustomer.id,
        productId: p1.id,
        unitRef: "pack",
        price: "4.00",
      },
    });
    await unitLinesInFlight(ids.nh, nhCustomer.id, p1.id);
    // SA-983 C1: planBarcodeRows would give this boxed product a BOX + UNIT pair; the stale row is neither.
    const stale = await prod(ids.nh, "ufr stale code", {
      unitsPerBox: 12,
      barcode: "5551234567890",
    });
    await prisma.productBarcode.create({
      data: {
        tenantId: ids.nh,
        productId: stale.id,
        code: "5551234567890",
        symbology: "EAN_13",
        level: "UNIT",
        origin: "ENTERED",
        primaryFor: "UNIT",
      },
    });
    // a correct mirror (one UNIT ENTERED row for a no-pack product) and a released row: neither counts
    const ok = await prod(ids.nh, "ufr good code", { barcode: "6661234567890" });
    await prisma.productBarcode.create({
      data: {
        tenantId: ids.nh,
        productId: ok.id,
        code: "6661234567890",
        symbology: "EAN_13",
        level: "UNIT",
        origin: "ENTERED",
        primaryFor: "UNIT",
      },
    });
    await prisma.productBarcode.create({
      data: {
        tenantId: ids.nh,
        productId: ok.id,
        code: null,
        retiredCode: "7771234567890",
        symbology: "EAN_13",
        level: "BOX",
        origin: "ENTERED",
      },
    });

    // ── holder: the same shapes, but it holds the flags ────────────────────────────────────────────
    const hCustomer = await customerOf(ids.holder, "h");
    const hp = await prod(ids.holder, "ufr h single", { unitsPerBox: 1 });
    await prisma.productUnit.create({
      data: { tenantId: ids.holder, productId: hp.id, label: "Case", factorToBase: 12 },
    });
    await prisma.customerUnitPrice.create({
      data: {
        tenantId: ids.holder,
        customerId: hCustomer.id,
        productId: hp.id,
        unitRef: "pack",
        price: "4.00",
      },
    });
    await unitLinesInFlight(ids.holder, hCustomer.id, hp.id);
    await grant(ids.holder, "flag.units_v1");
    await grant(ids.holder, "flag.units_prices_v2");
    // not held: a revoked grant and an expired one
    await grant(ids.holder, "flag.units_settings_v1", { revokedAt: new Date() });
    await grant(ids.holder, "flag.units_settings_v1", {
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    });

    // ── over: 201 distinct words on one product ────────────────────────────────────────────────────
    const op = await prod(ids.over, "ufr wide", { unitsPerBox: 1 });
    await prisma.productUnit.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        tenantId: ids.over,
        productId: op.id,
        label: `word${String(i).padStart(3, "0")}`,
        factorToBase: i + 2,
      })),
    });
    await grant(ids.over, "flag.units_v1");

    // ── plan: flag.units_settings_v1 comes from the plan, not an override ──────────────────────────
    planVersionId = (
      await prisma.planVersion.create({
        data: { version: 900_000_000 + Math.floor(Math.random() * 99_999_999) },
      })
    ).id;
    await prisma.planDefinition.create({
      data: {
        planVersionId,
        planKey: "STARTER",
        name: `ufr ${RUN}`,
        featureFlags: ["flag.units_settings_v1"],
      },
    });
    await prisma.tenantSubscription.create({
      data: {
        tenantId: ids.plan,
        planKey: "STARTER",
        planVersionId,
        basePriceSnapshot: 0,
        discount: 0,
      },
    });

    // ── prot: Stripe-linked, so the "stripe-linked" arm protects it ────────────────────────────────
    await prisma.tenantSubscription.create({
      data: {
        tenantId: ids.prot,
        stripeSubId: `sub_qa_ufr_${RUN}`,
        basePriceSnapshot: 0,
        discount: 0,
      },
    });
  }, 120_000);

  afterAll(async () => {
    const all = Object.values(ids);
    const t = { in: all };
    await prisma?.productBarcode.deleteMany({ where: { tenantId: t } });
    await prisma?.customerUnitPrice.deleteMany({ where: { tenantId: t } });
    await prisma?.orderItem.deleteMany({ where: { tenantId: t } });
    await prisma?.order.deleteMany({ where: { tenantId: t } });
    await prisma?.invoiceItem.deleteMany({ where: { invoice: { tenantId: t } } });
    await prisma?.invoice.deleteMany({ where: { tenantId: t } });
    await prisma?.estimateItem.deleteMany({ where: { estimate: { tenantId: t } } });
    await prisma?.estimate.deleteMany({ where: { tenantId: t } });
    await prisma?.customerPrice.deleteMany({ where: { tenantId: t } });
    await prisma?.productUnit.updateMany({ where: { tenantId: t }, data: { parentUnitId: null } });
    await prisma?.productUnit.deleteMany({ where: { tenantId: t } });
    await prisma?.product.deleteMany({ where: { tenantId: t } });
    await prisma?.tenantUnit.deleteMany({ where: { tenantId: t } });
    await prisma?.customer.deleteMany({ where: { tenantId: t } });
    await prisma?.user.deleteMany({ where: { tenantId: t } });
    await prisma?.tenantFeatureOverride.deleteMany({ where: { tenantId: t } });
    await prisma?.tenantSubscription.deleteMany({ where: { tenantId: t } });
    await prisma?.tenant.deleteMany({ where: { id: t } });
    if (planVersionId) {
      await prisma?.planDefinition.deleteMany({ where: { planVersionId } });
      await prisma?.planVersion.deleteMany({ where: { id: planVersionId } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("the non-holder reports every column and stops on C-1, C-4, C-5, C-6 and the SA-983 C1 fold", () => {
    const t = one("nh");
    expect(t.protected).toBe(false);
    expect(t.c1).toEqual({ total: 2, onNoPack: 2, factorOne: 1 });
    expect(t.c2).toEqual({ noPack: 5, proposeHigh: 1, proposeMedium: 1 });
    expect(t.c3).toMatchObject({
      created: 2,
      existing: 0,
      overflow: 0,
      linked: 1,
      unlinkedOverflow: 0,
      skippedSynonyms: 1,
    });
    expect(t.c4).toEqual({ customers: 1, customerPrices: 1, oddValues: [7, 9] });
    expect(t.c5).toEqual({ rows: 1 });
    expect(t.c6).toEqual({ orders: 1, invoices: 1, estimates: 1 });
    expect(t.c7).toEqual({ products: 1, tierValues: 2 });
    expect(t.c8).toEqual({
      unitsV1: { held: false, source: null },
      unitsPricesV2: { held: false, source: null },
      unitsSettingsV1: { held: false, source: null },
    });
    expect(t.sa983C1).toEqual({ staleRows: 1 });
    expect(t.stops).toEqual(["C-1", "C-4", "C-5", "C-6", "SA983-C1"]);
  });

  it("a holder with the same C-1, C-5 and C-6 rows has no STOP, and C-8 names the source", () => {
    const t = one("holder");
    expect(t.c1.total).toBe(1);
    expect(t.c5.rows).toBe(1);
    expect(t.c6).toEqual({ orders: 1, invoices: 1, estimates: 1 });
    expect(t.c8).toEqual({
      unitsV1: { held: true, source: "override" },
      unitsPricesV2: { held: true, source: "override" },
      unitsSettingsV1: { held: false, source: null },
    });
    expect(t.stops).toEqual([]);
  });

  it("C-3 unlinkedOverflow above 0 stops even a holder (the 200-unit cap)", () => {
    const t = one("over");
    expect(t.c3).toMatchObject({ created: 200, overflow: 1, unlinkedOverflow: 1 });
    expect(t.stops).toEqual(["C-3"]);
  });

  it("C-8 reads a plan-bundled flag as source plan", () => {
    const t = one("plan");
    expect(t.c8.unitsSettingsV1).toEqual({ held: true, source: "plan" });
    expect(t.c8.unitsV1).toEqual({ held: false, source: null });
    expect(t.stops).toEqual([]);
  });

  it("a Stripe-linked tenant is reported as protected", () => {
    const t = one("prot");
    expect(t.protected).toBe(true);
    expect(t.stops).toEqual([]);
  });

  it("the text report prints STOP lines by tenant id and never a slug, name or product", () => {
    const res = census("--tenant", ids.nh);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`STOP ${ids.nh} C-1`);
    expect(res.stdout).toContain(`STOP ${ids.nh} SA983-C1`);
    expect(res.stdout).not.toContain(`qa-ufr-${RUN}`);
    expect(res.stdout).not.toMatch(/Acme|ufr Cola|12CT/);
  });

  it("without --tenant it covers every tenant, ours included", () => {
    const res = census("--json");
    expect(res.status).toBe(0);
    const got = new Set(
      JSON.parse(res.stdout).tenants.map((x: { tenantId: string }) => x.tenantId),
    );
    for (const k of KEYS) expect(got.has(ids[k])).toBe(true);
  });

  it("a dry run writes nothing: every touched table is byte-identical before and after", async () => {
    const before = await checksum();
    const res = census("--json");
    expect(res.status).toBe(0);
    expect(census("--tenant", ids.nh).status).toBe(0);
    expect(await checksum()).toEqual(before);
  });

  it("refuses a missing or wrong --target-host before reading anything", () => {
    const base = { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" as const };
    expect(spawnSync(process.execPath, [SCRIPT, "--json"], base).status).toBe(64);
    expect(spawnSync(process.execPath, [SCRIPT, "--target-host=nope", "--json"], base).status).toBe(
      65,
    );
  });
});

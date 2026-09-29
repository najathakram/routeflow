/**
 * #2188 / SA-385b (F2 prover, throwaway) — real-Postgres pin that an add-on has ONE TenantAddon row
 * whichever way it is keyed (legacy addonKey vs catalog SKU), with the ledger booked exactly once.
 * Drives the REAL AddonService + PlanCatalogService + BillingEventService over a real Postgres; only the
 * Stripe client (boundary) and the entitlement/feature-cache invalidators are stubbed. Uses the PUBLISHED
 * catalog when one exists (it must define MSRP $0 and a priced REGULATED_ITEMS), else self-provides one.
 * Every tenant is a throwaway `qa-*` slug approved by assertTestTenant; afterAll deletes what it made.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { AddonService } from "./addon.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { BillingEventService } from "./billing-event.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";
import { BILLING_EVENTS } from "./plan-catalog.constants";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "SA-385b — one add-on row whichever way it is keyed, ledger once (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let addons: AddonService;
    let events: BillingEventService;
    let regPrice = 0;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    let seq = 0;
    // Set only when this spec created the catalog (CI's fresh DB has none, SA-398).
    let createdVersionId: string | undefined;
    const stripeItems: string[] = [];
    const stripe = {
      isConfigured: true,
      client: {
        subscriptionItems: {
          create: jest.fn(async () => {
            const id = `si_f2_${randomUUID().slice(0, 8)}`;
            stripeItems.push(id);
            return { id };
          }),
          del: jest.fn(async () => ({})),
        },
      },
    };

    beforeAll(async () => {
      const url = requireLocalDatabaseUrl();
      pool = new Pool({ connectionString: url });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
      createdVersionId = await ensurePublishedCatalog(
        prisma,
        {
          plans: [{ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 }],
          addons: [
            { sku: "MSRP", name: "MSRP", monthlyPrice: 0 },
            { sku: "REGULATED_ITEMS", name: "Regulated items", monthlyPrice: 39 },
          ],
        },
        "addon-row-sa385b.db.spec.ts",
      );
      const catalog = new PlanCatalogService(prisma as any);
      events = new BillingEventService(prisma as any);
      const published = await catalog.getPublishedCatalog();
      const reg = published.addonSkus.find((s: any) => s.sku === "REGULATED_ITEMS");
      const msrp = published.addonSkus.find((s: any) => s.sku === "MSRP");
      expect(reg && msrp).toBeTruthy();
      regPrice = Number(reg!.monthlyPrice);
      expect(regPrice).toBeGreaterThan(0);
      addons = new AddonService(
        prisma as any,
        stripe as any,
        { invalidate: jest.fn() } as any, // entitlements (cache invalidate only)
        catalog,
        { invalidate: jest.fn() } as any, // featureResolver (cache invalidate only)
        { assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined) } as any, // authority
        events,
        // featureOverrides (default-granted add-ons, SA-540): none of this spec's keys is one.
        {
          get: jest.fn().mockResolvedValue(null),
          getMany: jest.fn().mockResolvedValue(new Map()),
        } as any,
      );
    });

    afterAll(async () => {
      if (tenantIds.length) {
        await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
      await dropPublishedCatalog(prisma, createdVersionId);
      await prisma?.$disconnect();
      await pool?.end();
    });

    /** A PAYING tenant (ACTIVE, PRODUCTION, a plan) with a Stripe subscription id to attach items to. */
    async function payingTenant(label: string): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(
        `qa-f2b2188-${run}-${seq}-${label}`,
        "addon-row-sa385b.db.spec.ts",
      );
      const t = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(t.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: t.id,
          planKey: "GROWTH",
          stripeSubId: `sub_f2_${run}_${seq}`,
          discount: 0,
        } as any,
      });
      return t.id;
    }
    // Independent of addon-row.ts (the module under test): every row keyed by the SKU OR any legacy key.
    const KEYS: Record<string, string[]> = {
      MSRP: ["MSRP", "msrp"],
      REGULATED_ITEMS: ["REGULATED_ITEMS", "tobacco_dealer"],
    };
    const rowsFor = (tenantId: string, sku: string) =>
      prisma.tenantAddon.findMany({
        where: { tenantId, OR: [{ addonKey: { in: KEYS[sku] } }, { sku }] },
        orderBy: { createdAt: "asc" },
      });
    const ledger = async (tenantId: string) => {
      const ev = await prisma.billingEvent.findMany({
        where: {
          tenantId,
          type: { in: [BILLING_EVENTS.ADDON_ENABLED, BILLING_EVENTS.ADDON_DISABLED] },
        },
        orderBy: { createdAt: "asc" },
        select: { type: true, amountDelta: true },
      });
      return { n: ev.length, sum: ev.reduce((s, e) => s + Number(e.amountDelta ?? 0), 0), ev };
    };
    const statusOf = (r: PromiseSettledResult<unknown>) =>
      r.status === "fulfilled"
        ? "ok"
        : ((r.reason as any)?.status ?? (r.reason as any)?.getStatus?.() ?? "err");

    it("(a) MSRP: admin enable by legacy key 'msrp' racing admin enable by SKU 'MSRP' ⇒ one ok + one 409, ONE active row; MSRP is $0 so no ledger row", async () => {
      const t = await payingTenant("a-msrp");
      const res = await Promise.allSettled([
        addons.enableAddon(t, "msrp", "price_f2_msrp"),
        addons.enableAddon(t, "MSRP", "price_f2_msrp"),
      ]);
      expect(res.map(statusOf).sort()).toEqual([409, "ok"]);
      const rows = await rowsFor(t, "MSRP");
      expect(rows).toHaveLength(1);
      expect(rows[0].active).toBe(true);
      expect((await ledger(t)).n).toBe(0);
    });

    it("(a) priced: 'tobacco_dealer' racing 'REGULATED_ITEMS' ⇒ one ok + one 409, ONE active row, ledger +X exactly once", async () => {
      const t = await payingTenant("a-reg");
      const res = await Promise.allSettled([
        addons.enableAddon(t, "tobacco_dealer", "price_f2_reg"),
        addons.enableAddon(t, "REGULATED_ITEMS", "price_f2_reg"),
      ]);
      expect(res.map(statusOf).sort()).toEqual([409, "ok"]);
      const rows = await rowsFor(t, "REGULATED_ITEMS");
      expect(rows).toHaveLength(1);
      expect(rows[0].active).toBe(true);
      expect(Number(rows[0].priceSnapshot)).toBe(regPrice);
      const l = await ledger(t);
      expect(l.n).toBe(1);
      expect(l.sum).toBe(regPrice);
    });

    it.each([
      ["msrp", "MSRP", "price_f2_msrp", 0],
      ["tobacco_dealer", "REGULATED_ITEMS", "price_f2_reg", -1],
    ])(
      "(a) deterministic order: legacy '%s' enabled FIRST, then SKU '%s' ⇒ 409, ONE row, ledger once",
      async (legacy, sku, price, x) => {
        const t = await payingTenant(`a-seq-${legacy}`);
        await addons.enableAddon(t, legacy as string, price as string);
        const second = await Promise.allSettled([
          addons.enableAddon(t, sku as string, price as string),
        ]);
        expect(statusOf(second[0])).toBe(409);
        const rows = await rowsFor(t, sku as string);
        expect(rows).toHaveLength(1);
        const expected = (x as number) < 0 ? regPrice : 0;
        const l = await ledger(t);
        expect([l.n, l.sum]).toEqual([expected > 0 ? 1 : 0, expected]);
      },
    );

    it("(b) a subscribe()-shaped row (addonKey = SKU, booked +X) then admin enable by legacy key ⇒ still ONE row, ledger +X once", async () => {
      const t = await payingTenant("b");
      // subscribe() cannot write a legacy-mapped SKU today, so this row + its +X booking are SEEDED in
      // subscribe()'s shape (addonKey = sku = SKU, priced, quantity 1, a Stripe item).
      await prisma.tenantAddon.create({
        data: {
          tenantId: t,
          addonKey: "REGULATED_ITEMS",
          sku: "REGULATED_ITEMS",
          active: true,
          quantity: 1,
          priceSnapshot: regPrice,
          stripeItemId: "si_f2_seed",
        },
      });
      await events.emit(
        t,
        BILLING_EVENTS.ADDON_ENABLED,
        { sku: "REGULATED_ITEMS", seeded: true },
        { amountDelta: regPrice },
      );
      const r = await Promise.allSettled([addons.enableAddon(t, "tobacco_dealer", "price_f2_reg")]);
      expect(statusOf(r[0])).toBe(409);
      const rows = await rowsFor(t, "REGULATED_ITEMS");
      expect(rows).toHaveLength(1);
      const l = await ledger(t);
      expect(l.n).toBe(1);
      expect(l.sum).toBe(regPrice);
    });

    it("(c) disable by either key ⇒ −X once; re-enable by the other key REUSES the same row (+X once); disable again ⇒ −X once", async () => {
      const t = await payingTenant("c");
      await addons.enableAddon(t, "tobacco_dealer", "price_f2_reg");
      const [first] = await rowsFor(t, "REGULATED_ITEMS");
      await addons.disableAddon(t, "REGULATED_ITEMS"); // disable by the SKU
      let rows = await rowsFor(t, "REGULATED_ITEMS");
      expect(rows).toHaveLength(1);
      expect(rows[0].active).toBe(false);
      let l = await ledger(t);
      expect([l.n, l.sum]).toEqual([2, 0]);
      await addons.enableAddon(t, "REGULATED_ITEMS", "price_f2_reg"); // re-enable by the SKU
      rows = await rowsFor(t, "REGULATED_ITEMS");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.id); // the same row, re-activated in place
      expect(rows[0].active).toBe(true);
      l = await ledger(t);
      expect([l.n, l.sum]).toEqual([3, regPrice]);
      await addons.disableAddon(t, "tobacco_dealer"); // disable by the legacy key
      rows = await rowsFor(t, "REGULATED_ITEMS");
      expect(rows).toHaveLength(1);
      expect(rows[0].active).toBe(false);
      l = await ledger(t);
      expect([l.n, l.sum]).toEqual([4, 0]);
    });
  },
);

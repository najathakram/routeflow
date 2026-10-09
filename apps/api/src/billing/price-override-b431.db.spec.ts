/**
 * B431 + SA-733 D8 — real Postgres. The price-override flow (`PlatformAdminService.updateTenantPriceOverride`)
 * books the run-rate change into the MRR ledger from TWO places: its own back-fill emit (a custom-priced
 * tenant whose `basePriceSnapshot` was still null) and `BillingService.reconcilePriceLedger` (every later
 * price change). B431 (#743 review, seam B): both could observe the pre-write snapshot and both book
 * +price for ONE change.
 *
 * The invariant pinned here is the one MrrService reconciles against: Σ BillingEvent.amountDelta ==
 * basePriceSnapshot, after every sequence. "B431 closed by <base sha>" in the PR report means this spec is
 * green on the base (the Tenant row lock + the CAS in reconcilePriceLedger, #2509 / #2551 / SA-277).
 *
 * The Stripe-first half (D8) runs against the REAL pricing service with Stripe mocked at the StripeService
 * boundary (no live call): a Stripe failure leaves the fee, the snapshot and the ledger untouched, and a
 * success writes them once.
 *
 * The real PlatformAdminService / BillingService / BillingEventService / PlatformPricingService are
 * constructed directly (like override-activation-ledger.db.spec.ts). Throwaway `qa-*` tenants. DB lane.
 */
import { randomUUID } from "crypto";
import { Client, Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { ServiceUnavailableException } from "@nestjs/common";
import { toCents } from "@routeflow/pricing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";
import { BillingService } from "./billing.service";
import { BillingEventService } from "./billing-event.service";
import { MrrService } from "./mrr.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { PlatformPricingService } from "./platform-pricing.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "B431 / SA-733 D8 — price override books once and goes Stripe-first (real Postgres)",
  () => {
    let url: string;
    let pool: Pool;
    let prisma: PrismaClient;
    let admin: PlatformAdminService;
    let events: BillingEventService;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const stripe = {
      isConfigured: true,
      getSubscription: jest.fn(),
      updateSubscription: jest.fn(),
      client: { products: { create: jest.fn() } },
    };
    let createdVersionId: string | undefined;
    let starterPrice: number;

    const planTransitionStub = {
      isEnabled: () => Promise.resolve(false),
      prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
      onPlanChange: () => Promise.resolve({ action: "none" }),
      transactionOptions: () => undefined,
      invalidateCaches: () => undefined,
    } as any;

    beforeAll(async () => {
      url = requireLocalDatabaseUrl();
      pool = new Pool({ connectionString: url });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const published = await prisma.planVersion.findFirst({ where: { status: "PUBLISHED" } });
      if (!published) {
        const version =
          ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
        const created = await prisma.planVersion.create({
          data: {
            version,
            status: "PUBLISHED",
            publishedAt: new Date(),
            notes: "qa fixture — created by price-override-b431.db.spec.ts",
            definitions: {
              create: [
                {
                  planKey: "STARTER",
                  name: "Starter",
                  monthlyPrice: 59,
                  isCustom: false,
                  featureFlags: [],
                },
              ],
            },
          },
        });
        createdVersionId = created.id;
      }
      const inPlay = await prisma.planVersion.findFirstOrThrow({
        where: { status: "PUBLISHED" },
        include: { definitions: { where: { planKey: "STARTER" } } },
      });
      starterPrice = Number(inPlay.definitions[0].monthlyPrice);
      expect(starterPrice).toBeGreaterThan(0);

      const noop = {} as any;
      const catalog = new PlanCatalogService(prisma as any);
      const pricing = new PlatformPricingService(prisma as any, catalog);
      events = new BillingEventService(prisma as any);
      const billing = new BillingService(
        prisma as any,
        stripe as any,
        { send: jest.fn().mockResolvedValue({}) } as any,
        { invalidate: jest.fn() } as any,
        events,
        pricing,
        { notifyCancelled: jest.fn(), notifySuspended: jest.fn() } as any,
        planTransitionStub,
        {
          checkoutAddonLines: async () => ({ lineItems: [], skus: [] }),
          adoptCheckoutAddons: async () => undefined,
        } as any,
      );
      admin = new PlatformAdminService(
        prisma as any,
        noop,
        noop,
        noop,
        billing,
        pricing,
        catalog,
        noop,
        noop,
        events,
        noop,
        { invalidate: jest.fn() } as any,
        audit as any,
        new MrrService(prisma as any),
        noop,
        noop,
        planTransitionStub,
      );
    });

    beforeEach(() => {
      jest.clearAllMocks();
    });

    afterAll(async () => {
      if (tenantIds.length) {
        await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
      if (createdVersionId) {
        await prisma.addonSku.deleteMany({ where: { planVersionId: createdVersionId } });
        await prisma.planDefinition.deleteMany({ where: { planVersionId: createdVersionId } });
        await prisma.planVersion.delete({ where: { id: createdVersionId } });
      }
      await prisma.$disconnect();
      await pool.end();
    });

    /** An ACTIVE PRODUCTION tenant on STARTER. `snapshot: null` is the back-fill shape; a number seeds a
     *  matching ledger row so Σ amountDelta == snapshot holds before the call under test. */
    async function makeTenant(
      tag: string,
      opts: { snapshot: number | null; stripeSubId?: string },
    ): Promise<string> {
      const slug = assertTestTenant(`qa-b431-${tag}-${run}`, "price-override-b431.db.spec.ts");
      const tenant = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          planKey: "STARTER",
          basePriceSnapshot: opts.snapshot,
          discount: 0,
          stripeSubId: opts.stripeSubId ?? null,
          billingInterval: opts.stripeSubId ? "month" : null,
        },
      });
      if (opts.snapshot) {
        await events.emit(
          tenant.id,
          "plan.changed",
          { seeded: true },
          { amountDelta: opts.snapshot, actorId: null },
        );
      }
      return tenant.id;
    }

    async function ledger(tenantId: string) {
      const rows = await prisma.billingEvent.findMany({
        where: { tenantId, type: "plan.changed" },
        select: { amountDelta: true },
        orderBy: { createdAt: "asc" },
      });
      const sub = await prisma.tenantSubscription.findUniqueOrThrow({
        where: { tenantId },
        select: { basePriceSnapshot: true, priceOverrideMonthly: true },
      });
      return {
        deltas: rows.map((r) => Number(r.amountDelta)),
        sum: rows.reduce((s, r) => s + Number(r.amountDelta ?? 0), 0),
        snapshot: sub.basePriceSnapshot == null ? null : Number(sub.basePriceSnapshot),
        override: sub.priceOverrideMonthly == null ? null : Number(sub.priceOverrideMonthly),
      };
    }

    it("B431: a back-fill override on a null-snapshot tenant books +price exactly once (Σ deltas == snapshot)", async () => {
      const id = await makeTenant("backfill", { snapshot: null });

      await admin.updateTenantPriceOverride(id, { monthly: 1200 } as any, "admin-b431");

      const l = await ledger(id);
      expect(l.deltas).toEqual([1200]);
      expect(l.sum).toBe(1200);
      expect(l.snapshot).toBe(1200);
      expect(l.override).toBe(1200);
    });

    it("B431: the same price entered twice, then a re-sync, still books it once", async () => {
      const id = await makeTenant("repeat", { snapshot: null });

      await admin.updateTenantPriceOverride(id, { monthly: 1200 } as any, "admin-b431");
      await admin.updateTenantPriceOverride(id, { monthly: 1200 } as any, "admin-b431");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).billingService.syncStripeSubscriptionPrice(id);

      const l = await ledger(id);
      expect(l.deltas).toEqual([1200]);
      expect(l.sum).toBe(l.snapshot);
    });

    it("B431: a later price change books only its difference (1200 -> 1000 = -200)", async () => {
      const id = await makeTenant("change", { snapshot: null });

      await admin.updateTenantPriceOverride(id, { monthly: 1200 } as any, "admin-b431");
      await admin.updateTenantPriceOverride(id, { monthly: 1000 } as any, "admin-b431");

      const l = await ledger(id);
      expect(l.deltas).toEqual([1200, -200]);
      expect(l.sum).toBe(1000);
      expect(l.snapshot).toBe(1000);
    });

    it("B431: an override and a reconcile contending for the Tenant row both queue behind it and the ledger still equals the snapshot", async () => {
      const id = await makeTenant("race", { snapshot: null });
      const billing = (admin as any).billingService as BillingService;

      // T2 holds the Tenant row lock; the override's transaction and the reconcile both block on it.
      const t2 = new Client({ connectionString: url });
      await t2.connect();
      let both: Promise<unknown[]> | undefined;
      try {
        await t2.query("BEGIN");
        await t2.query(`SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE`, [id]);
        const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        both = Promise.all([
          admin.updateTenantPriceOverride(id, { monthly: 1200 } as any, "admin-b431"),
          billing.syncStripeSubscriptionPrice(id),
        ]);
        // ENTRY, condition-based (never timed): both sessions are waiting on a lock in this database (row
        // locks queue, so the second waits on the first, not on T2 - count Lock waiters, not T2's blockees).
        // Prisma's interactive-transaction timeout is 5 s, so the poll gives up well before it.
        const deadline = Date.now() + 3_500;
        let waiting = 0;
        while (waiting < 2 && Date.now() < deadline) {
          const q = await pool.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
            [pid],
          );
          waiting = q.rows[0].n;
          if (waiting < 2) await new Promise((r) => setTimeout(r, 20));
        }
        if (waiting < 2) {
          throw new Error(`entry not reached: ${waiting} session(s) waiting on the Tenant lock`);
        }
      } finally {
        await t2.query("COMMIT").catch(() => undefined);
        await t2.end().catch(() => undefined);
      }
      await both;

      const l = await ledger(id);
      expect(l.sum).toBe(l.snapshot); // never double-booked, whichever of the two won the lock
      expect(l.override).toBe(1200);
    }, 60_000);

    describe("D8 Stripe-first against the real pricing service (Stripe mocked at the StripeService boundary)", () => {
      const stripeSubFor = (cents: number) => ({
        status: "active",
        items: {
          data: [
            {
              id: "si_1",
              price: {
                id: "price_a",
                unit_amount: cents,
                recurring: { interval: "month" },
                product: "prod_1",
              },
            },
          ],
        },
      });

      it("a Stripe failure leaves the fee, the snapshot and the ledger exactly as they were; no audit row", async () => {
        const id = await makeTenant("stripe-fail", {
          snapshot: starterPrice,
          stripeSubId: `sub_fail_${run}`,
        });
        stripe.getSubscription.mockResolvedValue(stripeSubFor(toCents(starterPrice)));
        stripe.updateSubscription.mockRejectedValue(new Error("stripe down"));
        const before = await ledger(id);

        await expect(
          admin.updateTenantPriceOverride(id, { monthly: 80 } as any, "admin-b431"),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(await ledger(id)).toEqual(before);
        expect(before.override).toBeNull();
        expect(audit.log).not.toHaveBeenCalled();
      });

      it.each([
        ["next_cycle", "none"],
        ["now_prorated", "create_prorations"],
      ])(
        "effective=%s reaches Stripe as proration_behavior=%s, with a keyed update, and books the change once",
        async (effective, proration) => {
          const id = await makeTenant(`stripe-ok-${effective}`, {
            snapshot: starterPrice,
            stripeSubId: `sub_ok_${effective}_${run}`,
          });
          stripe.getSubscription.mockResolvedValue(stripeSubFor(toCents(starterPrice)));
          stripe.updateSubscription.mockResolvedValue({});

          await admin.updateTenantPriceOverride(
            id,
            { monthly: 80, effective } as any,
            "admin-b431",
          );

          expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
          const [subId, params, options] = stripe.updateSubscription.mock.calls[0];
          expect(subId).toBe(`sub_ok_${effective}_${run}`);
          expect(params.proration_behavior).toBe(proration);
          expect(params.items[0].price_data.unit_amount).toBe(8000);
          expect(options.idempotencyKey).toEqual(
            expect.stringContaining(`${id}:price-override:8000:${effective}:v`),
          );

          const l = await ledger(id);
          expect(l.override).toBe(80);
          expect(l.snapshot).toBe(80);
          expect(l.deltas).toEqual([starterPrice, 80 - starterPrice]);
          expect(l.sum).toBe(l.snapshot);

          const meta = audit.log.mock.calls.at(-1)![0].meta;
          expect(meta).toMatchObject({
            kind: "price_override",
            effective,
            oldPrice: { monthly: starterPrice },
            newPrice: { monthly: 80 },
          });
          expect(audit.log.mock.calls.at(-1)![0].userId).toBe("admin-b431");
        },
      );

      it("M7: an owner price cut on a past_due tenant reaches Stripe (proration none) and books once", async () => {
        const id = await makeTenant("past-due", {
          snapshot: starterPrice,
          stripeSubId: `sub_pd_${run}`,
        });
        stripe.getSubscription.mockResolvedValue({
          ...stripeSubFor(toCents(starterPrice)),
          status: "past_due",
        });
        stripe.updateSubscription.mockResolvedValue({});

        await admin.updateTenantPriceOverride(
          id,
          { monthly: 40, effective: "now_prorated" } as any,
          "admin-b431",
        );

        expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
        expect(stripe.updateSubscription.mock.calls[0][1].proration_behavior).toBe("none");
        expect(stripe.updateSubscription.mock.calls[0][1].items[0].price_data.unit_amount).toBe(
          4000,
        );
        const l = await ledger(id);
        expect(l.sum).toBe(l.snapshot);
        expect(l.snapshot).toBe(40);
      });
    });
  },
);

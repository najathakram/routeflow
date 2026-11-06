/**
 * W1 (COPY 2q, PLAN F24) - the owner's "plan change, no card" mail, driven through the REAL SubscriptionMutationService and the
 * REAL OwnerAlertService on Postgres (only the mail transport is a fake). The decision lives in the service, after each commit:
 *
 *   F24   a trial picks a plan with no card            one mail, naming the plan and cycle
 *   F24b  an active account upgrades                   one mail
 *   F24c  it schedules a downgrade, cancels, undoes    one mail each
 *   F24d  an account with a Stripe subscription        no mail
 *   F24e  the final read rejects after the change      the mail has already gone
 *   F24g  a repeat (same downgrade, second cancel, undo with nothing armed)   no mail
 *         a trial's cancel, and a cancel on a read-only account (a no-op)     no mail
 *
 * Throwaway `qa-w1alert-*` tenants (assertTestTenant), deleted afterwards. DB lane.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OwnerAlertService } from "../email/owner-alert.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";
import { BillingEventService } from "./billing-event.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "owner-alert-plan-change.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;

describeDb("W1 owner alerts on plan changes (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let createdVersionId: string | undefined;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  const send = jest.fn(async (_m: unknown) => ({ delivered: true, transport: "smtp" }));
  const getSubscription = jest.fn();
  let mutations: SubscriptionMutationService;
  let alerts: OwnerAlertService;

  const planTransition = {
    isEnabled: () => Promise.resolve(false),
    prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
    onPlanChange: () => Promise.resolve({ action: "none" }),
    transactionOptions: () => undefined,
    invalidateCaches: () => undefined,
  } as any;

  function build(ownerAlerts: unknown) {
    const catalog = new PlanCatalogService(prisma as any);
    return new SubscriptionMutationService(
      prisma as any,
      catalog,
      new ProrationService(prisma as any, catalog),
      { getSubscription } as any,
      { invalidate: jest.fn() } as any, // entitlements
      new BillingEventService(prisma as any),
      { invalidate: jest.fn() } as any, // tenantStatus
      { isConfigured: false } as any, // stripe: none of these rows reaches it
      {
        notifyUpgradeConfirmed: jest.fn().mockResolvedValue(undefined),
        notifyDowngradeScheduled: jest.fn().mockResolvedValue(undefined),
      } as any, // billingNotification
      planTransition,
      undefined, // scheduledPrice
      undefined, // dunning
      undefined, // autoLocks
      undefined, // cardFirst
      ownerAlerts as any,
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      {
        plans: [
          { planKey: "STARTER", name: "Starter", monthlyPrice: 99 },
          { planKey: "GROWTH", name: "Growth", monthlyPrice: 249 },
          { planKey: "SCALE", name: "Scale", monthlyPrice: 499 },
        ],
        addons: [],
      },
      SPEC,
    );
    alerts = new OwnerAlertService(prisma as any, { send } as any);
    mutations = build(alerts);
  });

  beforeEach(() => {
    send.mockClear();
    getSubscription.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await dropPublishedCatalog(prisma, createdVersionId);
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function tenantIn(
    status: string,
    sub: Record<string, unknown> | null = {},
    readOnlyReason: string | null = null,
  ): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(`qa-w1alert-${run}-${seq}`, SPEC);
    const t = await prisma.tenant.create({
      data: {
        slug,
        name: `Acme ${slug}`,
        class: TenantClass.PRODUCTION,
        status: status as TenantStatus,
        readOnlyReason,
      },
    });
    tenantIds.push(t.id);
    if (sub) {
      await prisma.tenantSubscription.create({
        data: {
          tenantId: t.id,
          planKey: "GROWTH",
          currentPlan: "GROWTH",
          basePriceSnapshot: 249,
          discount: 0,
          cycle: "MONTHLY",
          periodEnd: new Date(Date.now() + 20 * DAY),
          ...sub,
        } as any,
      });
    }
    return t.id;
  }
  const subRow = (id: string) =>
    prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
  const mails = () => send.mock.calls.map((c) => c[0] as { subject: string; text: string });
  const firstLine = (i = 0) => mails()[i].text.split("\n\n")[0];

  describe("a change that commits sends one mail", () => {
    it("F24: a trial picks a plan with no card -> one mail naming the plan and cycle", async () => {
      const id = await tenantIn("TRIAL", { planKey: "STARTER", currentPlan: "STARTER" });
      await mutations.subscribe(id, { planKey: "STARTER", cycle: "MONTHLY" as any });
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id } })).status).toBe("ACTIVE");
      expect(mails()).toHaveLength(1);
      expect(mails()[0].subject).toMatch(/^RouteFlow plan change, no card: Acme /);
      expect(firstLine()).toMatch(/picked Starter, billed monthly\. No card was taken\.$/);
    });

    it("F24h: an active account switches monthly to annual -> one mail naming the new cycle", async () => {
      const id = await tenantIn("ACTIVE", { planKey: "STARTER", currentPlan: "STARTER" });
      await mutations.subscribe(id, { planKey: "STARTER", cycle: "ANNUAL" as any });
      expect(mails()).toHaveLength(1);
      expect(firstLine()).toMatch(/billed annually/);
    });

    it("F24b: an active account upgrades -> one mail naming the new plan", async () => {
      const id = await tenantIn("ACTIVE", { planKey: "STARTER", currentPlan: "STARTER" });
      await mutations.upgrade(id, "GROWTH");
      expect(mails()).toHaveLength(1);
      expect(firstLine()).toMatch(/moved up to Growth\.$/);
    });

    it("F24c: a downgrade, a cancel (over it) and an undo each send one mail", async () => {
      const id = await tenantIn("ACTIVE");
      await mutations.downgrade(id, "STARTER", []);
      expect(mails()).toHaveLength(1);
      expect(firstLine(0)).toMatch(/moves down to Starter on /);
      await mutations.cancel(id);
      expect(mails()).toHaveLength(2);
      expect(firstLine(1)).toMatch(/cancelled\. It ends on /);
      await mutations.resume(id);
      expect(mails()).toHaveLength(3);
      expect(firstLine(2)).toMatch(/undid its change\.$/);
    });
  });

  describe("a repeat or a no-op sends nothing (F24g)", () => {
    it("the same downgrade twice -> one mail; a different target is a change", async () => {
      const id = await tenantIn("ACTIVE", { planKey: "SCALE", currentPlan: "SCALE" });
      await mutations.downgrade(id, "GROWTH", []);
      await mutations.downgrade(id, "GROWTH", []);
      expect(mails()).toHaveLength(1);
      await mutations.downgrade(id, "STARTER", []);
      expect(mails()).toHaveLength(2);
    });

    it("a second cancel -> one mail", async () => {
      const id = await tenantIn("ACTIVE");
      await mutations.cancel(id);
      await mutations.cancel(id);
      expect(mails()).toHaveLength(1);
      expect((await subRow(id)).cancelAtPeriodEnd).toBe(true);
    });

    it("an undo with nothing armed -> no mail; an undo of an armed cancel -> one", async () => {
      const id = await tenantIn("ACTIVE");
      await mutations.resume(id);
      expect(mails()).toHaveLength(0);
      await mutations.cancel(id);
      await mutations.resume(id);
      await mutations.resume(id);
      expect(mails().map((m) => m.text.split("\n\n")[0].replace(/^Acme \S+ /, ""))).toEqual([
        expect.stringMatching(/^cancelled\./),
        "undid its change.",
      ]);
    });

    it("a trial's cancel is not a plan change -> no mail, the trial ends", async () => {
      const id = await tenantIn("TRIAL");
      await expect(mutations.cancel(id)).resolves.toMatchObject({ cancelled: "trial" });
      expect(mails()).toHaveLength(0);
    });

    it("a cancel on a read-only account is a no-op -> no mail, however often it is clicked", async () => {
      const id = await tenantIn("READ_ONLY", {}, "trial_expired");
      await expect(mutations.cancel(id)).resolves.toMatchObject({ cancelled: "already_read_only" });
      await mutations.cancel(id);
      expect(mails()).toHaveLength(0);
    });

    it("the account is no longer ACTIVE when the mail would go -> no mail (the service checks)", async () => {
      const id = await tenantIn("READ_ONLY", {}, "trial_expired");
      await alerts.planChangeNoCard(id, "upgrade");
      expect(mails()).toHaveLength(0);
    });
  });

  describe("who is billed elsewhere, and what failed", () => {
    it("F24d: an account with a Stripe subscription -> no mail", async () => {
      const id = await tenantIn("ACTIVE", { stripeSubId: "sub_test_w1" });
      await mutations.downgrade(id, "STARTER", []);
      expect(mails()).toHaveLength(0);
      expect((await subRow(id)).downgradeToPlanKey).toBe("STARTER");
    });

    it("a refused change sends nothing (the mail only follows a commit)", async () => {
      const id = await tenantIn("ACTIVE", { planKey: "STARTER", currentPlan: "STARTER" });
      await expect(mutations.downgrade(id, "SCALE", [])).rejects.toThrow();
      await expect(mutations.upgrade(id, "STARTER")).rejects.toThrow();
      expect(mails()).toHaveLength(0);
    });

    it("F24e: the final read rejects after the cancel commits -> the route fails, the mail has already gone", async () => {
      const id = await tenantIn("ACTIVE");
      getSubscription.mockRejectedValueOnce(new Error("read failed"));
      await expect(mutations.cancel(id)).rejects.toThrow("read failed");
      expect((await subRow(id)).cancelAtPeriodEnd).toBe(true);
      expect(mails()).toHaveLength(1);
    });

    it("a mail that fails never fails the change", async () => {
      const failing = build({
        planChangeNoCard: jest.fn(async () => {
          throw new Error("mail down");
        }),
      });
      const id = await tenantIn("ACTIVE");
      await expect(failing.cancel(id)).resolves.toBeUndefined();
      expect((await subRow(id)).cancelAtPeriodEnd).toBe(true);
    });

    it("no alert service wired -> the change still commits (the pin below keeps the real graph honest)", async () => {
      const bare = build(undefined);
      const id = await tenantIn("ACTIVE");
      await bare.cancel(id);
      expect((await subRow(id)).cancelAtPeriodEnd).toBe(true);
      expect(mails()).toHaveLength(0);
    });
  });
});

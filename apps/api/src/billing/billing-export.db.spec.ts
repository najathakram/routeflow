/**
 * B1187 — real-Postgres pin of SubscriptionService.getExport: the tenant-scoped actor lookup,
 * a cross-tenant actor id, and the projected shape (invoices, events, subscription, usage).
 * getSubscription/getUsage are stubbed (they are covered by their own specs); the Prisma reads
 * the projection depends on are real.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SubscriptionService } from "./subscription.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("B1187 — billing export projection (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let svc: SubscriptionService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let staff: string;

  async function mkTenant(label: string) {
    const slug = assertTestTenant(`qa-b1187-${run}-${label}`, "billing-export.db.spec.ts");
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    return t.id;
  }
  async function mkUser(
    label: string,
    role: "TENANT_ADMIN" | "SUPER_ADMIN",
    tenantId: string | null,
  ) {
    const u = await prisma.user.create({
      data: {
        email: `b1187-${run}-${label}@example.test`,
        username: `b1187-${run}-${label}`,
        role,
        tenantId,
      },
    });
    userIds.push(u.id);
    return u.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    tenantA = await mkTenant("a");
    tenantB = await mkTenant("b");
    userA = await mkUser("ua", "TENANT_ADMIN", tenantA);
    userB = await mkUser("ub", "TENANT_ADMIN", tenantB);
    staff = await mkUser("sa", "SUPER_ADMIN", null);
    await prisma.billingEvent.createMany({
      data: [
        {
          tenantId: tenantA,
          type: "plan.changed",
          payload: {
            fromPlan: "STARTER",
            toPlan: "GROWTH",
            stripeReason: "r",
            platformAdmin: true,
          },
          amountDelta: 20,
          actorId: userA,
        },
        {
          tenantId: tenantA,
          type: "plan.changed",
          payload: { toPlan: "SCALE", source: "x" },
          amountDelta: 5,
          actorId: userB,
        },
        {
          tenantId: tenantA,
          type: "seat.added",
          payload: { quantity: 1 },
          amountDelta: 1,
          actorId: staff,
        },
        {
          tenantId: tenantA,
          type: "trial.expired",
          payload: { at: "2026-01-01T00:00:00.000Z" },
          actorId: null,
        },
      ],
    });
    await prisma.rfInvoice.create({
      data: {
        tenantId: tenantA,
        number: `RF-B1187-${run}`,
        amount: 49,
        status: "PAID",
        pdfKey: "secret.pdf",
      },
    });
    svc = new SubscriptionService(prisma as any, {} as any, {} as any, {} as any);
    jest
      .spyOn(svc, "getSubscription")
      .mockResolvedValue({ planKey: "GROWTH", stripeSubId: "sub_x" } as never);
    jest.spyOn(svc, "getUsage").mockResolvedValue([] as never);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.rfInvoice.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("labels actors: own tenant user 'you'; other tenant's user and platform staff 'RouteFlow support'; none 'system'", async () => {
    const out = await svc.getExport(tenantA);
    const byType = (t: string) => out.billingEvents.filter((e) => e.type === t);
    const plan = byType("plan.changed");
    expect(plan.map((e) => e.actor).sort()).toEqual(["RouteFlow support", "you"]);
    expect(byType("seat.added")[0].actor).toBe("RouteFlow support");
    expect(byType("trial.expired")[0].actor).toBe("system");
  });

  it("internal bookkeeping event types are absent from the export", async () => {
    const out = await svc.getExport(tenantA);
    const types = out.billingEvents.map((e) => e.type);
    expect(types).not.toContain("tenant.class_changed");
    expect(types).not.toContain("reconciliation.snapshot_backfilled");
    expect(types).toContain("seat.added");
  });

  it("exports the projected shape only", async () => {
    const out = await svc.getExport(tenantA);
    const json = JSON.stringify(out);
    for (const k of [
      "actorId",
      "tenantId",
      "pdfKey",
      "stripeReason",
      "stripeSubId",
      "platformAdmin",
      userA,
      userB,
      staff,
    ]) {
      expect(json).not.toContain(k);
    }
    expect(Object.keys(out.invoices[0]).sort()).toEqual([
      "amount",
      "cycle",
      "issuedAt",
      "number",
      "status",
    ]);
    expect(out.subscription).toEqual({ planKey: "GROWTH" });
    const first = out.billingEvents.find((e) => e.type === "plan.changed" && e.actor === "you")!;
    expect(first.payload).toEqual({ fromPlan: "STARTER", toPlan: "GROWTH" });
  });

  it("tenant B's export never contains tenant A's rows", async () => {
    const out = await svc.getExport(tenantB);
    expect(out.billingEvents).toEqual([]);
    expect(out.invoices).toEqual([]);
  });
});

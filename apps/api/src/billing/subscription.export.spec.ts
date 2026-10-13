import { BILLING_EXPORT_INVOICE_FIELDS } from "./billing-export-fields";
import { SubscriptionService } from "./subscription.service";

const TENANT = "t-1";

function build(events: Record<string, unknown>[], users: Record<string, unknown>[]) {
  const prisma = {
    billingEvent: { findMany: jest.fn().mockResolvedValue(events) },
    rfInvoice: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "i1",
          tenantId: TENANT,
          number: "RF-2026-0001",
          amount: 49,
          status: "PAID",
          cycle: "MONTHLY",
          pdfKey: "k.pdf",
          issuedAt: new Date("2026-01-01"),
          futureColumn: "x",
        },
      ]),
    },
    user: { findMany: jest.fn().mockResolvedValue(users) },
  };
  const svc = new SubscriptionService(prisma as never, {} as never, {} as never, {} as never);
  jest.spyOn(svc, "getSubscription").mockResolvedValue({ plan: "x" } as never);
  jest.spyOn(svc, "getUsage").mockResolvedValue([] as never);
  return { svc, prisma };
}

const ev = (over: Record<string, unknown>) => ({
  id: "e",
  tenantId: TENANT,
  type: "plan.changed",
  payload: { fromPlan: "A", toPlan: "B", stripeReason: "r", stripeSynced: true, source: "s" },
  amountDelta: 5,
  actorId: null,
  createdAt: new Date("2026-01-02"),
  ...over,
});

describe("SubscriptionService.getExport (B1187)", () => {
  it("projects invoices through the allowlist", async () => {
    const { svc } = build([], []);
    const out = await svc.getExport(TENANT);
    expect(Object.keys(out.invoices[0]).sort()).toEqual([...BILLING_EXPORT_INVOICE_FIELDS].sort());
  });

  it("actor: a tenant user is 'you'", async () => {
    const { svc } = build(
      [ev({ actorId: "u1" })],
      [{ id: "u1", role: "TENANT_ADMIN", tenantId: TENANT }],
    );
    expect((await svc.getExport(TENANT)).billingEvents[0].actor).toBe("you");
  });

  it("actor: platform staff (SUPER_ADMIN, no tenant) is 'RouteFlow support'", async () => {
    const { svc } = build(
      [ev({ actorId: "sa1" })],
      [{ id: "sa1", role: "SUPER_ADMIN", tenantId: null }],
    );
    expect((await svc.getExport(TENANT)).billingEvents[0].actor).toBe("RouteFlow support");
  });

  it("actor: no actor / cron is 'system'", async () => {
    const { svc } = build([ev({ actorId: null })], []);
    expect((await svc.getExport(TENANT)).billingEvents[0].actor).toBe("system");
  });

  it("actor: an id belonging to another tenant is never 'you'", async () => {
    const { svc } = build(
      [ev({ actorId: "u2" })],
      [{ id: "u2", role: "OPERATOR", tenantId: "other" }],
    );
    expect((await svc.getExport(TENANT)).billingEvents[0].actor).toBe("RouteFlow support");
  });

  it("never exports actorId, id, tenantId, or forbidden payload keys", async () => {
    const { svc } = build(
      [ev({ actorId: "u1" })],
      [{ id: "u1", role: "OPERATOR", tenantId: TENANT }],
    );
    const out = await svc.getExport(TENANT);
    const json = JSON.stringify(out.billingEvents) + JSON.stringify(out.invoices);
    for (const k of [
      "actorId",
      "tenantId",
      "pdfKey",
      "stripeReason",
      "stripeSynced",
      "platformAdmin",
      "futureColumn",
      // Admin-only RfInvoice columns (manual invoices due).
      "paidById",
      "paidNote",
      "voidReason",
      "issuedById",
      "sendCount",
      "lastSentAt",
      "needsReview",
    ]) {
      expect(json).not.toContain(`"${k}"`);
    }
    expect(json).not.toContain('"source"');
    expect(out.billingEvents[0].payload).toEqual({ fromPlan: "A", toPlan: "B" });
  });

  it("looks users up only for the distinct actor ids", async () => {
    const { svc, prisma } = build([ev({ actorId: "u1" }), ev({ actorId: "u1" })], []);
    await svc.getExport(TENANT);
    expect(prisma.user.findMany.mock.calls[0][0].where.id.in).toEqual(["u1"]);
  });

  it("actor lookup is tenant-scoped and a cross-tenant id is 'RouteFlow support', never 'you'", async () => {
    // The scoped query returns nothing for another tenant's user, exactly as the real DB would.
    const { svc, prisma } = build([ev({ actorId: "other-tenant-user" })], []);
    const out = await svc.getExport(TENANT);
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      id: { in: ["other-tenant-user"] },
    });
    expect(out.billingEvents[0].actor).toBe("RouteFlow support");
  });

  it("a SUPER_ADMIN row even carrying this tenantId is support, not 'you'", async () => {
    const { svc } = build(
      [ev({ actorId: "sa" })],
      [{ id: "sa", role: "SUPER_ADMIN", tenantId: TENANT }],
    );
    expect((await svc.getExport(TENANT)).billingEvents[0].actor).toBe("RouteFlow support");
  });

  it("subscription and usage drop unlisted keys (futureColumn) at every level", async () => {
    const { svc } = build([], []);
    jest.spyOn(svc, "getSubscription").mockResolvedValue({
      planKey: "GROWTH",
      flags: ["flag.returns"],
      status: "ACTIVE",
      monthlyPrice: 99,
      stripeSubId: "sub_x",
      stripeCustomerId: "cus_x",
      futureColumn: "x",
      addons: [
        { sku: "A", name: "Addon", quantity: 1, monthly: 5, priceSnapshot: 5, stripeItemId: "si" },
      ],
    } as never);
    jest
      .spyOn(svc, "getUsage")
      .mockResolvedValue([
        { meter: "SEATS", used: 1, included: 5, remaining: 4, resetsAt: null, futureColumn: "y" },
      ] as never);
    const out = await svc.getExport(TENANT);
    expect(out.subscription).toEqual({
      planKey: "GROWTH",
      flags: ["flag.returns"],
      status: "ACTIVE",
      monthlyPrice: 99,
      addons: [{ sku: "A", name: "Addon", quantity: 1, monthly: 5 }],
    });
    expect(out.usage).toEqual([
      { meter: "SEATS", used: 1, included: 5, remaining: 4, resetsAt: null },
    ]);
  });

  it("row 350: a comp add-on exports comp:true with a null monthly (never a price)", async () => {
    const { svc } = build([], []);
    jest.spyOn(svc, "getSubscription").mockResolvedValue({
      planKey: "GROWTH",
      flags: [],
      addons: [
        { sku: "A", name: "Addon", quantity: 1, comp: true, monthly: null, isComp: true },
        { sku: "B", name: "Paid", quantity: 2, comp: false, monthly: 10 },
      ],
    } as never);
    const out = await svc.getExport(TENANT);
    expect(out.subscription.addons).toEqual([
      { sku: "A", name: "Addon", quantity: 1, comp: true, monthly: null },
      { sku: "B", name: "Paid", quantity: 2, comp: false, monthly: 10 },
    ]);
  });

  it("absent addons/flags fail closed to [] (absent => [])", async () => {
    const { svc } = build([], []);
    jest.spyOn(svc, "getSubscription").mockResolvedValue({
      planKey: "GROWTH",
      stripeSubId: "sub_x",
    } as never);
    const out = await svc.getExport(TENANT);
    expect(out.subscription).toEqual({ planKey: "GROWTH", flags: [], addons: [] });
  });

  it("non-array addons/flags fail closed to []", async () => {
    const { svc } = build([], []);
    jest.spyOn(svc, "getSubscription").mockResolvedValue({
      planKey: "GROWTH",
      flags: { stripe: "x" },
      addons: { priceSnapshot: 5 },
    } as never);
    const out = await svc.getExport(TENANT);
    expect(out.subscription).toEqual({ planKey: "GROWTH", flags: [], addons: [] });
  });

  it("scopes event and invoice reads by tenantId and excludes internal event types", async () => {
    const { svc, prisma } = build([], []);
    await svc.getExport(TENANT);
    expect(prisma.billingEvent.findMany.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      type: {
        notIn: [
          "tenant.class_changed",
          "reconciliation.snapshot_backfilled",
          "coupon.unbilled",
          "coupon.billed",
        ],
      },
    });
    expect(prisma.rfInvoice.findMany.mock.calls[0][0].where).toEqual({ tenantId: TENANT });
  });
});

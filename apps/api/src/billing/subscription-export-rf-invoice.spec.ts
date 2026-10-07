// PR1 SA722-2 (SA M2 / B1187): the tenant's own billing export must carry ONLY the tenant-facing
// RfInvoice columns. The fake `findMany` honours `select` exactly like Prisma, so a missing or
// widened `select` shows up as an admin-only key somewhere in the serialized export.
import { SubscriptionService } from "./subscription.service";

const TENANT_FACING = [
  "number",
  "amount",
  "currency",
  "status",
  "cycle",
  "issuedAt",
  "dueDate",
  "periodStart",
  "periodEnd",
  "paidAt",
  "lines",
];

const ADMIN_ONLY = [
  "id",
  "tenantId",
  "issuedById",
  "paidMethod",
  "paidRef",
  "paidNote",
  "paidById",
  "lastSentAt",
  "sendCount",
  "voidedAt",
  "voidReason",
  "periodKey",
  "pdfKey",
  "needsReview",
];

const FULL_ROW: Record<string, unknown> = {
  id: "inv-1",
  tenantId: "tenant-acme",
  number: "RF-2026-0001",
  amount: "149.00",
  currency: "USD",
  status: "PAID",
  cycle: "MONTHLY",
  pdfKey: "k/pdf",
  issuedAt: new Date("2026-10-01T00:00:00Z"),
  dueDate: new Date("2026-10-12T00:00:00Z"),
  periodStart: new Date("2026-10-12T00:00:00Z"),
  periodEnd: new Date("2026-11-11T00:00:00Z"),
  periodKey: "2026-10-12T00:00:00.000Z",
  lines: [
    { kind: "PLAN", code: "STARTER", label: "Starter", quantity: 1, unitAmount: 149, amount: 149 },
  ],
  issuedById: "user-admin",
  paidAt: new Date("2026-10-05T00:00:00Z"),
  paidMethod: "ZELLE",
  paidRef: "conf-1",
  paidNote: "internal note",
  paidById: "user-admin",
  lastSentAt: new Date("2026-10-02T00:00:00Z"),
  sendCount: 2,
  voidedAt: null,
  voidReason: null,
  needsReview: true,
};

function deepKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === "object" && !(v instanceof Date)) {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      deepKeys(x, out);
    }
  }
  return out;
}

function make() {
  const prisma: any = {
    billingEvent: { findMany: jest.fn(async () => []) },
    rfInvoice: {
      findMany: jest.fn(async ({ select }: any) =>
        [FULL_ROW].map((row) =>
          select
            ? Object.fromEntries(
                Object.keys(select)
                  .filter((k) => select[k])
                  .map((k) => [k, row[k]]),
              )
            : row,
        ),
      ),
    },
  };
  const svc = new SubscriptionService(prisma, {} as any, {} as any, {} as any);
  jest.spyOn(svc, "getSubscription").mockResolvedValue({ planKey: "STARTER", addons: [] } as any);
  jest.spyOn(svc, "getUsage").mockResolvedValue([] as any);
  return { svc, prisma };
}

describe("SubscriptionService.getExport (RfInvoice columns)", () => {
  it("SA722-2: the RfInvoice read uses an explicit select of exactly the tenant-facing fields", async () => {
    const { svc, prisma } = make();
    await svc.getExport("tenant-acme");
    const { select, where } = prisma.rfInvoice.findMany.mock.calls[0][0];
    expect(where).toEqual({ tenantId: "tenant-acme" });
    expect(Object.keys(select).sort()).toEqual([...TENANT_FACING].sort());
  });

  it("SA722-2: deep scan - no admin-only key at any depth of the export", async () => {
    const { svc } = make();
    const out = await svc.getExport("tenant-acme");
    const keys = deepKeys(out);
    for (const k of ADMIN_ONLY) expect(keys.has(k)).toBe(false);
    for (const k of TENANT_FACING) expect(keys.has(k)).toBe(true);
  });
});

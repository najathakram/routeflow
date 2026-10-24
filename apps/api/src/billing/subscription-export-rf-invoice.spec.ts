// SA722-2 (SA M2 / B1187): the tenant's own billing export carries ONLY allowlisted keys, in BOTH arrays
// (invoices and billingEvents). The fake `findMany` honours `select` exactly like Prisma, and the
// BillingEvent stub is a FULL row, so a widened select or a leaked column shows up in the serialized export.
import { BILLING_EXPORT_INVOICE_FIELDS } from "./billing-export-fields";
import { SubscriptionService } from "./subscription.service";

const ADMIN_ONLY = [
  "id",
  "tenantId",
  "actorId",
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

const FULL_EVENT: Record<string, unknown> = {
  id: "ev-1",
  tenantId: "tenant-acme",
  type: "plan.changed",
  payload: { fromPlan: "A", toPlan: "B", stripeReason: "r", source: "s" },
  amountDelta: 20,
  actorId: "user-admin",
  createdAt: new Date("2026-10-02T00:00:00Z"),
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

function make(row: Record<string, unknown> = FULL_ROW) {
  const prisma: any = {
    billingEvent: { findMany: jest.fn(async () => [FULL_EVENT]) },
    user: {
      findMany: jest.fn(async () => [
        { id: "user-admin", role: "OPERATOR", tenantId: "tenant-acme" },
      ]),
    },
    rfInvoice: {
      findMany: jest.fn(async ({ select }: any) =>
        [row].map((row) =>
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
  it("SA722-2: the RfInvoice select is derived from the ONE allowlist", async () => {
    const { svc, prisma } = make();
    await svc.getExport("tenant-acme");
    const { select, where } = prisma.rfInvoice.findMany.mock.calls[0][0];
    expect(where).toEqual({ tenantId: "tenant-acme" });
    expect(Object.keys(select).sort()).toEqual([...BILLING_EXPORT_INVOICE_FIELDS].sort());
  });

  it("SA722-2: deep scan of BOTH arrays - no admin-only key (incl. actorId) at any depth", async () => {
    const { svc } = make();
    const out = await svc.getExport("tenant-acme");
    expect(out.invoices).toHaveLength(1);
    expect(out.billingEvents).toHaveLength(1);
    expect(out.billingEvents[0].actor).toBe("you");
    const keys = deepKeys(out);
    for (const k of ADMIN_ONLY) expect(keys.has(k)).toBe(false);
    for (const k of BILLING_EXPORT_INVOICE_FIELDS) expect(keys.has(k)).toBe(true);
  });

  it("N2: each line is projected through a LINE-KEY allowlist - an internal key on a line never leaves", async () => {
    const leaky = {
      ...FULL_ROW,
      lines: [
        {
          kind: "ADDON",
          code: "SKU1",
          label: "Add-on",
          quantity: 2,
          unitAmount: 10,
          amount: 20,
          internalNote: "negotiated",
          costBasis: 3.5,
          nested: { priceUnknown: true },
        },
      ],
    };
    const { svc } = make(leaky);
    const out = await svc.getExport("tenant-acme");
    const keys = deepKeys(out);
    for (const k of ["internalNote", "costBasis", "nested", "priceUnknown"]) {
      expect(keys.has(k)).toBe(false);
    }
    expect(out.invoices[0].lines).toEqual([
      { kind: "ADDON", code: "SKU1", label: "Add-on", quantity: 2, unitAmount: 10, amount: 20 },
    ]);
  });

  it("N2: a missing or non-array lines column exports as an empty list", async () => {
    const { svc } = make({ ...FULL_ROW, lines: null });
    expect((await svc.getExport("tenant-acme")).invoices[0].lines).toEqual([]);
  });
});

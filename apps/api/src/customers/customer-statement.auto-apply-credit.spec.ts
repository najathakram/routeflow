import { buildOperatorStatement } from "./customer-statement";

jest.mock("../common/tenant-time-zone", () => ({
  tenantTimeZone: jest.fn().mockResolvedValue("UTC"),
}));
jest.mock("../invoices/credit-exposure", () => ({
  OPEN_ORDER_STATUSES: [],
  loadCreditExposure: jest.fn().mockResolvedValue({ counted: 0, pendingExposure: 0 }),
}));

/**
 * SA-998: the operator statement carries `autoApplyCredit` (the credit the send-time sweep would apply) on the wire,
 * under the same `includeExposure` option as the other operator-only figures; the buyer read never gets the key, and
 * `availableCredit` (the display wallet) is unchanged. The sweep switch is read by the one helper: OFF reads 0.
 */
describe("buildOperatorStatement — autoApplyCredit (SA-998)", () => {
  const note = (amount: number, amountUsed = 0) => ({
    id: `cn-${amount}`,
    amount,
    amountUsed,
    status: "ISSUED",
    expiresAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
  });

  function build(flagOn: boolean, notes: ReturnType<typeof note>[]) {
    const db = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
      },
      // the statement's own wallet reads AND the helper's candidate read both hit creditNote.findMany
      creditNote: { findMany: jest.fn().mockResolvedValue(notes) },
      advancePayment: { findMany: jest.fn().mockResolvedValue([]) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
      invoicePayment: { aggregate: jest.fn().mockResolvedValue({ _sum: {} }) },
      tenantConfig: {
        findUnique: jest.fn().mockResolvedValue({ creditAutoApplyOnSend: flagOn }),
      },
      return: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = { forTenant: () => db, getTenantId: () => "t1" };
    return (opts?: { includeExposure?: boolean }) =>
      buildOperatorStatement(prisma as any, "c1", opts);
  }

  it("flag ON: the key is on the JSON and sums the open remainder", async () => {
    const stmt = await build(true, [note(30), note(20, 5)])({ includeExposure: true });
    expect(JSON.parse(JSON.stringify(stmt))).toMatchObject({
      autoApplyCredit: 45,
      availableCredit: 45,
    });
  });

  it("flag OFF (the default): autoApplyCredit is 0 while availableCredit still shows the wallet", async () => {
    const stmt = await build(false, [note(30)])({ includeExposure: true });
    expect(JSON.parse(JSON.stringify(stmt))).toMatchObject({
      autoApplyCredit: 0,
      availableCredit: 30,
    });
  });

  it("without includeExposure (the buyer read) the key is absent", async () => {
    const stmt = await build(true, [note(30)])();
    expect(Object.keys(stmt)).not.toContain("autoApplyCredit");
  });
});

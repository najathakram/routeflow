/**
 * B1385: the Payments tile's advance balance sums only spendable credit. Red-first on the wrong value the unfixed
 * tile gives: $200 for an advance sourced to a DRAFT group (the statement already reads 0).
 * Mocked at the module boundary: `forTenant()` is the only door to the database.
 */
import { PrismaService } from "../prisma/prisma.service";
import { listAllPayments } from "./payment-list-query";

function tile(advances: any[], sourceStatus: Record<string, string>) {
  const db = {
    invoicePayment: {
      findMany: jest.fn(async ({ where }: any) =>
        where?.id?.in
          ? where.id.in
              .filter((id: string) => sourceStatus[id])
              .map((id: string) => ({ id, status: sourceStatus[id] }))
          : [],
      ),
      findUnique: jest.fn(async () => null),
      count: jest.fn(async () => 0),
    },
    advancePayment: { findMany: jest.fn(async () => advances) },
  };
  const prisma = { forTenant: () => db } as unknown as PrismaService;
  return listAllPayments(
    { prisma, resolveTenantInvoiceDefaults: async () => ({ timezone: "UTC" }) } as any,
    {},
  );
}

describe("Payments tile advanceBalance (B1385)", () => {
  it("excludes a DRAFT group's $200 excess", async () => {
    const res = await tile([{ balance: 200, sourcePaymentId: "pay-d" }], { "pay-d": "DRAFT" });
    expect(res.summary.advanceBalance).toBe(0);
  });

  it("counts a PAID group's excess and an unsourced advance: 200 + 50", async () => {
    const res = await tile(
      [
        { balance: 200, sourcePaymentId: "pay-p" },
        { balance: 50, sourcePaymentId: null },
      ],
      { "pay-p": "PAID" },
    );
    expect(res.summary.advanceBalance).toBe(250);
  });
});

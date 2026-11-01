import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";
import { buildMyStatement, buildOperatorStatement } from "./customer-statement";

/**
 * SA-1048 B243: a statement row's runningBalance is a rounded money figure, like the summary figures beside
 * it. 0.3 owed less 0.1 paid is 0.19999999999999998 in IEEE-754 until roundMoney makes it 0.2.
 */
const CUSTOMER = { id: "cust-1", userId: "user-1", name: "Acme Foods" };

const INVOICE = {
  id: "inv-1",
  invoiceNumber: "INV-1",
  total: 0.3,
  status: "OVERDUE",
  dueDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  payments: [{ amount: 0.1, status: "PAID" }],
};

/** A tenant client whose every model answers with an empty read, except the one invoice and the customer. */
function fakePrisma(): PrismaService {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async () => {
          if (name === "invoice" && method === "findMany") return [INVOICE];
          if (method === "findFirst" || method === "findUnique") return CUSTOMER;
          if (method === "aggregate") return { _sum: {} };
          if (method === "count") return 0;
          return [];
        },
      },
    );
  const tenant = new Proxy({}, { get: (_t, name: string) => model(name) });
  const root = new Proxy(
    { forTenant: () => tenant, getTenantId: () => "tenant-1" } as Record<string, unknown>,
    { get: (t, name: string) => (name in t ? t[name] : model(name)) },
  );
  return root as unknown as PrismaService;
}

const rowOf = (r: { transactions: unknown[] }) =>
  (r.transactions as { id: string; runningBalance: number }[]).find((t) => t.id === "inv-1");

describe("customer statement rows: runningBalance is whole cents (SA-1048 B243)", () => {
  it("the buyer's own statement", async () => {
    const out = await buildMyStatement(fakePrisma(), { sub: "user-1" } as unknown as JwtPayload);
    expect(rowOf(out)?.runningBalance).toBe(-0.2);
  });

  it("the operator's statement for the same customer", async () => {
    const out = await buildOperatorStatement(fakePrisma(), "cust-1");
    expect(rowOf(out)?.runningBalance).toBe(-0.2);
  });
});

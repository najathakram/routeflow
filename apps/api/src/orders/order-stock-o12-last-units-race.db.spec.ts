/**
 * O12 (inventory TEST-PLAN W1b): the last units, oversell off, two buyers racing.
 *
 * Stock 5, no oversell policy (off), buyers A and B each place an order of 4 at the same moment through the REAL
 * `OrdersService.create()`. Correct: exactly one order is created, the other is refused with the generic 409
 * (the out-of-stock copy) and nothing of it is written; the counter ends at 1, never -3, with ONE SALE movement
 * (-4) and the ledger consistent (X1).
 *
 * Existing coverage is only `oversell-policy.db.spec.ts` (two callers of `decrementStockForSale`, a hand-resolved
 * boolean) and a single-caller create in `oversell-policy.orders-service.db.spec.ts`; this drives the whole create
 * path from two principals. A barrier on the first transaction each caller opens releases them together, and the
 * spec asserts that BOTH reached it (entry) before trusting the outcome. The Product row lock then serialises the
 * two decrements; the lock wait is bounded by the winner's one transaction.
 *
 * Linked bug: none open for this row (stock-oversell coverage gap); report line says green/red on master.
 * Test tenant `qa-o12-*` only, spec-owned fixtures.
 */
import { ConflictException } from "@nestjs/common";
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";
import { PolicyService } from "../policy/policy.service";
import { PolicyOversellReader } from "./policy-oversell-reader";

describeDb("O12: last units, oversell off, two buyers", () => {
  let w: OrderStockWorld;
  const buyers: Array<{ jwt: any; customerId: string }> = [];
  let arrivals = 0;
  let release!: () => void;
  const bothIn = new Promise<void>((r) => (release = r));

  beforeAll(async () => {
    w = await buildOrderStockWorld("o12", "order-stock-o12-last-units-race.db.spec.ts");
    // The world's OrdersService is built for staff edits; a buyer create also needs the oversell reader.
    w.orders.oversellReader = new PolicyOversellReader(new PolicyService(w.prisma));
    // Barrier: the first transaction each of the two callers opens waits (<= 1.5 s) for the other to open its own.
    const real = w.orders.prisma;
    w.orders.prisma = new Proxy(real, {
      get(target: any, prop) {
        if (prop === "tenantTransaction") {
          return async (fn: unknown, opts?: unknown) => {
            if (arrivals < 2) {
              arrivals += 1;
              if (arrivals >= 2) release();
              await Promise.race([bothIn, new Promise((r) => setTimeout(r, 1500))]);
            }
            return target.tenantTransaction(fn, opts);
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    for (const n of [1, 2]) {
      const username = `${w.slug}-b${n}`;
      const user = await w.prisma.user.create({
        data: {
          email: `${username}@example.invalid`,
          username,
          role: "CUSTOMER",
          tenantId: w.tenantId,
        },
      });
      const customer = await w.prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `buyer ${n}`,
          contactName: `buyer ${n}`,
          tenantId: w.tenantId,
        },
      });
      buyers.push({
        customerId: customer.id,
        jwt: { ...w.jwt, sub: user.id, username, role: "CUSTOMER" },
      });
    }
  }, 120_000);
  afterAll(async () => {
    await w?.cleanup();
  }, 120_000);

  it("stock 5, buyers A and B each order 4 -> one created, one 409, stock 1 (never -3)", async () => {
    const productId = await w.product("o12", 5);
    const create = (b: (typeof buyers)[number]) =>
      w.inTenant(() =>
        w.orders.create({ items: [{ productId, qty: 4 }] }, b.jwt, { skipAutoMerge: true }),
      );

    const results = await Promise.allSettled([create(buyers[0]), create(buyers[1])]);

    expect(arrivals).toBe(2); // entry: both callers were inside create() together
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect({
      won: won.length,
      lost: lost.length,
      lostIs409: lost.every((r) => r.reason instanceof ConflictException),
      stock: await w.stockOf(productId),
      orderCount: await w.prisma.order.count({ where: { tenantId: w.tenantId } }),
      saleRows: (await w.movements(productId))
        .filter((m) => m.type === "SALE")
        .map((m) => Number(m.quantity)),
    }).toEqual({ won: 1, lost: 1, lostIs409: true, stock: 1, orderCount: 1, saleRows: [-4] });
    await expectLedgerConsistent(w.tenantId, w.productIds);
  }, 60_000);
});

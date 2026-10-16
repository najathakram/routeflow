/**
 * B1241, real Postgres: a customer delete / purge that destroys a customer's LIVE orders must hand
 * the stock those orders booked back to the shelf.
 *
 * Creating an order decrements `Product.currentStock` (and appends a SALE `StockMovement`). The
 * customer hard-delete branches removed the customer's orders and lines with a bare
 * `orderItem.deleteMany` / `order.deleteMany`, so the booked units were never credited: the product
 * under-counted for good, with a ledger that still balanced (the lost units simply had no row).
 * `assertRecordFreeInTx` blocks only invoices and payments, so a customer whose orders were
 * uninvoiced PENDING / CONFIRMED ones was deletable.
 *
 * Two entry points reach the order wipe:
 *   - `deleteAllCustomers` (the whole-tenant purge): reachable with live orders, the real leak;
 *   - `deleteCustomer`'s hard-delete branch: gated behind `hasFinancialRecords` (orders count as
 *     records), so it only holds orders when one is created AFTER the pre-flight counts (the
 *     time-of-check/time-of-use window). The race is simulated by creating the orders from inside
 *     `assertRecordFreeInTx`, the first statement of the transaction.
 *
 * The fix settles stock through the SAME path an order cancel uses (`settleStockForEdit`, notes
 * "DELETE"): Order rows locked first, status read under the lock, then Products, then the deletes.
 * Fences: DRAFT never booked stock, CANCELLED was already credited by its cancel, DELIVERED goods are
 * gone (master behaviour kept), and a customer with no orders deletes exactly as before.
 *
 * Runs only under the DB lane (`*.db.spec.ts`, local database). Tenants are throwaway `qa-b1241-*`
 * slugs approved by `assertTestTenant`; `afterAll` deletes exactly what the run created.
 */
import { randomUUID } from "crypto";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// The race window: orders appear after the pre-flight counts and before the transaction body reads.
let mockRaceHook: (() => Promise<void>) | null = null;
jest.mock("./customer-delete-preflight", () => {
  const actual = jest.requireActual("./customer-delete-preflight");
  return {
    ...actual,
    assertRecordFreeInTx: async (...args: unknown[]) => {
      const hook = mockRaceHook;
      mockRaceHook = null;
      if (hook) await hook();
      return actual.assertRecordFreeInTx(...args);
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("B1241: customer delete / purge returns the stock its live orders booked", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: CustomersService;
  const tenantIds: string[] = [];
  let seq = 0;

  interface World {
    tenantId: string;
    productId: string;
    mk: (label: string) => Promise<string>;
    order: (
      customerId: string,
      status: string,
      qty: number,
      opts?: { deliveredQty?: number; itemStatus?: string },
    ) => Promise<string>;
  }

  /**
   * A tenant with ONE product whose ledger is consistent from the start: +10 PURCHASE, then a −3 SALE per
   * booked order (stock 10 − 3k, newest stockAfter = currentStock).
   */
  async function world(bookedOrders: number): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b1241-${RUN}-${seq}`,
      "customer-delete-returns-stock.db.spec.ts",
    );
    const tenantId = (await prisma.tenant.create({ data: { slug, name: `B1241 ${slug}` } })).id;
    tenantIds.push(tenantId);
    const stock = 10 - 3 * bookedOrders;
    const productId = (
      await prisma.product.create({
        data: {
          name: `Widget ${RUN}-${seq}`,
          unit: "ea",
          pricePerUnit: "1.00",
          currentStock: String(stock),
          tenantId,
        },
      })
    ).id;
    const base = Date.now() - 60_000;
    let running = 10;
    await prisma.stockMovement.create({
      data: {
        productId,
        tenantId,
        type: "PURCHASE",
        quantity: "10",
        stockAfter: "10",
        notes: "seed",
        effectiveAt: new Date(base),
        createdAt: new Date(base),
      },
    });
    for (let i = 0; i < bookedOrders; i++) {
      running -= 3;
      await prisma.stockMovement.create({
        data: {
          productId,
          tenantId,
          type: "SALE",
          quantity: "-3",
          stockAfter: String(running),
          notes: "seed booking",
          effectiveAt: new Date(base + (i + 1) * 1000),
          createdAt: new Date(base + (i + 1) * 1000),
        },
      });
    }
    let n = 0;
    return {
      tenantId,
      productId,
      mk: async (label: string) => {
        n += 1;
        const user = await prisma.user.create({
          data: {
            email: `b1241-${RUN}-${seq}-${n}@example.invalid`,
            username: `b1241-${RUN}-${seq}-${n}`,
            role: "CUSTOMER",
            tenantId,
          },
        });
        return (
          await prisma.customer.create({
            data: {
              userId: user.id,
              businessName: `B1241 ${label}`,
              contactName: "B1241",
              tenantId,
            },
          })
        ).id;
      },
      order: async (customerId, status, qty, opts = {}) => {
        n += 1;
        const o = await prisma.order.create({
          data: {
            customerId,
            tenantId,
            status: status as never,
            orderNumber: `B1241-${RUN}-${seq}-${n}`,
            subtotal: String(qty),
            total: String(qty),
          },
        });
        await prisma.orderItem.create({
          data: {
            orderId: o.id,
            productId,
            tenantId,
            qty,
            deliveredQty: opts.deliveredQty ?? 0,
            unitPrice: 1,
            subtotal: qty,
            ...(opts.itemStatus ? { status: opts.itemStatus as never } : {}),
          },
        });
        return o.id;
      },
    };
  }

  const stockOf = async (productId: string) =>
    Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);
  const deleteMovements = (productId: string) =>
    prisma.stockMovement.findMany({ where: { productId, notes: "DELETE" } });

  /** Local ledger check (the shared helper is not on master): currentStock = Σ movements; newest stockAfter = currentStock. */
  async function expectLedgerConsistent(productId: string) {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const moves = await prisma.stockMovement.findMany({
      where: { productId },
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    const sum = moves.reduce((s, m) => s + Number(m.quantity), 0);
    expect(sum).toBe(Number(product.currentStock));
    expect(Number(moves[0].stockAfter)).toBe(Number(product.currentStock));
  }

  const as = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const stub = {} as never;
    service = new CustomersService(
      prisma,
      { get: () => null } as never,
      stub,
      stub,
      stub,
      { can: async () => false } as never, // EntitlementAuthority
      stub,
      { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) } as never,
      stub,
    );
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await prisma.stockMovement.deleteMany({ where: { tenantId } });
      await prisma.orderItem.deleteMany({ where: { tenantId } });
      await prisma.order.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma?.$disconnect();
  }, 120_000);

  describe("deleteAllCustomers (the purge)", () => {
    it("a PENDING and a CONFIRMED order of 3 each: stock returns 4 -> 10 with two DELETE movements", async () => {
      const w = await world(2);
      const c = await w.mk("purge-live");
      await w.order(c, "PENDING", 3);
      await w.order(c, "CONFIRMED", 3);
      expect(await stockOf(w.productId)).toBe(4);

      await as(w.tenantId, () => service.deleteAllCustomers());

      expect(await prisma.order.count({ where: { tenantId: w.tenantId } })).toBe(0);
      expect(await stockOf(w.productId)).toBe(10);
      const credits = await deleteMovements(w.productId);
      expect(credits.map((m) => Number(m.quantity))).toEqual([3, 3]);
      await expectLedgerConsistent(w.productId);
    });

    it("fences: DRAFT, CANCELLED and DELIVERED orders credit nothing; a customer with no orders deletes as before", async () => {
      const w = await world(0);
      // Stock already reflects what these states mean: a DRAFT never booked, the cancel already credited,
      // the delivered goods are gone. Make the delivered booking real so the ledger balances at 7.
      await prisma.product.update({ where: { id: w.productId }, data: { currentStock: "7" } });
      await prisma.stockMovement.create({
        data: {
          productId: w.productId,
          tenantId: w.tenantId,
          type: "SALE",
          quantity: "-3",
          stockAfter: "7",
          notes: "seed delivered",
        },
      });
      const draft = await w.mk("draft");
      const cancelled = await w.mk("cancelled");
      const delivered = await w.mk("delivered");
      const empty = await w.mk("empty");
      await w.order(draft, "DRAFT", 3);
      await w.order(cancelled, "CANCELLED", 3, { itemStatus: "CANCELLED" });
      await w.order(delivered, "DELIVERED", 3, { deliveredQty: 3 });

      const out = await as(w.tenantId, () => service.deleteAllCustomers());

      expect(out.deleted).toBe(4);
      expect(await prisma.customer.count({ where: { id: empty } })).toBe(0);
      expect(await stockOf(w.productId)).toBe(7);
      expect(await deleteMovements(w.productId)).toHaveLength(0);
      await expectLedgerConsistent(w.productId);
    });
  });

  describe("deleteCustomer (hard-delete branch, orders created after the pre-flight)", () => {
    it("a PENDING and a CONFIRMED order of 3 each: stock returns 4 -> 10 with two DELETE movements", async () => {
      const w = await world(2);
      const c = await w.mk("single-live");
      // The orders already hold their booking (stock 4) but appear only after the pre-flight counted zero.
      mockRaceHook = async () => {
        await w.order(c, "PENDING", 3);
        await w.order(c, "CONFIRMED", 3);
      };

      await as(w.tenantId, () => service.deleteCustomer(c));

      expect(await prisma.customer.count({ where: { id: c } })).toBe(0);
      expect(await prisma.order.count({ where: { tenantId: w.tenantId } })).toBe(0);
      expect(await stockOf(w.productId)).toBe(10);
      const credits = await deleteMovements(w.productId);
      expect(credits.map((m) => Number(m.quantity))).toEqual([3, 3]);
      await expectLedgerConsistent(w.productId);
    });

    it("fence: a customer with no orders hard-deletes with no stock movement", async () => {
      const w = await world(0);
      const c = await w.mk("single-empty");

      await as(w.tenantId, () => service.deleteCustomer(c));

      expect(await prisma.customer.count({ where: { id: c } })).toBe(0);
      expect(await stockOf(w.productId)).toBe(10);
      expect(await deleteMovements(w.productId)).toHaveLength(0);
      await expectLedgerConsistent(w.productId);
    });

    it("fence: a customer WITH orders at pre-flight is refused (409) without force, nothing released or destroyed", async () => {
      const w = await world(1);
      const c = await w.mk("single-refused");
      await w.order(c, "PENDING", 3);

      await expect(as(w.tenantId, () => service.deleteCustomer(c))).rejects.toThrow(
        /financial records/,
      );

      expect(await prisma.order.count({ where: { customerId: c } })).toBe(1);
      expect(await stockOf(w.productId)).toBe(7);
      expect(await deleteMovements(w.productId)).toHaveLength(0);
    });
  });
});

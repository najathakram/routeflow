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
 * An order that commits AFTER the release locked its set is never silently destroyed: the delete is a
 * compare-and-set on the locked ids (409, nothing deleted, stock untouched).
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

// M1: an order that commits AFTER the release has locked its set (a create waiting behind the Product locks).
let mockAfterReleaseHook: (() => Promise<void>) | null = null;
jest.mock("./customer-delete-stock", () => {
  const actual = jest.requireActual("./customer-delete-stock");
  return {
    ...actual,
    releaseLiveOrderStockInTx: async (...args: unknown[]) => {
      const locked = await actual.releaseLiveOrderStockInTx(...args);
      const hook = mockAfterReleaseHook;
      mockAfterReleaseHook = null;
      if (hook) await hook();
      return locked;
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

  interface LineSpec {
    qty: number;
    deliveredQty?: number;
    status?: string;
    boxes?: number;
    pieces?: number;
    unitsPerBox?: number;
    productId?: string;
  }
  interface World {
    tenantId: string;
    productId: string;
    /** Another product whose ledger is consistent from the start: +initial, then one -n SALE per booking. */
    product: (initial: number, bookings: number[]) => Promise<string>;
    mk: (label: string, walkIn?: boolean) => Promise<string>;
    order: (
      customerId: string,
      status: string,
      qty: number,
      opts?: { deliveredQty?: number; itemStatus?: string; productId?: string },
    ) => Promise<string>;
    orderLines: (customerId: string, status: string, lines: LineSpec[]) => Promise<string>;
  }

  /**
   * A tenant with a first product whose ledger is consistent from the start: +initial PURCHASE, then a
   * -n SALE per booking (currentStock = initial - sum, newest stockAfter = currentStock).
   */
  async function world(bookings: number[], initial = 10): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b1241-${RUN}-${seq}`,
      "customer-delete-returns-stock.db.spec.ts",
    );
    const tenantId = (await prisma.tenant.create({ data: { slug, name: `B1241 ${slug}` } })).id;
    tenantIds.push(tenantId);
    let pn = 0;
    const product = async (init: number, books: number[]) => {
      pn += 1;
      const stock = init - books.reduce((a, b) => a + b, 0);
      const productId = (
        await prisma.product.create({
          data: {
            name: `Widget ${RUN}-${seq}-${pn}`,
            unit: "ea",
            pricePerUnit: "1.00",
            currentStock: String(stock),
            tenantId,
          },
        })
      ).id;
      const base = Date.now() - 60_000;
      let running = init;
      await prisma.stockMovement.create({
        data: {
          productId,
          tenantId,
          type: "PURCHASE",
          quantity: String(init),
          stockAfter: String(init),
          notes: "seed",
          effectiveAt: new Date(base),
          createdAt: new Date(base),
        },
      });
      for (let i = 0; i < books.length; i++) {
        running -= books[i];
        await prisma.stockMovement.create({
          data: {
            productId,
            tenantId,
            type: "SALE",
            quantity: String(-books[i]),
            stockAfter: String(running),
            notes: "seed booking",
            effectiveAt: new Date(base + (i + 1) * 1000),
            createdAt: new Date(base + (i + 1) * 1000),
          },
        });
      }
      return productId;
    };
    const productId = await product(initial, bookings);
    let n = 0;
    const orderLines = async (customerId: string, status: string, lines: LineSpec[]) => {
      n += 1;
      const total = lines.reduce((a, l) => a + l.qty, 0);
      const o = await prisma.order.create({
        data: {
          customerId,
          tenantId,
          status: status as never,
          orderNumber: `B1241-${RUN}-${seq}-${n}`,
          subtotal: String(total),
          total: String(total),
        },
      });
      for (const l of lines) {
        await prisma.orderItem.create({
          data: {
            orderId: o.id,
            productId: l.productId ?? productId,
            tenantId,
            qty: l.qty,
            deliveredQty: l.deliveredQty ?? 0,
            unitPrice: 1,
            subtotal: l.qty,
            ...(l.status ? { status: l.status as never } : {}),
            ...(l.boxes != null ? { boxes: l.boxes } : {}),
            ...(l.pieces != null ? { pieces: l.pieces } : {}),
            ...(l.unitsPerBox != null ? { unitsPerBox: l.unitsPerBox } : {}),
          },
        });
      }
      return o.id;
    };
    return {
      tenantId,
      productId,
      product,
      orderLines,
      mk: async (label: string, walkIn = false) => {
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
              ...(walkIn ? { isWalkIn: true } : {}),
            },
          })
        ).id;
      },
      order: (customerId, status, qty, opts = {}) =>
        orderLines(customerId, status, [
          {
            qty,
            deliveredQty: opts.deliveredQty,
            status: opts.itemStatus,
            productId: opts.productId,
          },
        ]),
    };
  }

  const stockOf = async (productId: string) =>
    Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);
  const deleteMovements = (productId: string) =>
    prisma.stockMovement.findMany({ where: { productId, notes: "DELETE" } });

  /** Local ledger check (the shared helper is not on master): currentStock = sum of movements; newest stockAfter = currentStock. */
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
      const w = await world([3, 3]);
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
      const w = await world([]);
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

    it("a PARTIALLY_DELIVERED line credits only the undelivered remainder (3 booked, 2 delivered: +1)", async () => {
      const w = await world([3]);
      const c = await w.mk("partial");
      await w.order(c, "PARTIALLY_DELIVERED", 3, { deliveredQty: 2, itemStatus: "PARTIAL" });

      await as(w.tenantId, () => service.deleteAllCustomers());

      expect(await stockOf(w.productId)).toBe(8);
      expect((await deleteMovements(w.productId)).map((m) => Number(m.quantity))).toEqual([1]);
      await expectLedgerConsistent(w.productId);
    });

    it("a CANCELLED line inside a live order is not credited again (only the active line returns)", async () => {
      const w = await world([3]);
      const c = await w.mk("cancelled-line");
      await w.orderLines(c, "PENDING", [{ qty: 3 }, { qty: 3, status: "CANCELLED" }]);

      await as(w.tenantId, () => service.deleteAllCustomers());

      expect(await stockOf(w.productId)).toBe(10);
      expect((await deleteMovements(w.productId)).map((m) => Number(m.quantity))).toEqual([3]);
      await expectLedgerConsistent(w.productId);
    });

    it("a box-unaware boxed line credits PIECES (2 x pack of 12 = 24)", async () => {
      const w = await world([24], 100);
      const c = await w.mk("boxed");
      await w.orderLines(c, "CONFIRMED", [{ qty: 2, unitsPerBox: 12 }]);
      expect(await stockOf(w.productId)).toBe(76);

      await as(w.tenantId, () => service.deleteAllCustomers());

      expect(await stockOf(w.productId)).toBe(100);
      expect((await deleteMovements(w.productId)).map((m) => Number(m.quantity))).toEqual([24]);
      await expectLedgerConsistent(w.productId);
    });

    it("a box-split line (qty is already pieces: 2 boxes + 6 of 12 = 30) credits 30", async () => {
      const w = await world([30], 100);
      const c = await w.mk("boxed-split");
      await w.orderLines(c, "CONFIRMED", [{ qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 }]);

      await as(w.tenantId, () => service.deleteAllCustomers());

      expect(await stockOf(w.productId)).toBe(100);
      expect((await deleteMovements(w.productId)).map((m) => Number(m.quantity))).toEqual([30]);
      await expectLedgerConsistent(w.productId);
    });

    it("two customers x two products: every product returns exactly what its orders booked", async () => {
      const w = await world([3, 3]); // product 1: orders of 3 (A) and 3 (B)
      const p2 = await w.product(20, [5, 4]); // product 2: orders of 5 (A) and 4 (B)
      const a = await w.mk("multi-a");
      const b = await w.mk("multi-b");
      await w.orderLines(a, "PENDING", [{ qty: 3 }, { qty: 5, productId: p2 }]);
      await w.orderLines(b, "CONFIRMED", [{ qty: 3 }, { qty: 4, productId: p2 }]);
      await w.orderLines(b, "DELIVERED", [{ qty: 2, productId: p2, deliveredQty: 2 }]);

      const out = await as(w.tenantId, () => service.deleteAllCustomers());

      expect(out.deleted).toBe(2);
      expect(await stockOf(w.productId)).toBe(10);
      expect(await stockOf(p2)).toBe(20);
      expect(await deleteMovements(w.productId)).toHaveLength(2);
      expect(await deleteMovements(p2)).toHaveLength(2);
      await expectLedgerConsistent(w.productId);
      await expectLedgerConsistent(p2);
    });

    it("M1: an order committed AFTER the release locked its set -> 409, nothing deleted, stock and ledger untouched", async () => {
      const w = await world([3, 3, 3]); // stock 1: three orders have booked
      const c = await w.mk("purge-late");
      await w.order(c, "PENDING", 3);
      await w.order(c, "CONFIRMED", 3);
      // A create that was waiting behind the Product locks commits its order (with its booked line) for this
      // customer once the release has locked its set. The row is parked on the walk-in (never purged, never
      // locked) and re-pointed at the customer from the hook: a fresh INSERT of the line would itself wait
      // behind the Product locks the delete holds.
      const parked = await w.order(await w.mk("walk-in holder", true), "PENDING", 3);
      mockAfterReleaseHook = async () => {
        await prisma.order.update({ where: { id: parked }, data: { customerId: c } });
      };

      await expect(as(w.tenantId, () => service.deleteAllCustomers())).rejects.toThrow(
        /orders changed while they were being deleted/,
      );

      expect(await prisma.order.count({ where: { customerId: c } })).toBe(3);
      expect(await prisma.customer.count({ where: { id: c } })).toBe(1);
      expect(await stockOf(w.productId)).toBe(1);
      expect(await deleteMovements(w.productId)).toHaveLength(0);
      await expectLedgerConsistent(w.productId);
    });
  });

  describe("deleteCustomer (hard-delete branch, orders created after the pre-flight)", () => {
    it("a PENDING and a CONFIRMED order of 3 each: stock returns 4 -> 10 with two DELETE movements", async () => {
      const w = await world([3, 3]);
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

    it("M1: an order committed AFTER the release locked its set -> 409, nothing deleted, stock and ledger untouched", async () => {
      const w = await world([3, 3, 3]);
      const c = await w.mk("single-late");
      mockRaceHook = async () => {
        await w.order(c, "PENDING", 3);
        await w.order(c, "CONFIRMED", 3);
      };
      const parked = await w.order(await w.mk("walk-in holder", true), "PENDING", 3);
      mockAfterReleaseHook = async () => {
        await prisma.order.update({ where: { id: parked }, data: { customerId: c } });
      };

      await expect(as(w.tenantId, () => service.deleteCustomer(c))).rejects.toThrow(
        /orders changed while they were being deleted/,
      );

      expect(await prisma.order.count({ where: { customerId: c } })).toBe(3);
      expect(await prisma.customer.count({ where: { id: c } })).toBe(1);
      expect(await stockOf(w.productId)).toBe(1);
      expect(await deleteMovements(w.productId)).toHaveLength(0);
      await expectLedgerConsistent(w.productId);
    });

    it("fence: a customer with no orders hard-deletes with no stock movement", async () => {
      const w = await world([]);
      const c = await w.mk("single-empty");

      await as(w.tenantId, () => service.deleteCustomer(c));

      expect(await prisma.customer.count({ where: { id: c } })).toBe(0);
      expect(await stockOf(w.productId)).toBe(10);
      expect(await deleteMovements(w.productId)).toHaveLength(0);
      await expectLedgerConsistent(w.productId);
    });

    it("fence: a customer WITH orders at pre-flight is refused (409) without force, nothing released or destroyed", async () => {
      const w = await world([3]);
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

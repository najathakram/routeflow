/**
 * B1094 — a buyer double submit (two concurrent `POST /buyer/orders`) creates two orders, or folds the
 * same cart in twice.
 *
 * Both halves of `BuyerController.createOrder` were non-idempotent:
 *  - merge branch (the customer has an open DRAFT/PENDING order): the fold writes ABSOLUTE totals from
 *    the snapshot read inside the customer advisory lock, so two submits that SERIALIZE on the lock
 *    still apply the same cart twice (2 + 3 + 3 = 8, not 5);
 *  - create branch (no open order): both submits read "no active order" outside any lock and both
 *    create, leaving two orders (which the sweep then folds into one inflated order).
 * The lock serializes the two submits; it cannot tell a retry from a second cart. A client-minted
 * `Idempotency-Key` (the staff `POST /orders` contract, reused as-is) can.
 *
 * Mock-level interleaving: a stateful fake OrdersService (one "table" of orders + the key index), the
 * advisory lock modelled as a real per-key mutex so the two calls genuinely queue, and `await` ticks in
 * the unlocked read -> create window so both submits read the same pre-state. A true two-connection
 * race through Postgres is the Mac mini's `*.db.spec.ts` lane; the unique-key backstop it relies on
 * (`Order.idempotencyKey`, OrderIdempotencyKey) is already exercised by the staff create specs.
 */
const mutexes = new Map<string, Promise<unknown>>();
jest.mock("../common/db-locks", () => ({
  // mapLockError (orders/merge-contention) tests `instanceof` against these.
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
  // A real mutex per (family, key): the second caller runs only after the first has finished.
  withAdvisoryLock: jest.fn(
    async (opts: { family: string; key: string }, fn: () => Promise<unknown>) => {
      const id = `${opts.family}:${opts.key}`;
      const prev = mutexes.get(id) ?? Promise.resolve();
      const run = prev.then(() => fn());
      mutexes.set(
        id,
        run.catch(() => undefined),
      );
      return { acquired: true, value: await run };
    },
  ),
}));

import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { BuyerController } from "./buyer.controller";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PromotionsService } from "../promotions/promotions.service";
import { OrdersService } from "../orders/orders.service";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";

const CTX = {
  customerId: "cust-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-1", businessName: "Double Submit Buyer" },
};

type Line = { id?: string; productId: string; qty: number; boxes?: null; pieces?: null };
type FakeOrder = { id: string; customerId: string; lineItems: Line[] };

const tick = () => new Promise<void>((r) => setImmediate(r));
const qtyOf = (o: FakeOrder) => o.lineItems.reduce((n, l) => n + Number(l.qty), 0);

describe("B1094 — BuyerController.createOrder double submit", () => {
  let controller: BuyerController;
  let orders: Map<string, FakeOrder>;
  let keys: Map<string, string>; // idempotency key -> order id
  let folds: number;
  let svc: Record<string, jest.Mock>;

  const dto = () => ({ items: [{ productId: "prod-a", qty: 3 }] });

  beforeEach(async () => {
    mutexes.clear();
    orders = new Map();
    keys = new Map();
    folds = 0;
    svc = {
      // The unlocked read of the create flow AND the in-lock re-read: both see the committed state.
      findActiveOrder: jest.fn(async () => {
        await tick();
        return [...orders.values()][0] ?? null;
      }),
      findOrderIdByIdempotencyKey: jest.fn(async (key: string) => {
        const orderId = keys.get(key);
        return orderId ? { orderId, verified: true } : null;
      }),
      replayMergeReconcile: jest.fn(async () => undefined),
      updateOrderItems: jest.fn(
        async (id: string, body: { items: Line[] }, _u: unknown, opts?: any) => {
          await tick();
          folds += 1;
          orders.get(id)!.lineItems = body.items.map((i) => ({ ...i }));
          if (opts?.idempotency) keys.set(opts.idempotency.key, id); // commits with the fold
        },
      ),
      recordIdempotencyKey: jest.fn(async (id: string, key: string) => {
        if (!keys.has(key)) keys.set(key, id);
      }),
      applyBuyerMergeHeader: jest.fn(async () => undefined),
      mergeAllPendingForCustomer: jest.fn(async () => null),
      // Same contract as OrdersService.create: a known key replays the original order, never a second row.
      create: jest.fn(async (body: { items: Line[]; idempotencyKey?: string }) => {
        await tick();
        const replay = body.idempotencyKey ? keys.get(body.idempotencyKey) : undefined;
        if (replay) return orders.get(replay)!;
        const o: FakeOrder = {
          id: `ord-${orders.size + 1}`,
          customerId: CTX.customerId,
          lineItems: body.items.map((i) => ({ ...i })),
        };
        orders.set(o.id, o);
        if (body.idempotencyKey) keys.set(body.idempotencyKey, o.id);
        return o;
      }),
      findOne: jest.fn(async (id: string) => orders.get(id)),
    };
    const prisma = createMockPrisma();
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "prod-a", unitsPerBox: 1 }]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        oversellReaderOffProvider,
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: {} },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: {} },
        { provide: StockAlertService, useValue: {} },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: svc },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: OrderTemplatesService, useValue: {} },
        { provide: AuthorizationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();
    controller = module.get(BuyerController);
  });

  const seedOpenOrder = () =>
    orders.set("ord-open", {
      id: "ord-open",
      customerId: CTX.customerId,
      lineItems: [{ id: "li-1", productId: "prod-a", qty: 2, boxes: null, pieces: null }],
    });

  describe("merge branch (an open order exists)", () => {
    it("two concurrent submits with the SAME key fold the cart once: 2 + 3 = 5, never 8", async () => {
      seedOpenOrder();
      const [a, b] = await Promise.all([
        controller.createOrder(dto() as any, CTX as any, "key-1"),
        controller.createOrder(dto() as any, CTX as any, "key-1"),
      ]);
      expect(qtyOf(orders.get("ord-open")!)).toBe(5);
      expect(folds).toBe(1);
      expect(a).toBe(b); // both callers are answered with the one order
      expect(svc.mergeAllPendingForCustomer).toHaveBeenCalledTimes(1); // the replay does no sweep
    });

    it("the key and the cart fingerprint ride into the fold's own transaction", async () => {
      seedOpenOrder();
      await controller.createOrder(dto() as any, CTX as any, "key-1");
      expect(svc.updateOrderItems).toHaveBeenCalledWith(
        "ord-open",
        expect.objectContaining({ replaceAll: true }),
        expect.any(Object),
        { idempotency: { key: "key-1", responseHash: expect.stringMatching(/^[0-9a-f]{64}$/) } },
      );
    });

    it("two submits with DIFFERENT keys are two real carts: both fold (control)", async () => {
      seedOpenOrder();
      await Promise.all([
        controller.createOrder(dto() as any, CTX as any, "key-1"),
        controller.createOrder(dto() as any, CTX as any, "key-2"),
      ]);
      expect(qtyOf(orders.get("ord-open")!)).toBe(8);
      expect(folds).toBe(2);
    });

    it("no key: unchanged — the fold takes no idempotency argument (control)", async () => {
      seedOpenOrder();
      await controller.createOrder(dto() as any, CTX as any);
      expect(svc.updateOrderItems.mock.calls[0]).toHaveLength(3);
      expect(svc.findOrderIdByIdempotencyKey).not.toHaveBeenCalled();
    });

    it("the same key with a DIFFERENT cart is the service's 409, not a fold", async () => {
      seedOpenOrder();
      svc.findOrderIdByIdempotencyKey.mockRejectedValueOnce(
        new ConflictException("Idempotency-Key reused with a different cart"),
      );
      await expect(
        controller.createOrder(dto() as any, CTX as any, "key-1"),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(folds).toBe(0);
    });
  });

  describe("create branch (no open order)", () => {
    it("two concurrent first submits with the SAME key create ONE order", async () => {
      const [a, b] = await Promise.all([
        controller.createOrder(dto() as any, CTX as any, "key-1"),
        controller.createOrder(dto() as any, CTX as any, "key-1"),
      ]);
      expect(orders.size).toBe(1);
      expect((a as FakeOrder).id).toBe((b as FakeOrder).id);
      expect(svc.create).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "key-1" }),
        expect.any(Object),
      );
    });

    it("no key: the create body carries no idempotencyKey (control)", async () => {
      await controller.createOrder(dto() as any, CTX as any);
      expect(svc.create.mock.calls[0][0]).not.toHaveProperty("idempotencyKey");
    });
  });

  describe("key validation", () => {
    it.each(["has space", "x".repeat(129), "tab\tkey"])(
      "refuses %j with a 400 before any read or write",
      async (bad) => {
        await expect(controller.createOrder(dto() as any, CTX as any, bad)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(svc.findActiveOrder).not.toHaveBeenCalled();
        expect(svc.create).not.toHaveBeenCalled();
      },
    );

    it("a blank key means no key", async () => {
      seedOpenOrder();
      await controller.createOrder(dto() as any, CTX as any, "   ");
      expect(svc.findOrderIdByIdempotencyKey).not.toHaveBeenCalled();
    });
  });
});

import "reflect-metadata";
import { Test } from "@nestjs/testing";
import * as writeDate from "./stock-write-date";
import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { InventoryController } from "./inventory.controller";
import { InventoryMovementsExportService } from "./inventory-movements-export.service";
import { PrismaService } from "../prisma/prisma.service";
import { IdempotencyService } from "../common/idempotency.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { IDEMPOTENCY_KEY_CONFLICT } from "../orders/merge-idempotency";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { wireStockHelper, type StockHelperMock } from "./testing/stock-helper-mock";

/**
 * B1415 M1b (SA-1504 R1-R5): POST /inventory/movements/adjustment replays an Idempotency-Key. The fake idempotency
 * store is stateful and records the call order, so a replay really finds what the first call saved and the lock is
 * proven to come BEFORE the stock write.
 */
// Row 563: the real gate, wrapped so a spec can see when it runs and make it refuse (a filed month).
jest.mock("./stock-write-date", () => {
  const actual = jest.requireActual("./stock-write-date");
  return { ...actual, stockWriteDate: jest.fn(actual.stockWriteDate) };
});
const gate = writeDate.stockWriteDate as jest.Mock;

// SA-767 R6: the lock-wait bound is the tx's FIRST statement, before the key's advisory lock; wrapped to see the order.
let mockOrderSink: string[] = [];
jest.mock("../common/product-locks", () => {
  const actual = jest.requireActual("../common/product-locks");
  return {
    ...actual,
    setStockLockTimeout: jest.fn(async (...a: unknown[]) => {
      mockOrderSink.push("timeout");
      return actual.setStockLockTimeout(...a);
    }),
  };
});

const D = (n: number | string) => new Prisma.Decimal(n);
const body = { productId: "prod-1", quantity: 5, reason: "COUNT_CORRECTION" } as any;

function fakeIdempotency(order: string[]) {
  const store = new Map<string, unknown>();
  const hashFor = (key: string, tenantId: string | null, scope: string) =>
    `${tenantId}:${scope}:${key}`;
  return {
    hashFor,
    forget: (key: string) => {
      for (const k of [...store.keys()]) if (k.endsWith(`:${key}`)) store.delete(k);
    },
    acquireLock: jest.fn(async () => void order.push("lock")),
    check: jest.fn(async (key: string, tenantId: string | null, scope: string) => {
      order.push("check");
      const k = hashFor(key, tenantId, scope);
      return store.has(k) ? store.get(k) : null;
    }),
    save: jest.fn(
      async (key: string, tenantId: string | null, scope: string, response: unknown) => {
        order.push("save");
        store.set(hashFor(key, tenantId, scope), JSON.parse(JSON.stringify(response)));
      },
    ),
  };
}

describe("InventoryService.recordAdjustment: Idempotency-Key (B1415 M1b)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let idem: ReturnType<typeof fakeIdempotency>;
  let stock: StockHelperMock;
  let order: string[];
  let seq: number;
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    order = [];
    mockOrderSink = order;
    seq = 0;
    prisma = createMockPrisma();
    stock = wireStockHelper(prisma);
    idem = fakeIdempotency(order);
    const row = {
      id: "prod-1",
      name: "Widget",
      kind: "STANDARD",
      isActive: true,
      currentStock: D(10),
      averageCost: D(2),
      costingMethod: "AVCO",
      unitsPerBox: null,
    };
    prisma.product.findUnique.mockResolvedValue(row);
    prisma.product.findMany.mockResolvedValue([row]);
    prisma.product.update.mockResolvedValue({ currentStock: D(15) });
    prisma.stockMovement.count.mockResolvedValue(0);
    prisma.stockMovement.findUniqueOrThrow.mockImplementation(async () => ({
      id: `mv-${++seq}`,
      type: "ADJUSTMENT",
      quantity: D(5),
    }));
    const mod = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdempotencyService, useValue: idem },
        { provide: StockAlertService, useValue: { fireForProducts: jest.fn() } },
      ],
    }).compile();
    service = mod.get(InventoryService);
    jest.spyOn(service, "fireStockAlerts").mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    gate.mockReset();
    gate.mockImplementation(jest.requireActual("./stock-write-date").stockWriteDate);
  });

  it("R1: bounds the lock wait, locks the key, checks, gates the date, applies and saves in that order, in the stock tx", async () => {
    const realGate = jest.requireActual("./stock-write-date").stockWriteDate;
    gate.mockImplementation(async (...a: any[]) => {
      order.push("date");
      return realGate(...a);
    });
    const realTx = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any, opts?: any) =>
      realTx(async (tx: any) => {
        const spy = jest.spyOn(tx.stockLot, "create");
        spy.mockImplementation(async (...a: any[]) => {
          order.push("apply");
          return undefined as never;
        });
        return fn(tx);
      }, opts),
    );
    await service.recordAdjustment(body, "user-1", "key-1");
    expect(order).toEqual(["timeout", "lock", "check", "date", "apply", "save"]);
    expect(idem.acquireLock).toHaveBeenCalledWith(
      idem.hashFor("key-1", prisma.getTenantId(), "stock.adjustment"),
      expect.anything(),
    );
    expect(stock.written()).toHaveLength(1);
  });

  it("R3: a replay of the same key and body returns the stored response and applies nothing", async () => {
    const first = await service.recordAdjustment(body, "user-1", "key-1");
    const second = await service.recordAdjustment({ ...body }, "user-1", "key-1");
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
    expect(stock.written()).toHaveLength(1); // applyStockMovements ran once
    expect(prisma.stockLot.create).toHaveBeenCalledTimes(1);
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
  });

  it("R4: the same key with a different body is 409 IDEMPOTENCY_KEY_CONFLICT (ADJUSTMENT_MISMATCH) and writes nothing", async () => {
    await service.recordAdjustment(body, "user-1", "key-1");
    const err = await service
      .recordAdjustment({ ...body, quantity: 6 }, "user-1", "key-1")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: IDEMPOTENCY_KEY_CONFLICT,
      reason: "ADJUSTMENT_MISMATCH",
    });
    expect(stock.written()).toHaveLength(1);
  });

  it("R2: a key longer than 200 characters is a 400 before anything runs", async () => {
    await expect(service.recordAdjustment(body, "user-1", "k".repeat(201))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(idem.acquireLock).not.toHaveBeenCalled();
    expect(stock.written()).toHaveLength(0);
    await service.recordAdjustment(body, "user-1", "k".repeat(200)); // the cap itself is fine
    expect(stock.written()).toHaveLength(1);
  });

  it("R5: no header applies as today and logs a warn line (a blank header counts as none)", async () => {
    await service.recordAdjustment(body, "user-1");
    await service.recordAdjustment(body, "user-1", "   ");
    expect(stock.written()).toHaveLength(2);
    expect(idem.acquireLock).not.toHaveBeenCalled();
    expect(idem.save).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([m]) => /Idempotency-Key/.test(String(m)))).toHaveLength(2);
  });

  it("R3: the date gate runs after the read, so a replay is never refused for its date", async () => {
    await service.recordAdjustment(body, "user-1", "key-1");
    // The month is now filed: a NEW write dated inside it is refused; a replay of the first must still return.
    gate.mockImplementation(async () => {
      order.push("date");
      throw new ConflictException({ code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD });
    });
    order.length = 0;
    const replay = await service.recordAdjustment(body, "user-1", "key-1");
    expect(replay).toBeDefined();
    expect(order).toEqual(["timeout", "lock", "check"]); // the gate never ran
    expect(stock.written()).toHaveLength(1);
    // the same body under a NEW key is a new write: the gate refuses it and nothing is saved
    await expect(service.recordAdjustment(body, "user-1", "key-2")).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD },
    });
    expect(stock.written()).toHaveLength(1);
  });

  it("a 40P01 mid-tx re-runs lock, check and apply: exactly one attempt's movement commits", async () => {
    let attempts = 0;
    let rolledBack = 0;
    const realTx = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any, opts?: any) => {
      attempts += 1;
      const before = stock.written().length;
      const mine = attempts;
      const saveBefore = idem.save.mock.calls.length;
      try {
        return await realTx(async (tx: any) => {
          const out = await fn(tx);
          if (mine === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
          return out;
        }, opts);
      } catch (e) {
        // Postgres rolls the failed attempt back: its movement and its saved key vanish together
        rolledBack += stock.written().length - before;
        for (const [k] of idem.save.mock.calls.slice(saveBefore)) idem.forget(k);
        throw e;
      }
    });
    await service.recordAdjustment(body, "user-1", "key-1");
    expect(attempts).toBe(2);
    expect(idem.acquireLock).toHaveBeenCalledTimes(2);
    expect(rolledBack).toBe(1);
    expect(stock.written().length - rolledBack).toBe(1);
  });
});

describe("InventoryController POST movements/adjustment: the Idempotency-Key header", () => {
  it("passes the header to the service (undefined when absent)", async () => {
    const recordAdjustment = jest.fn().mockResolvedValue({ id: "mv-1" });
    const ctrl = new InventoryController(
      { recordAdjustment } as unknown as InventoryService,
      {} as unknown as InventoryMovementsExportService,
    );
    await ctrl.recordAdjustment(body, { id: "user-1" }, "key-1");
    await ctrl.recordAdjustment(body, { id: "user-1" });
    expect(recordAdjustment).toHaveBeenNthCalledWith(1, body, "user-1", "key-1");
    expect(recordAdjustment).toHaveBeenNthCalledWith(2, body, "user-1", undefined);
    // the header is what is read: `idempotency-key`, third param of the route
    const headerParam = Reflect.getMetadata(
      "__routeArguments__",
      InventoryController,
      "recordAdjustment",
    );
    expect(
      Object.values(headerParam as Record<string, { data?: string }>).map((p) => p.data),
    ).toContain("idempotency-key");
  });
});

/**
 * SA-978a §3 / SA-1089 F04 (W-922): `completeStop` writes its DeliveryMutation rows and must RECOMPUTE
 * `OrderItem.deliveredQty` from them, exactly as `completeWithPayment` and `reopenStop` do. Before this,
 * a stop completed through `completeStop` left the column at 0 while the rows said 6: the invoice read the
 * rows, but stock and cancel-impact read the column, so a later qty cut or cancel read "nothing delivered".
 *
 * The tx is a small stateful fake: `deliveryMutation.create` stores the row, `findMany` serves it back, so the
 * recompute sees what the writer just wrote (the way the real transaction does).
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));
jest.mock("../storage/compress.util", () => ({
  compressImage: jest.fn().mockResolvedValue({
    buffer: Buffer.from("compressed"),
    mimeType: "image/jpeg",
    ext: "jpg",
  }),
}));

const operator = { sub: "user-op", role: "OPERATOR", tenantId: "t1" } as any;

/** Order lines of the fake: id -> { orderId, qty }. */
const LINES: Record<string, { orderId: string; qty: number }> = {
  "oi-1": { orderId: "ord-1", qty: 10 },
  "oi-2": { orderId: "ord-1", qty: 4 },
  "oi-3": { orderId: "ord-2", qty: 8 },
};

describe("RoutesService.completeStop books deliveredQty from the rows it writes (W-922)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let tx: any;
  let rows: Array<Record<string, any>>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitStopCompleted: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitToDriver: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: { sendToDriver: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: InvoicesService,
          useValue: {
            reconcileDeliveredOrdersInTx: jest.fn().mockResolvedValue(undefined),
            recordDeliveryPaymentInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceIds: [], paymentIds: [] }),
            loadUnitCatalog: jest.fn().mockResolvedValue(new Map()),
            loadBaseLabels: jest.fn().mockResolvedValue(new Map()),
            reverseRunAdvancesInTx: jest.fn().mockResolvedValue(0),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
        { provide: StorageService, useValue: {} },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
      ],
    }).compile();
    service = module.get(RoutesService);

    rows = [];
    prisma.routeRun.findUnique.mockResolvedValue({
      id: "run-1",
      driverId: "drv-1",
      status: "IN_PROGRESS",
    });
    prisma.routeRunStop.findFirst.mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      status: "PENDING",
      signatureUrl: null,
      orders: ["ord-1", "ord-2"].map((id) => ({
        id,
        status: "OUT_FOR_DELIVERY",
        customerId: "c1",
        orderNumber: id,
        total: 50,
      })),
    });
    prisma.driver.findFirst.mockResolvedValue(null);
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "stop-1", status: "COMPLETED" });
    const whereIds = (v: any): string[] | null =>
      v == null ? null : typeof v === "string" ? [v] : (v.in ?? null);
    tx = {
      ...prisma,
      routeRunStop: {
        ...prisma.routeRunStop,
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
      },
      routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
      order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderItem: {
        ...prisma.orderItem,
        findFirst: jest.fn(async ({ where }: any) => {
          const l = LINES[where.id];
          return l ? { orderId: l.orderId, productId: "p1", unitPrice: 5, qty: l.qty } : null;
        }),
        findMany: jest.fn(async ({ where }: any = {}) => {
          const ids: string[] | null = whereIds(where?.id);
          const orders: string[] | null = whereIds(where?.orderId);
          return Object.entries(LINES)
            .filter(
              ([id, l]) => (!ids || ids.includes(id)) && (!orders || orders.includes(l.orderId)),
            )
            .map(([id, l]) => ({ id, orderId: l.orderId, qty: l.qty }));
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      deliveryMutation: {
        ...prisma.deliveryMutation,
        create: jest.fn(async ({ data }: any) => {
          rows.push({ ...data });
          return data;
        }),
        findMany: jest.fn(async ({ where }: any = {}) => {
          const orders = whereIds(where?.orderId);
          return rows.filter((r) => !orders || orders.includes(r.orderId));
        }),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));
  });

  const complete = (deliveries: any[]) =>
    service.completeStop("run-1", "stop-1", { deliveries } as any, operator);
  const booked = () =>
    Object.fromEntries(
      (tx.orderItem.update as jest.Mock).mock.calls.map(([a]: any[]) => [
        a.where.id,
        a.data.deliveredQty,
      ]),
    );

  it("RED on the wrong value: a 6-of-10 delivery books 6 (master left the column at 0)", async () => {
    await complete([{ orderItemId: "oi-1", type: "DELIVERED", quantityDelivered: 6 }]);
    expect(booked()).toEqual({ "oi-1": 6 });
  });

  it("a short line next to a full one: each line books its own sum", async () => {
    await complete([
      { orderItemId: "oi-1", type: "PARTIAL", quantityDelivered: 6 },
      { orderItemId: "oi-2", type: "DELIVERED", quantityDelivered: 4 },
    ]);
    expect(booked()).toEqual({ "oi-1": 6, "oi-2": 4 });
  });

  it("a refused line books 0, not its ordered qty", async () => {
    await complete([{ orderItemId: "oi-1", type: "REFUSED", quantityDelivered: 0 }]);
    expect(booked()).toEqual({ "oi-1": 0 });
  });

  it("a stop with two orders recomputes each order's lines", async () => {
    await complete([
      { orderItemId: "oi-1", type: "DELIVERED", quantityDelivered: 10 },
      { orderItemId: "oi-3", type: "PARTIAL", quantityDelivered: 5 },
    ]);
    expect(booked()).toEqual({ "oi-1": 10, "oi-3": 5 });
  });

  it("a line left out of deliveries[] keeps its column (SA-1089: ruled separately)", async () => {
    await complete([{ orderItemId: "oi-1", type: "DELIVERED", quantityDelivered: 6 }]);
    expect(Object.keys(booked())).not.toContain("oi-2");
    expect(Object.keys(booked())).not.toContain("oi-3");
  });

  it("a completion with no deliveries[] writes no deliveredQty", async () => {
    await service.completeStop("run-1", "stop-1", {} as any, operator);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it("the same completion through completeWithPayment books the same figures", async () => {
    await service.completeWithPayment(
      "run-1",
      "stop-1",
      { deliveries: [{ orderItemId: "oi-1", type: "DELIVERED", quantityDelivered: 6 }] } as any,
      operator,
    );
    expect(booked()).toEqual({ "oi-1": 6 });
  });
});

/**
 * SA-978a §3 count pin (OP-7): every `deliveryMutation.create(` in routes/** is followed, in the same method,
 * by `deliveredQtyRecomputeForRows(`. A third writer that skips the recompute is red here.
 */
describe("every DeliveryMutation writer in routes/ recomputes deliveredQty after its rows", () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((n) => n.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(n));

  it("pins each create site to the shared step", () => {
    const offenders: string[] = [];
    let creates = 0;
    for (const name of files) {
      const text = readFileSync(join(dir, name), "utf8");
      // A method boundary: the next line that opens a class method at the class's indent.
      const bounds = [...text.matchAll(/\n {2}(?:private |public |protected )?async \w+\(/g)].map(
        (m) => m.index as number,
      );
      for (const m of text.matchAll(/deliveryMutation\.create\(/g)) {
        creates += 1;
        const at = m.index as number;
        const end = bounds.find((b) => b > at) ?? text.length;
        if (!text.slice(at, end).includes("deliveredQtyRecomputeForRows(")) {
          offenders.push(`${name}@${at}`);
        }
      }
    }
    expect(creates).toBe(2); // completeStop + completeWithPayment; a new writer must be added here on purpose
    expect(offenders).toEqual([]);
  });
});

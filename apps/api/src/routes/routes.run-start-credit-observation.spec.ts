import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
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
jest.mock("../storage/compress.util", () => ({ compressImage: jest.fn() }));

/**
 * B585 — starting a run is OBSERVED for credit, never gated: a run whose customers are over their
 * limit still starts, exactly as before, and the observation logs one warning per over-limit
 * customer (the wiring; the log content is pinned in `run-credit-observation.spec.ts`).
 */
const operator = { sub: "user-op", role: "OPERATOR", tenantId: "t1" } as any;
const RUN = { id: "run-1", driverId: "drv-1", status: "SCHEDULED", startedAt: null as Date | null };
const flush = () => new Promise((r) => setImmediate(r));

describe("RoutesService.updateRunStatus — B585 run-start credit observation", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    prisma = createMockPrisma();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const module = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitDriverStatusUpdated: jest.fn() } },
        { provide: NotificationsService, useValue: {} },
        { provide: MessagingService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StorageService, useValue: {} },
        { provide: FeatureConfigService, useValue: { getEffectiveMode: jest.fn() } },
      ],
    }).compile();
    service = module.get(RoutesService);

    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN });
    prisma.routeRun.update.mockResolvedValue({ ...RUN, status: "IN_PROGRESS", driver: null });
    // one over-limit customer on the run (limit 100, an issued invoice of 150)
    prisma.order.findMany.mockImplementation(async ({ where }: any) =>
      where.routeRunId ? [{ orderNumber: "ORD-1", customerId: "c-1" }] : [],
    );
    prisma.customer.findMany.mockResolvedValue([{ id: "c-1", creditLimit: 100 }]);
    prisma.invoice.findMany.mockResolvedValue([
      { total: 150, status: "SENT", orderId: null, order: null, payments: [] },
    ]);
  });
  afterEach(() => warn.mockRestore());

  const observed = () =>
    warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("observation only"));

  it("an over-limit run STARTS as before (status written, row returned) and one warning is logged", async () => {
    const result = await service.updateRunStatus(
      "run-1",
      { status: "IN_PROGRESS" } as any,
      operator,
    );
    await flush();

    expect(prisma.routeRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "IN_PROGRESS" }) }),
    );
    expect(result).toMatchObject({ status: "IN_PROGRESS" });
    expect(observed()).toHaveLength(1);
    expect(observed()[0]).toContain("customer=c-1");
    expect(observed()[0]).toContain("orders=ORD-1");
  });

  it("a FAILING observation cannot fail or delay the start", async () => {
    prisma.order.findMany.mockRejectedValue(new Error("db down"));
    await expect(
      service.updateRunStatus("run-1", { status: "IN_PROGRESS" } as any, operator),
    ).resolves.toMatchObject({ status: "IN_PROGRESS" });
    await flush();
    expect(observed()).toEqual([expect.stringContaining("observation unavailable")]);
  });

  it("the observation is never AWAITED: the start resolves while its reads are still pending", async () => {
    let release: (rows: unknown[]) => void = () => undefined;
    prisma.order.findMany.mockImplementation(() => new Promise((r) => (release = r)));
    await expect(
      service.updateRunStatus("run-1", { status: "IN_PROGRESS" } as any, operator),
    ).resolves.toMatchObject({ status: "IN_PROGRESS" }); // an `await observeRunCredit(...)` hangs here
    release([]);
    await flush();
  });

  it("observes the FIRST start only: a run already started, and every other transition, log nothing", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({
      ...RUN,
      status: "IN_PROGRESS",
      startedAt: new Date(),
    });
    await service.updateRunStatus("run-1", { status: "IN_PROGRESS" } as any, operator);
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN });
    prisma.routeRun.update.mockResolvedValue({ ...RUN, status: "CANCELLED", driver: null });
    await service
      .updateRunStatus("run-1", { status: "CANCELLED" } as any, operator)
      .catch(() => undefined); // the cancel branch needs a transaction the mock does not provide
    await flush();

    expect(prisma.customer.findMany).not.toHaveBeenCalled();
    expect(observed()).toEqual([]);
  });
});

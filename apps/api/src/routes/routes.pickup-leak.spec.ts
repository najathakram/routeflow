import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { FulfillPath } from "@prisma/client";
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
 * SA-650/SA-655: the three reads that gather "this customer's orders" for a route's load list or a
 * run's legacy no-linked-orders fallback carried no fulfillPath filter, so a customer's PICKUP
 * (counter-sale) order would be printed on the packing list and shown on the run. Each now excludes it.
 */
describe("RoutesService — PICKUP orders never reach a route's load list or a run's fallback", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const notPickup = { not: FulfillPath.PICKUP };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: MessagingService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("k") } },
        { provide: StorageService, useValue: {} },
        { provide: FeatureConfigService, useValue: { getEffectiveMode: jest.fn() } },
      ],
    }).compile();
    service = mod.get(RoutesService);
  });

  const run = (over: Record<string, unknown> = {}) => ({
    id: "run-1",
    routeId: "route-1",
    status: "SCHEDULED",
    route: { id: "route-1", name: "R", kind: "STANDARD" },
    driver: null,
    stops: [
      {
        id: "s1",
        customerId: "c1",
        status: "PENDING",
        stopNumber: 1,
        orders: [],
        customer: { id: "c1", businessName: "Acme Co" },
        customerAddress: { id: "a1" },
        routeStop: null,
      },
    ],
    ...over,
  });

  it("getPackingList (a route's load list) excludes PICKUP orders", async () => {
    prisma.route.findUnique.mockResolvedValue({
      id: "route-1",
      name: "R",
      stops: [{ id: "s1", customerId: "c1", customer: { id: "c1", businessName: "Acme Co" } }],
    });
    await service.getPackingList("route-1");
    expect(prisma.order.findMany.mock.calls[0][0].where).toMatchObject({ fulfillPath: notPickup });
  });

  it("getRunPackingList's no-linked-orders fallback excludes PICKUP orders", async () => {
    prisma.routeRun.findUnique.mockResolvedValue(run());
    await service.getRunPackingList("run-1").catch(() => undefined);
    expect(prisma.order.findMany).toHaveBeenCalled();
    expect(prisma.order.findMany.mock.calls[0][0].where).toMatchObject({ fulfillPath: notPickup });
  });

  it("findOneRun's no-linked-orders fallback excludes PICKUP orders", async () => {
    prisma.routeRun.findUnique.mockResolvedValue(run());
    await service.findOneRun("run-1", { role: "OPERATOR", sub: "u" }).catch(() => undefined);
    const calls = prisma.order.findMany.mock.calls.map((c) => c[0].where);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((w) => w.fulfillPath?.not === FulfillPath.PICKUP)).toBe(true);
  });
});

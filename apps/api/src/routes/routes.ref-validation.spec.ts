import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RouteKind } from "@prisma/client";
import { RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

// Ids that arrive on route / run writes (driver, customer, customer address) must resolve inside
// the caller's tenant, and an address must belong to the customer it is stored beside. The mock
// below makes an id "resolve" only when the spec says so — an id it is not told about is, by
// construction, one the tenant-scoped lookup would not find.

const ROUTE = {
  id: "route-1",
  name: "R",
  kind: RouteKind.SCHEDULED,
  driverId: null,
  isActive: true,
};

const NOT_FOUND = (code: string) =>
  expect.objectContaining({ response: expect.objectContaining({ code, statusCode: 404 }) });

describe("RoutesService — driver / customer / address references are tenant-scoped", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.route.findUnique.mockResolvedValue(ROUTE);
    prisma.route.findFirst.mockResolvedValue(ROUTE);
    prisma.customer.findFirst.mockResolvedValue({ deletedAt: null });
    prisma.routeStop.findFirst.mockResolvedValue({ stopNumber: 1 });
    prisma.routeStop.create.mockResolvedValue({ id: "stop-new" });
    // The tenant knows driver "drv-own" only.
    prisma.driver.findFirst.mockImplementation(async (args: any) =>
      args?.where?.id === "drv-own" ? { id: "drv-own" } : null,
    );

    const module = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitToDriver: jest.fn() } },
        { provide: NotificationsService, useValue: { sendToDriver: jest.fn() } },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: InvoicesService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("k") } },
        { provide: StorageService, useValue: {} },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
      ],
    }).compile();
    service = module.get(RoutesService);
  });

  describe("addStop", () => {
    it("looks the customer up with a tenant-scoped findFirst, not a bare unique read", async () => {
      await service.addStop("route-1", { customerId: "cust-1" } as any);
      expect(prisma.customer.findFirst).toHaveBeenCalledWith({
        where: { id: "cust-1" },
        select: { deletedAt: true },
      });
      expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    });

    it("refuses an address that does not resolve in the tenant (coded 404), writing nothing", async () => {
      prisma.customerAddress.findMany.mockResolvedValue([]);
      await expect(
        service.addStop("route-1", { customerId: "cust-1", customerAddressId: "addr-x" } as any),
      ).rejects.toEqual(NOT_FOUND("CUSTOMER_ADDRESS_NOT_FOUND"));
      expect(prisma.routeStop.create).not.toHaveBeenCalled();
    });

    it("refuses an address that belongs to a different customer (coded 404)", async () => {
      prisma.customerAddress.findMany.mockResolvedValue([{ id: "addr-1", customerId: "cust-2" }]);
      await expect(
        service.addStop("route-1", { customerId: "cust-1", customerAddressId: "addr-1" } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.routeStop.create).not.toHaveBeenCalled();
    });

    it("accepts the customer's own address", async () => {
      prisma.customerAddress.findMany.mockResolvedValue([{ id: "addr-1", customerId: "cust-1" }]);
      await service.addStop("route-1", {
        customerId: "cust-1",
        customerAddressId: "addr-1",
      } as any);
      expect(prisma.routeStop.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ customerId: "cust-1", customerAddressId: "addr-1" }),
      });
    });
  });

  describe("driverId on route / run writes", () => {
    it("createRoute refuses a driver the tenant does not have", async () => {
      await expect(
        service.createRoute({ name: "R", driverId: "drv-foreign" } as any),
      ).rejects.toEqual(NOT_FOUND("DRIVER_NOT_FOUND"));
      expect(prisma.route.create).not.toHaveBeenCalled();
    });

    it("createRoute accepts the tenant's own driver", async () => {
      await service.createRoute({ name: "R", driverId: "drv-own" } as any);
      expect(prisma.route.create).toHaveBeenCalled();
    });

    it("updateRoute refuses a driver the tenant does not have", async () => {
      await expect(
        service.updateRoute("route-1", { driverId: "drv-foreign" } as any),
      ).rejects.toEqual(NOT_FOUND("DRIVER_NOT_FOUND"));
      expect(prisma.route.update).not.toHaveBeenCalled();
    });

    it("updateRun refuses a driver the tenant does not have", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ id: "run-1", driverId: null });
      await expect(
        service.updateRun("run-1", { driverId: "drv-foreign" }, {
          role: "OPERATOR",
          sub: "u",
        } as any),
      ).rejects.toEqual(NOT_FOUND("DRIVER_NOT_FOUND"));
      expect(prisma.routeRun.update).not.toHaveBeenCalled();
    });

    it("createRun refuses a driver the tenant does not have, before any write", async () => {
      prisma.route.findUnique.mockResolvedValue({ ...ROUTE, stops: [] });
      await expect(
        service.createRun(
          { routeId: "route-1", scheduledDate: "2026-10-05", driverId: "drv-foreign" } as any,
          { role: "OPERATOR", sub: "u" } as any,
        ),
      ).rejects.toEqual(NOT_FOUND("DRIVER_NOT_FOUND"));
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });
  });

  describe("createRun copies stop references onto the run", () => {
    const withStops = (stops: any[]) =>
      prisma.route.findUnique.mockResolvedValue({ ...ROUTE, stops });
    const call = () =>
      service.createRun(
        { routeId: "route-1", scheduledDate: "2026-10-05" } as any,
        {
          role: "OPERATOR",
          sub: "u",
        } as any,
      );

    it("refuses a stop whose customer does not resolve in the tenant", async () => {
      withStops([{ id: "rs-1", stopNumber: 1, customerId: "c-foreign", customerAddressId: null }]);
      prisma.customer.findMany.mockResolvedValue([]);
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    it("refuses a stop whose address belongs to another customer (coded 404)", async () => {
      withStops([{ id: "rs-1", stopNumber: 1, customerId: "c1", customerAddressId: "a-other" }]);
      prisma.customer.findMany.mockResolvedValue([{ id: "c1" }]);
      prisma.customerAddress.findMany.mockResolvedValue([{ id: "a-other", customerId: "c2" }]);
      await expect(call()).rejects.toEqual(NOT_FOUND("CUSTOMER_ADDRESS_NOT_FOUND"));
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });
  });
});

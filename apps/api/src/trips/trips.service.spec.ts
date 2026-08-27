import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FulfillPath, OrderStatus, RouteKind } from "@prisma/client";
import { groupOrdersForTrip } from "@routeflow/types";
import { TripsService, TripIneligibleOrder } from "./trips.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { geocodeAddress } from "../common/geocode.util";
import { TripOriginType } from "./dto/create-trip.dto";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));

const tenantId = "tenant-1";

function makeAddress(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "addr-1",
    customerId: "cust-1",
    isDefault: false,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "order-1",
    orderNumber: "ORD-1",
    customerId: "cust-1",
    status: OrderStatus.PENDING,
    fulfillPath: FulfillPath.ROUTE,
    routeRunStopId: null,
    routeRunStop: null,
    customer: {
      id: "cust-1",
      businessName: "Acme Co",
      addresses: [makeAddress()],
    },
    ...overrides,
  } as any;
}

describe("TripsService", () => {
  let service: TripsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let systemConfig: jest.Mocked<Pick<SystemConfigService, "get" | "set">>;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    systemConfig = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };

    const mod = await Test.createTestingModule({
      providers: [
        TripsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
        { provide: SystemConfigService, useValue: systemConfig },
      ],
    }).compile();
    service = mod.get(TripsService);
  });

  // ─── Eligibility predicate agreement ──────────────────────────────────────

  describe("eligibility reasons", () => {
    const eligibleA1 = makeOrder({
      id: "order-a1",
      orderNumber: "ORD-A1",
      customerId: "cust-a",
      customer: {
        id: "cust-a",
        businessName: "Customer A",
        addresses: [
          makeAddress({ id: "addr-a-old", isDefault: false, createdAt: new Date("2024-01-01") }),
          makeAddress({ id: "addr-a-default", isDefault: true, createdAt: new Date("2024-02-01") }),
          makeAddress({ id: "addr-a-new", isDefault: false, createdAt: new Date("2024-03-01") }),
        ],
      },
    });
    const eligibleA2 = makeOrder({
      id: "order-a2",
      orderNumber: "ORD-A2",
      customerId: "cust-a",
      customer: eligibleA1.customer,
    });
    const eligibleB = makeOrder({
      id: "order-b",
      orderNumber: "ORD-B",
      customerId: "cust-b",
      customer: {
        id: "cust-b",
        businessName: "Customer B",
        addresses: [
          makeAddress({ id: "addr-b", isDefault: true, createdAt: new Date("2024-01-01") }),
        ],
      },
    });
    const shipOrder = makeOrder({
      id: "order-ship",
      customerId: "cust-c",
      fulfillPath: FulfillPath.SHIP,
    });
    const draftOrder = makeOrder({
      id: "order-draft",
      customerId: "cust-d",
      status: OrderStatus.DRAFT,
    });
    const activeRunOrder = makeOrder({
      id: "order-active",
      customerId: "cust-e",
      routeRunStopId: "rrs-active",
      routeRunStop: {
        routeRun: { status: "SCHEDULED", driver: { contactName: "Jamie Doe" } },
      },
    });
    const staleRunOrder = makeOrder({
      id: "order-stale",
      customerId: "cust-f",
      routeRunStopId: "rrs-stale",
      routeRunStop: {
        routeRun: { status: "COMPLETED", driver: null },
      },
    });
    const noAddressOrder = makeOrder({
      id: "order-noaddr",
      customerId: "cust-g",
      customer: { id: "cust-g", businessName: "Customer G", addresses: [] },
    });
    const unknownOrderId = "order-ghost";

    const ALL_LOADED = [
      eligibleA1,
      eligibleA2,
      eligibleB,
      shipOrder,
      draftOrder,
      activeRunOrder,
      staleRunOrder,
      noAddressOrder,
    ];
    const ALL_IDS = [...ALL_LOADED.map((o) => o.id), unknownOrderId];

    it("GET eligibility surfaces the right reason for every ineligible order", async () => {
      prisma.order.findMany.mockResolvedValue(ALL_LOADED);

      const rows = await service.getEligibility(tenantId, ALL_IDS);
      const byId = new Map(rows.map((r) => [r.orderId, r]));

      expect(byId.get(eligibleA1.id)?.eligible).toBe(true);
      expect(byId.get(eligibleB.id)?.eligible).toBe(true);
      expect(byId.get(shipOrder.id)).toMatchObject({ eligible: false, reason: "SHIP_FULFILLMENT" });
      expect(byId.get(draftOrder.id)).toMatchObject({
        eligible: false,
        reason: "INELIGIBLE_STATUS",
      });
      expect(byId.get(activeRunOrder.id)).toMatchObject({
        eligible: false,
        reason: "ON_ACTIVE_RUN",
      });
      expect(byId.get(activeRunOrder.id)?.detail).toContain("Jamie Doe");
      expect(byId.get(staleRunOrder.id)).toMatchObject({
        eligible: false,
        reason: "PREVIOUSLY_DISPATCHED",
      });
      expect(byId.get(noAddressOrder.id)).toMatchObject({ eligible: false, reason: "NO_ADDRESS" });
      expect(byId.get(unknownOrderId)).toMatchObject({ eligible: false, reason: "NOT_FOUND" });
    });

    it("POST /trips (409) surfaces the same reasons GET eligibility does, for the same fixture set", async () => {
      prisma.order.findMany.mockResolvedValue(ALL_LOADED);
      const rows = await service.getEligibility(tenantId, ALL_IDS);
      const ineligibleFromGet = rows.filter((r) => !r.eligible);

      prisma.order.findMany.mockResolvedValue(ALL_LOADED);
      let thrown: ConflictException | undefined;
      try {
        await service.createTrip(tenantId, {
          orderIds: ALL_IDS,
          origin: { type: TripOriginType.TENANT } as any,
        });
      } catch (err) {
        thrown = err as ConflictException;
      }

      expect(thrown).toBeInstanceOf(ConflictException);
      const ineligibleFromPost = (thrown!.getResponse() as { ineligible: TripIneligibleOrder[] })
        .ineligible;

      expect(ineligibleFromPost).toHaveLength(ineligibleFromGet.length);
      for (const row of ineligibleFromGet) {
        const match = ineligibleFromPost.find((i) => i.orderId === row.orderId);
        expect(match?.reason).toBe(row.reason);
      }
      // Never writes an order — a 409 (or any) trip creation attempt touches
      // nothing on Order.
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.route.create).not.toHaveBeenCalled();
    });

    it("groups the eligible orders into one stop per distinct customer, matching groupOrdersForTrip directly", async () => {
      prisma.order.findMany.mockResolvedValue([eligibleA1, eligibleA2, eligibleB]);
      (geocodeAddress as jest.Mock).mockResolvedValue({ lat: 30.0, lng: -97.0 });

      await service.createTrip(tenantId, {
        orderIds: [eligibleA1.id, eligibleA2.id, eligibleB.id],
        origin: {
          type: TripOriginType.ADDRESS,
          line1: "1 Main St",
          city: "Austin",
          state: "TX",
          zip: "78701",
        } as any,
      });

      const expected = groupOrdersForTrip([
        {
          id: eligibleA1.id,
          orderNumber: eligibleA1.orderNumber,
          customerId: eligibleA1.customerId,
          customerName: "Customer A",
        },
        {
          id: eligibleA2.id,
          orderNumber: eligibleA2.orderNumber,
          customerId: eligibleA2.customerId,
          customerName: "Customer A",
        },
        {
          id: eligibleB.id,
          orderNumber: eligibleB.orderNumber,
          customerId: eligibleB.customerId,
          customerName: "Customer B",
        },
      ]);

      const createCall = prisma.route.create.mock.calls[0][0];
      const stopsCreated = createCall.data.stops.create;
      expect(stopsCreated).toHaveLength(expected.groups.length);
      expect(stopsCreated.map((s: any) => s.customerId)).toEqual(
        expected.groups.map((g) => g.customerId),
      );
      // Customer A's stop picks the isDefault:true address, ignoring createdAt order.
      const stopA = stopsCreated.find((s: any) => s.customerId === "cust-a");
      expect(stopA.customerAddressId).toBe("addr-a-default");
      const stopB = stopsCreated.find((s: any) => s.customerId === "cust-b");
      expect(stopB.customerAddressId).toBe("addr-b");
      expect(createCall.data.kind).toBe(RouteKind.ADHOC);
    });
  });

  // ─── Assigned driver tenancy ───────────────────────────────────────────────

  describe("assigned driver", () => {
    const eligibleOrder = makeOrder({ id: "order-drv-assign" });

    it("404s (and never creates the route) when dto.driverId belongs to another tenant", async () => {
      prisma.order.findMany.mockResolvedValue([eligibleOrder]);
      // Tenant-scoped lookup misses — the driver exists, just not here.
      prisma.driver.findFirst.mockResolvedValue(null);

      await expect(
        service.createTrip(tenantId, {
          orderIds: [eligibleOrder.id],
          driverId: "drv-other-tenant",
          origin: { type: TripOriginType.TENANT } as any,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.driver.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "drv-other-tenant", tenantId } }),
      );
      expect(prisma.route.create).not.toHaveBeenCalled();
    });

    it("assigns the driver when it belongs to this tenant", async () => {
      prisma.order.findMany.mockResolvedValue([eligibleOrder]);
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-mine" });
      systemConfig.get.mockImplementation(async (key: string) =>
        key === "route.defaultDepotLat" ? "30.5" : key === "route.defaultDepotLng" ? "-97.6" : null,
      );

      await service.createTrip(tenantId, {
        orderIds: [eligibleOrder.id],
        driverId: "drv-mine",
        origin: { type: TripOriginType.TENANT } as any,
      });

      expect(prisma.route.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ driverId: "drv-mine" }) }),
      );
    });
  });

  // ─── resolveOrigin ─────────────────────────────────────────────────────────

  describe("resolveOrigin — ADDRESS", () => {
    const eligibleOrder = makeOrder({ id: "order-addr-ok" });

    it("on success, creates the route with the geocoded depot + ADHOC kind", async () => {
      prisma.order.findMany.mockResolvedValue([eligibleOrder]);
      (geocodeAddress as jest.Mock).mockResolvedValue({ lat: 30.27, lng: -97.74 });

      await service.createTrip(tenantId, {
        orderIds: [eligibleOrder.id],
        origin: {
          type: TripOriginType.ADDRESS,
          line1: "1 Nowhere Rd",
          city: "Austin",
          state: "TX",
          zip: "78701",
        } as any,
      });

      expect(prisma.route.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: RouteKind.ADHOC,
            depotLat: 30.27,
            depotLng: -97.74,
            depotAddress: "1 Nowhere Rd, Austin, TX, 78701",
          }),
        }),
      );
    });

    it("hard-stops with 400 when geocoding fails, and never creates the route", async () => {
      (geocodeAddress as jest.Mock).mockResolvedValue(null);
      prisma.order.findMany.mockResolvedValue([eligibleOrder]);

      await expect(
        service.createTrip(tenantId, {
          orderIds: [eligibleOrder.id],
          origin: {
            type: TripOriginType.ADDRESS,
            line1: "1 Nowhere Rd",
            city: "Austin",
            state: "TX",
            zip: "78701",
          } as any,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.route.create).not.toHaveBeenCalled();
    });
  });

  describe("resolveOrigin — DRIVER", () => {
    const eligibleOrder = makeOrder({ id: "order-drv-ok" });

    it("400s naming the driver when the driver has no home base set", async () => {
      prisma.order.findMany.mockResolvedValue([eligibleOrder]);
      prisma.driver.findFirst.mockResolvedValue({
        id: "drv-1",
        contactName: "Sam Rivera",
        homeLat: null,
        homeLng: null,
        homeAddress: null,
      });

      await expect(
        service.createTrip(tenantId, {
          orderIds: [eligibleOrder.id],
          origin: { type: TripOriginType.DRIVER, driverId: "drv-1" } as any,
        }),
      ).rejects.toThrow(/Sam Rivera/);
      expect(prisma.route.create).not.toHaveBeenCalled();
    });

    it("404s when the driver does not exist", async () => {
      prisma.order.findMany.mockResolvedValue([eligibleOrder]);
      prisma.driver.findFirst.mockResolvedValue(null);

      await expect(
        service.createTrip(tenantId, {
          orderIds: [eligibleOrder.id],
          origin: { type: TripOriginType.DRIVER, driverId: "drv-missing" } as any,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("succeeds using the driver's home base coords", async () => {
      prisma.order.findMany.mockResolvedValue([eligibleOrder]);
      prisma.driver.findFirst.mockResolvedValue({
        id: "drv-2",
        contactName: "Pat Lee",
        homeLat: 30.1,
        homeLng: -97.5,
        homeAddress: "42 Home Way",
      });

      await service.createTrip(tenantId, {
        orderIds: [eligibleOrder.id],
        origin: { type: TripOriginType.DRIVER, driverId: "drv-2" } as any,
      });

      expect(prisma.route.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            depotLat: 30.1,
            depotLng: -97.5,
            depotAddress: "42 Home Way",
          }),
        }),
      );
    });
  });

  describe("resolveOrigin — TENANT", () => {
    const eligibleOrder = makeOrder({ id: "order-tenant-ok" });

    it("uses the SystemConfig-cached depot when present (tier 2)", async () => {
      prisma.order.findMany.mockResolvedValue([eligibleOrder]);
      systemConfig.get.mockImplementation(async (key: string) =>
        key === "route.defaultDepotLat" ? "30.5" : key === "route.defaultDepotLng" ? "-97.6" : null,
      );

      await service.createTrip(tenantId, {
        orderIds: [eligibleOrder.id],
        origin: { type: TripOriginType.TENANT } as any,
      });

      expect(prisma.route.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ depotLat: 30.5, depotLng: -97.6 }),
        }),
      );
    });

    it("400s when no tenant depot is configured at all", async () => {
      prisma.order.findMany.mockResolvedValue([eligibleOrder]);
      prisma.tenantConfig.findFirst.mockResolvedValue(null);

      await expect(
        service.createTrip(tenantId, {
          orderIds: [eligibleOrder.id],
          origin: { type: TripOriginType.TENANT } as any,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.route.create).not.toHaveBeenCalled();
    });
  });

  // ─── GET /trips/eligible-orders ─────────────────────────────────────────────

  describe("getEligibleOrders", () => {
    function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        ...makeOrder(overrides),
        total: 125.5,
        requestedDeliveryDate: new Date("2026-09-01T00:00:00Z"),
        _count: { lineItems: 3 },
        ...overrides,
      };
    }

    it("maps eligible rows to the picker shape and filters out anything checkEligibility rejects — even if the DB where clause let it through", async () => {
      // Mirrors the service's rationale: the SQL `where` can't cheaply express
      // NO_ADDRESS, so a no-address order is included here (as the DB might
      // return it) to prove the app-level checkEligibility() pass still
      // strips it before it reaches the response.
      const eligible = makeRow({
        id: "order-pick-1",
        orderNumber: "ORD-P1",
        customerId: "cust-p1",
        total: 200,
        _count: { lineItems: 2 },
      });
      const noAddress = makeRow({
        id: "order-pick-noaddr",
        customerId: "cust-p2",
        customer: { id: "cust-p2", businessName: "No Address Co", addresses: [] },
      });
      prisma.order.findMany.mockResolvedValue([eligible, noAddress]);
      prisma.order.count.mockResolvedValue(2);

      const result = await service.getEligibleOrders(tenantId, {});

      expect(result.data).toEqual([
        {
          orderId: "order-pick-1",
          orderNumber: "ORD-P1",
          customerId: "cust-p1",
          customerName: "Acme Co",
          total: 200,
          itemCount: 2,
          deliveryDate: eligible.requestedDeliveryDate,
          eligible: true,
        },
      ]);
      // meta.total reflects the (unfiltered) DB count, not the post-filter length —
      // an accepted imperfection documented on the service method.
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    });

    it("excludes SHIP-fulfillment orders via the where clause", async () => {
      prisma.order.findMany.mockResolvedValue([]);

      await service.getEligibleOrders(tenantId, {});

      const where = prisma.order.findMany.mock.calls[0][0].where;
      expect(where.fulfillPath).toEqual({ not: FulfillPath.SHIP });
      expect(where.status).toEqual({
        in: [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.PARTIALLY_DELIVERED],
      });
    });

    // checkEligibility rejects EVERY row with a non-null routeRunStopId (active
    // run or stale link alike), so the DB filter is a plain equality — not an OR
    // that also admits stale-run rows just to have checkEligibility filter them
    // back out in-memory (that wasted page slots and inflated meta.total).
    it("filters routeRunStopId: null at the DB rather than OR-ing in stale-run rows", async () => {
      prisma.order.findMany.mockResolvedValue([]);

      await service.getEligibleOrders(tenantId, {});

      const where = prisma.order.findMany.mock.calls[0][0].where;
      expect(where.routeRunStopId).toBeNull();
      expect(where.OR).toBeUndefined();
    });

    it("passes `exclude` through as an id notIn filter", async () => {
      prisma.order.findMany.mockResolvedValue([]);

      await service.getEligibleOrders(tenantId, { exclude: ["order-a", "order-b"] } as any);

      const where = prisma.order.findMany.mock.calls[0][0].where;
      expect(where.id).toEqual({ notIn: ["order-a", "order-b"] });
    });

    it("omits the id filter entirely when exclude is absent/empty", async () => {
      prisma.order.findMany.mockResolvedValue([]);

      await service.getEligibleOrders(tenantId, {});

      const where = prisma.order.findMany.mock.calls[0][0].where;
      expect(where.id).toBeUndefined();
    });

    it("search filters on orderNumber OR customer.businessName, case-insensitive", async () => {
      prisma.order.findMany.mockResolvedValue([]);

      await service.getEligibleOrders(tenantId, { search: "acme" } as any);

      const where = prisma.order.findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual([
        {
          OR: [
            { orderNumber: { contains: "acme", mode: "insensitive" } },
            { customer: { businessName: { contains: "acme", mode: "insensitive" } } },
          ],
        },
      ]);
    });

    it("paginates with the requested page/limit and orders newest first", async () => {
      prisma.order.findMany.mockResolvedValue([]);

      await service.getEligibleOrders(tenantId, { page: 3, limit: 10 } as any);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10, orderBy: { createdAt: "desc" } }),
      );
    });
  });
});

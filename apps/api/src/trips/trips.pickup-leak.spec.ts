import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { TripsService } from "./trips.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));

/**
 * SA-650/SA-655: a PICKUP (counter sale) order is handed over at the till and must never be taken
 * for a ROUTE order — it can never be put on a trip, and is never offered as trip-eligible.
 */
const tenantId = "tenant-1";
const addr = { id: "a1", customerId: "c1", isDefault: true, createdAt: new Date("2024-01-01") };
const order = (over: Record<string, unknown> = {}) =>
  ({
    id: "o1",
    orderNumber: "ORD-1",
    customerId: "c1",
    status: OrderStatus.PENDING,
    fulfillPath: FulfillPath.ROUTE,
    routeRunStopId: null,
    routeRunStop: null,
    total: 10,
    _count: { lineItems: 1 },
    customer: { id: "c1", businessName: "Acme Co", addresses: [addr] },
    ...over,
  }) as any;

describe("TripsService — PICKUP orders are not routable", () => {
  let service: TripsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        TripsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("k") } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
      ],
    }).compile();
    service = mod.get(TripsService);
  });

  it("checkEligibility (GET /trips/eligibility): a PICKUP order is PICKUP_FULFILLMENT, a ROUTE order is still eligible", async () => {
    prisma.order.findMany.mockResolvedValue([
      order({ id: "pick", fulfillPath: FulfillPath.PICKUP }),
      order({ id: "route" }),
    ]);
    const rows = await service.getEligibility(tenantId, ["pick", "route"]);
    const byId = new Map(rows.map((r) => [r.orderId, r]));
    expect(byId.get("pick")).toMatchObject({ eligible: false, reason: "PICKUP_FULFILLMENT" });
    expect(byId.get("route")?.eligible).toBe(true);
  });

  it("getEligibleOrders: the DB filter excludes SHIP and PICKUP, and a PICKUP row that slips through is dropped", async () => {
    prisma.order.findMany.mockResolvedValue([
      order({ id: "pick", fulfillPath: FulfillPath.PICKUP }),
      order({ id: "route" }),
    ]);
    prisma.order.count.mockResolvedValue(1);
    const result: any = await service.getEligibleOrders(tenantId, { page: 1, limit: 20 } as never);
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.fulfillPath).toEqual({ notIn: [FulfillPath.SHIP, FulfillPath.PICKUP] });
    const ids = result.data.map((o: any) => o.orderId);
    expect(ids).toEqual(["route"]);
  });
});

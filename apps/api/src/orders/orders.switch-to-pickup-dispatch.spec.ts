import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { RoutesService } from "../routes/routes.service";
import { TripsService } from "../trips/trips.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressImage: jest.fn() }));

/**
 * SA-763r P-1a binding [N], row 2: an order switched to PICKUP never loads on a route and is never
 * offered to a trip. The mock readers here evaluate the `where` they are handed against ONE in-memory
 * order table (the same table the real `updateFulfillPath` writes), so the assertion is on which rows
 * the reader actually returns after the switch, not on the shape of a payload. An unknown `where` key
 * throws, so a reader that grows a filter this evaluator cannot read fails loudly instead of passing.
 */
type Row = Record<string, any>;
const addr = { id: "a1", customerId: "c1", isDefault: true, createdAt: new Date("2024-01-01") };
const seed = (id: string): Row => ({
  id,
  orderNumber: `ORD-${id}`,
  tenantId: "t1",
  customerId: "c1",
  status: OrderStatus.CONFIRMED,
  fulfillPath: FulfillPath.ROUTE,
  routeRunStopId: null,
  routeRunStop: null,
  total: 10,
  lineItems: [{ id: `li-${id}`, productId: "p1", qty: 2, product: { name: "Tomatoes", sku: "T" } }],
  _count: { lineItems: 1 },
  customer: { id: "c1", businessName: "Acme Co", addresses: [addr] },
});

/** Reads `in` / `notIn` / `not` on a scalar column; any other operator is a loud failure. */
function matchesField(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object") return value === cond;
  const c = cond as Record<string, any>;
  const known = new Set(["in", "notIn", "not"]);
  const unknown = Object.keys(c).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`where evaluator cannot read operator ${unknown.join(",")}`);
  if (c.in && !c.in.includes(value)) return false;
  if (c.notIn && c.notIn.includes(value)) return false;
  if ("not" in c && value === c.not) return false;
  return true;
}
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND" || key === "OR") throw new Error(`where evaluator cannot read ${key}`);
    return matchesField(row[key], cond);
  });
}

describe("an order switched to PICKUP never loads on a route and never rides a trip", () => {
  let table: Row[];
  let routes: RoutesService;
  let trips: TripsService;
  let orders: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    table = [seed("o-route"), seed("o-switched")];

    // The orders service: findFirst reads the table, update writes it (the real switch code runs).
    orders = await buildOrdersService();
    orders.prisma.order.findFirst.mockImplementation(async (a: any) =>
      table.find((r) => r.id === a.where.id),
    );
    orders.prisma.order.update.mockImplementation(async (a: any) => {
      const row = table.find((r) => r.id === a.where.id)!;
      Object.assign(row, a.data);
      return row;
    });

    // The dispatch readers: findMany / count evaluate their where against the same table.
    const prisma = createMockPrisma();
    prisma.order.findMany.mockImplementation(async (a: any) =>
      table.filter((r) => matches(r, a.where)),
    );
    prisma.order.count.mockImplementation(
      async (a: any) => table.filter((r) => matches(r, a.where)).length,
    );
    prisma.route.findUnique.mockResolvedValue({
      id: "route-1",
      name: "R",
      stops: [{ id: "s1", customerId: "c1", customer: { id: "c1", businessName: "Acme Co" } }],
    });
    const mod = await Test.createTestingModule({
      providers: [
        RoutesService,
        TripsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: MessagingService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("k") } },
        { provide: StorageService, useValue: {} },
        { provide: FeatureConfigService, useValue: { getEffectiveMode: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
      ],
    }).compile();
    routes = mod.get(RoutesService);
    trips = mod.get(TripsService);
  });

  const loadedOnRoute = async () =>
    (await routes.getPackingList("route-1")).orders.map((o: any) => o.id).sort();
  const offeredToTrips = async () =>
    ((await trips.getEligibleOrders("t1", { page: 1, limit: 20 } as never)) as any).data
      .map((o: any) => o.orderId)
      .sort();

  it("before the switch both orders load on the route and are offered to a trip", async () => {
    expect(await loadedOnRoute()).toEqual(["o-route", "o-switched"]);
    expect(await offeredToTrips()).toEqual(["o-route", "o-switched"]);
  });

  it("after the real switch the PICKUP order is gone from the load list and the trip pool", async () => {
    await orders.service.updateFulfillPath(
      "o-switched",
      { fulfillPath: "PICKUP" } as any,
      operatorPayload as any,
    );
    expect(table.find((r) => r.id === "o-switched")?.fulfillPath).toBe(FulfillPath.PICKUP);
    expect(await loadedOnRoute()).toEqual(["o-route"]);
    expect(await offeredToTrips()).toEqual(["o-route"]);
    // and the by-id eligibility read (POST /trips) refuses it with the PICKUP reason
    const rows = await trips.getEligibility("t1", ["o-switched", "o-route"]);
    const byId = new Map(rows.map((r) => [r.orderId, r]));
    expect(byId.get("o-switched")).toMatchObject({ eligible: false, reason: "PICKUP_FULFILLMENT" });
    expect(byId.get("o-route")?.eligible).toBe(true);
  });
});

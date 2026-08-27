import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FulfillPath, OrderStatus, Prisma, RouteKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { geocodeAddress } from "../common/geocode.util";
// Local mirror of packages/types/trip-grouping.ts — @routeflow/types must NEVER
// be imported at runtime from the API (raw-TS entry point, see that file's header).
import { groupOrdersForTrip } from "../common/trip-grouping";
import { CreateTripDto, TripOriginDto, TripOriginType } from "./dto/create-trip.dto";
import { EligibleOrdersQueryDto } from "./dto/eligible-orders.dto";

// ─── Types ──────────────────────────────────────────────────────────────────

// Shared load shape for both GET /trips/eligibility and POST /trips — one
// query, one predicate, so the two endpoints can never disagree on a reason.
const TRIP_ORDER_INCLUDE = {
  customer: { include: { addresses: true } },
  routeRunStop: { include: { routeRun: { include: { driver: true } } } },
} satisfies Prisma.OrderInclude;

type LoadedTripOrder = Prisma.OrderGetPayload<{ include: typeof TRIP_ORDER_INCLUDE }>;

export type TripIneligibleReason =
  | "SHIP_FULFILLMENT"
  | "INELIGIBLE_STATUS"
  | "ON_ACTIVE_RUN"
  | "PREVIOUSLY_DISPATCHED"
  | "NO_ADDRESS"
  | "NOT_FOUND";

export interface TripEligibilityRow {
  orderId: string;
  orderNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  eligible: boolean;
  reason?: TripIneligibleReason;
  detail?: string;
}

export interface TripIneligibleOrder {
  orderId: string;
  orderNumber: string | null;
  customerName: string | null;
  reason: TripIneligibleReason;
  detail?: string;
}

// GET /trips/eligible-orders row — only ADDABLE orders are ever returned
// (checkEligibility already ran server-side), so `eligible` is always true.
export interface EligibleOrderRow {
  orderId: string;
  orderNumber: string | null;
  customerId: string;
  customerName: string | null;
  total: number;
  itemCount: number;
  deliveryDate: Date | null;
  eligible: true;
}

export interface EligibleOrdersResult {
  data: EligibleOrderRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

const TRIP_ELIGIBLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PARTIALLY_DELIVERED,
];

/** Single shared predicate for GET /trips/eligibility and POST /trips.
 *  Mirrors the dispatch sweep exactly: status in the eligible set, ROUTE
 *  fulfillment, routeRunStopId null, customer has >= 1 address row. */
function checkEligibility(
  order: LoadedTripOrder | null,
): { ok: true } | { ok: false; reason: TripIneligibleReason; detail?: string } {
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  if (order.fulfillPath === FulfillPath.SHIP)
    return {
      ok: false,
      reason: "SHIP_FULFILLMENT",
      detail: "Shipped by supplier/carrier, not routed",
    };
  if (!TRIP_ELIGIBLE_STATUSES.includes(order.status))
    return { ok: false, reason: "INELIGIBLE_STATUS", detail: `Status is ${order.status}` };
  if (order.routeRunStopId != null) {
    const run = order.routeRunStop?.routeRun;
    const active = run != null && (run.status === "SCHEDULED" || run.status === "IN_PROGRESS");
    if (active)
      return {
        ok: false,
        reason: "ON_ACTIVE_RUN",
        detail: `Already on an active run${run.driver?.contactName ? ` with ${run.driver.contactName}` : ""}`,
      };
    return {
      ok: false,
      reason: "PREVIOUSLY_DISPATCHED",
      detail: "Attached to a finished run (stale link)",
    };
  }
  // NO_ADDRESS only when ZERO CustomerAddress rows exist — un-geocoded rows are
  // fine, the optimizer geocodes stops inline before validating.
  if (!order.customer || order.customer.addresses.length === 0)
    return { ok: false, reason: "NO_ADDRESS", detail: "Customer has no delivery address" };
  return { ok: true };
}

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async getEligibility(tenantId: string, orderIds: string[]): Promise<TripEligibilityRow[]> {
    const orders = await this.loadOrders(tenantId, orderIds);
    const byId = new Map(orders.map((o) => [o.id, o]));
    return orderIds.map((orderId) => {
      const order = byId.get(orderId) ?? null;
      const result = checkEligibility(order);
      return {
        orderId,
        orderNumber: order?.orderNumber ?? null,
        customerId: order?.customerId ?? null,
        customerName: order?.customer?.businessName ?? null,
        eligible: result.ok,
        ...(result.ok ? {} : { reason: result.reason, detail: result.detail }),
      };
    });
  }

  /**
   * GET /trips/eligible-orders — powers the in-builder order picker. The DB
   * `where` is a superset filter mirroring everything checkEligibility can
   * express in SQL (status, fulfillment path, active/stale route-run link);
   * NO_ADDRESS has no cheap SQL equivalent worth maintaining twice, so each
   * row is run back through the SAME checkEligibility() predicate POST
   * /trips uses before it's allowed into the response. That means this list
   * can never offer an order that POST /trips would then reject — filtered
   * rows just make the returned page occasionally shorter than `limit`
   * rather than risk disagreeing with the create path.
   */
  async getEligibleOrders(
    tenantId: string,
    query: EligibleOrdersQueryDto,
  ): Promise<EligibleOrdersResult> {
    const { search, exclude } = query;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.OrderWhereInput = {
      tenantId,
      status: { in: TRIP_ELIGIBLE_STATUSES },
      fulfillPath: { not: FulfillPath.SHIP },
      // checkEligibility rejects EVERY row with a non-null routeRunStopId
      // (ON_ACTIVE_RUN or PREVIOUSLY_DISPATCHED, stale link included), so
      // admitting stale-run rows here just to filter them back out in-memory
      // wastes page slots and inflates meta.total. Filter them at the DB.
      routeRunStopId: null,
      ...(exclude && exclude.length > 0 ? { id: { notIn: exclude } } : {}),
      ...(search
        ? {
            AND: [
              {
                OR: [
                  { orderNumber: { contains: search, mode: "insensitive" as const } },
                  {
                    customer: {
                      businessName: { contains: search, mode: "insensitive" as const },
                    },
                  },
                ],
              },
            ],
          }
        : {}),
    };

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: { ...TRIP_ORDER_INCLUDE, _count: { select: { lineItems: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    const data: EligibleOrderRow[] = orders
      .filter((order) => checkEligibility(order).ok)
      .map((order) => ({
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        customerName: order.customer?.businessName ?? null,
        total: Number(order.total),
        itemCount: order._count.lineItems,
        deliveryDate: order.requestedDeliveryDate,
        eligible: true as const,
      }));

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Creates a DRAFT ad-hoc trip route: one stop per distinct customer among
   * the requested orders, at the resolved origin. ZERO order writes — orders
   * only attach to the trip when it is dispatched (the existing createRun
   * sweep, narrowed to this route's id in WP3). Discarding a draft trip is
   * the existing `DELETE /routes/:id` — no new endpoint.
   */
  async createTrip(tenantId: string, dto: CreateTripDto) {
    const orders = await this.loadOrders(tenantId, dto.orderIds);
    const byId = new Map(orders.map((o) => [o.id, o]));

    const ineligible: TripIneligibleOrder[] = [];
    for (const orderId of dto.orderIds) {
      const order = byId.get(orderId) ?? null;
      const result = checkEligibility(order);
      if (!result.ok) {
        ineligible.push({
          orderId,
          orderNumber: order?.orderNumber ?? null,
          customerName: order?.customer?.businessName ?? null,
          reason: result.reason,
          detail: result.detail,
        });
      }
    }
    if (ineligible.length > 0) {
      throw new ConflictException({ ineligible });
    }

    // The assigned driver is tenant-checked exactly like resolveOrigin's
    // DRIVER-origin driver: Route.driverId is a global FK, so without this a
    // caller could pin another tenant's driver onto the trip (and, via
    // createRun's `dto.driverId ?? route.driverId`, onto the dispatched run).
    if (dto.driverId) {
      const assignedDriver = await this.prisma.driver.findFirst({
        where: { id: dto.driverId, tenantId },
        select: { id: true },
      });
      if (!assignedDriver) throw new NotFoundException("Driver not found");
    }

    // Geocode HTTP (ADDRESS/TENANT origin) happens strictly OUTSIDE the
    // transaction — it's an external call and must never hold a DB lock open.
    const origin = await this.resolveOrigin(tenantId, dto.origin);

    const eligibleOrders = dto.orderIds.map((orderId) => byId.get(orderId)!);
    const { groups } = groupOrdersForTrip(
      eligibleOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customerId: o.customerId,
        customerName: o.customer?.businessName ?? null,
      })),
    );

    return this.prisma.tenantTransaction(async (tx) => {
      return tx.route.create({
        data: {
          name: dto.name ?? `Trip ${new Date().toISOString().slice(0, 10)}`,
          driverId: dto.driverId ?? null,
          kind: RouteKind.ADHOC,
          depotLat: origin.depotLat,
          depotLng: origin.depotLng,
          depotAddress: origin.depotAddress,
          // Nested creates bypass the tenantTransaction/forTenant() auto-injection
          // (it only wraps top-level model calls) — set tenantId explicitly here
          // and on every nested stop, same as createRun's routeRun+stops write.
          tenantId: this.prisma.getTenantId(),
          stops: {
            create: groups.map((group, index) => ({
              stopNumber: index + 1,
              customerId: group.customerId,
              // Known limitation: a customer with two delivery addresses still
              // collapses into ONE stop here, because RouteStop is customer-keyed
              // and the dispatch sweep (routes.service.ts) matches on customerId —
              // see groupOrdersForTrip's grouping contract.
              customerAddressId: this.pickDefaultAddressId(byId.get(group.orderIds[0])),
              tenantId: this.prisma.getTenantId(),
            })),
          },
        },
        include: { stops: true },
      });
    });
  }

  /** Default-address tiebreak — mirrors addStop's: isDefault desc, createdAt asc. */
  private pickDefaultAddressId(order: LoadedTripOrder | undefined): string | undefined {
    const addresses = order?.customer?.addresses ?? [];
    const sorted = [...addresses].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    return sorted[0]?.id;
  }

  private async loadOrders(tenantId: string, orderIds: string[]): Promise<LoadedTripOrder[]> {
    if (orderIds.length === 0) return [];
    return this.prisma.order.findMany({
      where: { id: { in: orderIds }, tenantId },
      include: TRIP_ORDER_INCLUDE,
    });
  }

  private async resolveOrigin(
    tenantId: string,
    origin: TripOriginDto,
  ): Promise<{ depotLat: number; depotLng: number; depotAddress: string }> {
    switch (origin.type) {
      case TripOriginType.DRIVER: {
        const driver = await this.prisma.driver.findFirst({
          where: { id: origin.driverId, tenantId },
        });
        if (!driver) throw new NotFoundException("Driver not found");
        if (driver.homeLat == null || driver.homeLng == null) {
          throw new BadRequestException(
            `${driver.contactName ?? "This driver"} has no home base set. Add a home address on the driver profile first.`,
          );
        }
        return {
          depotLat: driver.homeLat,
          depotLng: driver.homeLng,
          depotAddress: driver.homeAddress ?? "Driver home base",
        };
      }
      case TripOriginType.ADDRESS: {
        const addr = {
          line1: origin.line1!,
          city: origin.city ?? "",
          state: origin.state ?? "",
          zip: origin.zip ?? "",
        };
        const apiKey = this.configService.get<string>("googleMaps.apiKey");
        const geo = await geocodeAddress(addr, apiKey, this.logger);
        if (!geo) {
          // HARD 400, deliberately inverting geocodeAddress's best-effort contract:
          // a silently-null origin would make resolveDepot fall back to the tenant
          // warehouse — the worst possible failure for a custom-origin trip.
          throw new BadRequestException(
            "Could not locate the trip start address. Check it and try again.",
          );
        }
        return {
          depotLat: geo.lat,
          depotLng: geo.lng,
          depotAddress: [origin.line1, origin.city, origin.state, origin.zip]
            .filter(Boolean)
            .join(", "),
        };
      }
      case TripOriginType.TENANT:
      default: {
        const depot = await this.resolveTenantDepot(tenantId);
        if (!depot) {
          throw new BadRequestException(
            "No tenant depot is configured. Set a depot in route settings or choose a different start point.",
          );
        }
        return depot;
      }
    }
  }

  /**
   * Mirrors resolveDepot tiers 2-3 in route-optimization.service.ts (L96-139,
   * READ-ONLY reference, untouched by this module): tier 2 = the SystemConfig
   * cached tenant depot; tier 3 = geocode the tenant's own address and cache it.
   * Tier 1 (route-level depot override) doesn't apply here — a draft trip has
   * no route yet.
   */
  private async resolveTenantDepot(
    tenantId: string,
  ): Promise<{ depotLat: number; depotLng: number; depotAddress: string } | null> {
    const cachedLat = await this.systemConfigService.get("route.defaultDepotLat");
    const cachedLng = await this.systemConfigService.get("route.defaultDepotLng");
    if (cachedLat != null && cachedLng != null) {
      return {
        depotLat: parseFloat(cachedLat),
        depotLng: parseFloat(cachedLng),
        depotAddress: "",
      };
    }

    const tenantConfig = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    if (
      !tenantConfig ||
      !tenantConfig.addressLine1 ||
      !tenantConfig.city ||
      !tenantConfig.state ||
      !tenantConfig.zip
    ) {
      return null;
    }

    const apiKey = this.configService.get<string>("googleMaps.apiKey");
    const coords = await geocodeAddress(
      {
        line1: tenantConfig.addressLine1,
        city: tenantConfig.city,
        state: tenantConfig.state,
        zip: tenantConfig.zip,
      },
      apiKey,
      this.logger,
    );
    if (!coords) return null;

    await this.systemConfigService.set("route.defaultDepotLat", String(coords.lat));
    await this.systemConfigService.set("route.defaultDepotLng", String(coords.lng));

    return {
      depotLat: coords.lat,
      depotLng: coords.lng,
      depotAddress: `${tenantConfig.addressLine1}, ${tenantConfig.city}, ${tenantConfig.state} ${tenantConfig.zip}`,
    };
  }
}

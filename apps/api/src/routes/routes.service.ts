import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import {
  UserRole,
  RouteRunStatus,
  OrderStatus,
  NotificationEvent,
  RouteKind,
  FulfillPath,
  RouteOriginKind,
  RouteEndKind,
  RouteOptimizeMetric,
  PaymentMethod,
  InvoiceStatus,
  ChangeRequestStatus,
} from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
// F03/F05: the settlement cash basis stays pinned to the shared CONFIRMED
// predicate rather than a literal `status: "PAID"`, so it can never silently
// desync from every other confirmed-money read in the codebase.
import { CONFIRMED_PAYMENT } from "../invoices/payment-predicates";
import { geocodeAddress } from "../common/geocode.util";
import { TripOriginDto, TripOriginType } from "../trips/dto/create-trip.dto";
import { TripEndDto, TripEndType } from "../trips/dto/route-planning.dto";
import { ListRoutesDto } from "./dto/list-routes.dto";
import { CreateRouteDto } from "./dto/create-route.dto";
import { UpdateRouteDto } from "./dto/update-route.dto";
import { AddStopDto } from "./dto/add-stop.dto";
import { CreateRouteRunDto } from "./dto/create-route-run.dto";
import { UpdateRunStatusDto, forbiddenRunTransition } from "./dto/update-run-status.dto";
import { ListRunsDto } from "./dto/list-runs.dto";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { formatMoney } from "../messaging/messaging.helpers";
import { CompleteStopDto } from "./dto/complete-stop.dto";
import { CompleteWithPaymentDto } from "./dto/complete-with-payment.dto";
import { SettleRunDto } from "./dto/settle-run.dto";
import { AttachPodArtifactDto } from "./dto/attach-pod-artifact.dto";
import { StorageService } from "../storage/storage.service";
import { compressImage } from "../storage/compress.util";
import {
  isPodStorageKey,
  isRenderableDataUrl,
  parseImageDataUrl,
  podArtifactKey,
  type PodArtifactKind,
} from "./pod-artifacts.util";
import {
  assertRegulatedDeliverySatisfied,
  deriveStopRegulatedRequirements,
  loadAgeIdCategorySets,
  type RegulatedDeliveryDb,
} from "../common/regulated-delivery";

// F11 (B129 / B211): the `resolutionReason` stamped on a ChangeRequest that a
// run-terminal release declined. Exported so a UI/report can recognise a
// system decline without string-matching a literal in two places.
export const RELEASED_CHANGE_REQUEST_REASON = "Run cancelled — order released to dispatch";

// G7: single shared `lineItems` select for the ENTIRE run read path —
// RUN_STOP_INCLUDE below, findOneRun's main query, and findOneRun's
// unlinked-orders fallback all reference this SAME object (never re-literal
// it) so the three can never drift out of sync again. Carries the
// box-aware money fields (subtotal/boxes/pieces/unitsPerBox) the old
// six-field literal lacked — consumed by mobile's `run-money.ts` and,
// once they land, F10/F11/F12/F22 (route money summaries, driver payout
// reconciliation, per-stop invoicing).
export const RUN_LINE_ITEMS_SELECT = {
  id: true,
  productId: true,
  product: { select: { id: true, name: true, unit: true } },
  qty: true,
  unitPrice: true,
  status: true,
  subtotal: true,
  boxes: true,
  pieces: true,
  unitsPerBox: true,
} as const;

// Shared per-stop include used by both list (`findAllRuns`) and detail
// (`findOneRun`) so the two endpoints stay in lockstep. Driver list views need
// `customer`, `customerAddress`, and `orders` to render addresses/totals and to
// build Google Maps waypoints — selecting a slim shape here previously caused
// scheduled-run cards to render "no location" for every stop.
const RUN_STOP_INCLUDE = {
  customer: {
    select: {
      id: true,
      businessName: true,
      contactName: true,
      phone: true,
      deliveryWindowStart: true,
      deliveryWindowEnd: true,
    },
  },
  customerAddress: true,
  orders: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      urgent: true,
      notes: true,
      lineItems: { select: RUN_LINE_ITEMS_SELECT },
    },
  },
  routeStop: {
    include: {
      customer: {
        select: {
          id: true,
          businessName: true,
          contactName: true,
          phone: true,
          deliveryWindowStart: true,
          deliveryWindowEnd: true,
        },
      },
      customerAddress: true,
    },
  },
} as const;

@Injectable()
export class RoutesService {
  private readonly logger = new Logger(RoutesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
    private readonly invoicesService: InvoicesService,
    private readonly configService: ConfigService,
    private readonly storage: StorageService,
  ) {}

  // ── Route Templates ────────────────────────────────────────────────────

  async findAllRoutes(query: ListRoutesDto) {
    const { search, isActive, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};
    // Defaults to SCHEDULED so templates/route-run flows never see ADHOC trips
    // unless a caller explicitly asks for them (trips list UI passes ADHOC).
    where.kind = query?.kind ?? RouteKind.SCHEDULED;
    if (isActive !== undefined) where.isActive = isActive;
    if (search) where.name = { contains: search, mode: "insensitive" };

    const [data, total] = await Promise.all([
      this.prisma.forTenant().route.findMany({
        where,
        include: {
          // _count + latest-run summary let the Deliveries history list render
          // driver/date/status without a second round-trip per row.
          _count: { select: { runs: true, stops: true } },
          runs: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              status: true,
              scheduledDate: true,
              completedAt: true,
              driver: { select: { id: true, contactName: true } },
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().route.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOneRoute(id: string) {
    const route = await this.prisma.forTenant().route.findUnique({
      where: { id },
      include: {
        stops: {
          include: {
            customer: { select: { id: true, businessName: true } },
            customerAddress: true,
          },
          orderBy: { stopNumber: "asc" },
        },
      },
    });
    if (!route) throw new NotFoundException("Route not found");

    // Legacy stops may have customerAddressId=null (customer had no address at add time).
    // Backfill the read side with the customer's default address so the map and other
    // consumers render correctly without requiring a data migration.
    const orphans = route.stops.filter(
      (s): s is typeof s & { customerId: string } => !s.customerAddress && !!s.customerId,
    );
    if (orphans.length) {
      const customerIds = Array.from(new Set(orphans.map((s) => s.customerId)));
      const addresses = await this.prisma.forTenant().customerAddress.findMany({
        where: { customerId: { in: customerIds } },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      });
      const byCustomer = new Map<string, (typeof addresses)[number]>();
      for (const a of addresses) if (!byCustomer.has(a.customerId)) byCustomer.set(a.customerId, a);
      for (const s of orphans) {
        const addr = byCustomer.get(s.customerId);
        if (addr) (s as any).customerAddress = addr;
      }
    }

    return route;
  }

  /**
   * Route planning (start/end points, tolls, objective) for the scheduled-
   * route builder (`routes/create`) — mirrors TripsService.createTrip's
   * resolution (apps/api/src/trips/trips.service.ts, untouched by this
   * module) so both builders validate the same way, but stays additive: when
   * `dto.origin`/`dto.end` are omitted the created route is byte-identical to
   * before this feature. TENANT origin is NOT re-resolved server-side — the
   * web client already resolves it via GET /settings/route and sends
   * depotLat/depotLng/depotAddress directly, exactly as this endpoint has
   * always accepted them; only DRIVER/ADDRESS need a server round-trip.
   */
  async createRoute(dto: CreateRouteDto) {
    let depotLat = dto.depotLat;
    let depotLng = dto.depotLng;
    let depotAddress = dto.depotAddress;
    let originKind: RouteOriginKind | undefined;

    if (dto.origin) {
      if (dto.origin.type === TripOriginType.TENANT) {
        originKind = RouteOriginKind.TENANT;
      } else {
        const resolved = await this.resolveRouteOrigin(dto.origin);
        depotLat = resolved.depotLat;
        depotLng = resolved.depotLng;
        depotAddress = resolved.depotAddress;
        originKind =
          dto.origin.type === TripOriginType.DRIVER
            ? RouteOriginKind.DRIVER
            : RouteOriginKind.ADDRESS;
      }
    }

    // Geocode/driver-lookup HTTP calls (ADDRESS/DRIVER origin, DRIVER_HOME/
    // ADDRESS end) happen strictly before the write, same rationale as
    // TripsService.createTrip — external calls must never straddle a DB write.
    const endResult = dto.end
      ? await this.resolveRouteEnd(
          dto.end,
          {
            depotLat: depotLat ?? null,
            depotLng: depotLng ?? null,
            depotAddress: depotAddress ?? null,
          },
          dto.driverId ?? null,
        )
      : null;

    return this.prisma.forTenant().route.create({
      data: {
        name: dto.name,
        driverId: dto.driverId || undefined,
        depotLat,
        depotLng,
        depotAddress,
        ...(originKind ? { originKind } : {}),
        ...(endResult
          ? {
              endKind: endResult.endKind,
              endLat: endResult.endLat,
              endLng: endResult.endLng,
              endAddress: endResult.endAddress,
            }
          : {}),
        ...(dto.avoidTolls !== undefined ? { avoidTolls: dto.avoidTolls } : {}),
        ...(dto.optimizeBy !== undefined
          ? { optimizeBy: dto.optimizeBy as RouteOptimizeMetric }
          : {}),
      },
    });
  }

  /** DRIVER/ADDRESS origin resolution for `createRoute` — see its docstring
   *  for why TENANT never reaches here. Validation/messaging mirrors
   *  TripsService.resolveOrigin's DRIVER/ADDRESS cases exactly. */
  private async resolveRouteOrigin(
    origin: TripOriginDto,
  ): Promise<{ depotLat: number; depotLng: number; depotAddress: string }> {
    switch (origin.type) {
      case TripOriginType.DRIVER: {
        const driver = await this.prisma.forTenant().driver.findFirst({
          where: { id: origin.driverId },
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
      case TripOriginType.ADDRESS:
      default: {
        const addr = {
          line1: origin.line1!,
          city: origin.city ?? "",
          state: origin.state ?? "",
          zip: origin.zip ?? "",
        };
        const apiKey = this.configService.get<string>("googleMaps.apiKey");
        const geo = await geocodeAddress(addr, apiKey, this.logger);
        if (!geo) {
          throw new BadRequestException(
            "Could not locate the route start address. Check it and try again.",
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
    }
  }

  /** End-point resolution for `createRoute` — mirrors TripsService.resolveEnd
   *  exactly (NONE/RETURN_TO_START/DRIVER_HOME/ADDRESS), just re-hosted here
   *  since this module never imports trips.service.ts. */
  private async resolveRouteEnd(
    end: TripEndDto | undefined,
    origin: { depotLat: number | null; depotLng: number | null; depotAddress: string | null },
    routeDriverId: string | null,
  ): Promise<{
    endKind: RouteEndKind;
    endLat: number | null;
    endLng: number | null;
    endAddress: string | null;
  }> {
    if (!end || end.type === TripEndType.NONE) {
      return { endKind: RouteEndKind.NONE, endLat: null, endLng: null, endAddress: null };
    }

    switch (end.type) {
      case TripEndType.RETURN_TO_START: {
        if (origin.depotLat == null || origin.depotLng == null) {
          throw new BadRequestException(
            "Set a route start point before choosing 'Return to start'.",
          );
        }
        return {
          endKind: RouteEndKind.RETURN_TO_START,
          endLat: origin.depotLat,
          endLng: origin.depotLng,
          endAddress: origin.depotAddress,
        };
      }
      case TripEndType.DRIVER_HOME: {
        const driverId = end.driverId ?? routeDriverId;
        if (!driverId) {
          throw new BadRequestException(
            "Choose a driver for the route end point, or assign a driver to the route first.",
          );
        }
        const driver = await this.prisma.forTenant().driver.findFirst({ where: { id: driverId } });
        if (!driver) throw new NotFoundException("Driver not found");
        if (driver.homeLat == null || driver.homeLng == null) {
          throw new BadRequestException(
            `${driver.contactName ?? "This driver"} has no home base set. Add a home address on the driver profile first.`,
          );
        }
        return {
          endKind: RouteEndKind.DRIVER_HOME,
          endLat: driver.homeLat,
          endLng: driver.homeLng,
          endAddress: driver.homeAddress ?? "Driver home base",
        };
      }
      case TripEndType.ADDRESS: {
        if (!end.line1) {
          throw new BadRequestException("Enter an address for the route end point.");
        }
        const addr = {
          line1: end.line1,
          city: end.city ?? "",
          state: end.state ?? "",
          zip: end.zip ?? "",
        };
        const apiKey = this.configService.get<string>("googleMaps.apiKey");
        const geo = await geocodeAddress(addr, apiKey, this.logger);
        if (!geo) {
          throw new BadRequestException(
            "Could not locate the route end address. Check it and try again.",
          );
        }
        return {
          endKind: RouteEndKind.ADDRESS,
          endLat: geo.lat,
          endLng: geo.lng,
          endAddress: [end.line1, end.city, end.state, end.zip].filter(Boolean).join(", "),
        };
      }
      default:
        return { endKind: RouteEndKind.NONE, endLat: null, endLng: null, endAddress: null };
    }
  }

  async updateRoute(id: string, dto: UpdateRouteDto) {
    await this.findRouteOrThrow(id);
    return this.prisma.forTenant().route.update({ where: { id }, data: dto });
  }

  /**
   * Drops a route's cached road polyline (`Route.plannedPolyline`).
   *
   * The map renders a stored polyline verbatim and deliberately skips its
   * Routes API fetch while one is present, so any change to which stops are on
   * the route — or what order they're in — must clear it or the map keeps
   * drawing the old path forever. `applyRouteVariant` is the only writer.
   */
  private async clearPlannedPolyline(routeId: string) {
    await this.prisma
      .forTenant()
      .route.update({ where: { id: routeId }, data: { plannedPolyline: null } });
  }

  async addStop(routeId: string, dto: AddStopDto) {
    await this.findRouteOrThrow(routeId);

    let stopNumber = dto.stopNumber;
    if (stopNumber === undefined) {
      const last = await this.prisma.forTenant().routeStop.findFirst({
        where: { routeId },
        orderBy: { stopNumber: "desc" },
        select: { stopNumber: true },
      });
      stopNumber = (last?.stopNumber ?? 0) + 1;
    }

    // Fall back to the customer's default address when the caller omits it, so the
    // stop has geocoded coords available for the map/optimizer. If the customer
    // has no addresses at all, store null (nothing we can do).
    let customerAddressId = dto.customerAddressId;
    if (!customerAddressId) {
      const defaultAddr = await this.prisma.forTenant().customerAddress.findFirst({
        where: { customerId: dto.customerId },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: { id: true },
      });
      customerAddressId = defaultAddr?.id;
    }

    const created = await this.prisma.forTenant().routeStop.create({
      data: {
        routeId,
        customerId: dto.customerId,
        customerAddressId,
        stopNumber,
        notes: dto.notes,
      },
    });
    await this.clearPlannedPolyline(routeId);
    return created;
  }

  async removeStop(routeId: string, stopId: string) {
    const stop = await this.prisma
      .forTenant()
      .routeStop.findFirst({ where: { id: stopId, routeId } });
    if (!stop) throw new NotFoundException("Stop not found");

    // Check whether any in-flight run stops reference this route stop.
    // onDelete: Restrict on RouteRunStop → RouteStop would cause a 500 without this guard.
    const blockedByRun = await this.prisma.forTenant().routeRunStop.findFirst({
      where: { routeStopId: stopId, status: { in: ["PENDING", "IN_PROGRESS"] } },
    });
    if (blockedByRun) {
      throw new ConflictException(
        "Cannot remove a stop that is part of an active run. Complete or cancel the run first.",
      );
    }

    try {
      await this.prisma.forTenant().routeStop.delete({ where: { id: stopId } });
    } catch (err: any) {
      if (err?.code === "P2003") {
        throw new ConflictException(
          "Cannot remove this stop because it is referenced by a route run. Complete or cancel the associated run first.",
        );
      }
      throw err;
    }
    await this.clearPlannedPolyline(routeId);
    return { success: true };
  }

  async reorderStops(routeId: string, order: { id: string; stopNumber: number }[]) {
    await this.findRouteOrThrow(routeId);
    const allStops = await this.prisma
      .forTenant()
      .routeStop.findMany({ where: { routeId }, select: { id: true, stopNumber: true } });
    const offset = allStops.length + order.length + 100;
    await this.prisma.$transaction([
      ...allStops.map((s) =>
        this.prisma.forTenant().routeStop.update({
          where: { id: s.id },
          data: { stopNumber: s.stopNumber + offset },
        }),
      ),
      ...order.map(({ id, stopNumber }) =>
        this.prisma.forTenant().routeStop.update({ where: { id }, data: { stopNumber } }),
      ),
      // See clearPlannedPolyline — a hand reorder invalidates the stored path.
      this.prisma
        .forTenant()
        .route.update({ where: { id: routeId }, data: { plannedPolyline: null } }),
    ]);
    return { success: true };
  }

  async deleteRoute(id: string) {
    await this.findRouteOrThrow(id);

    // Collect all run IDs and run-stop IDs for this route before deleting
    const runs = await this.prisma.forTenant().routeRun.findMany({
      where: { routeId: id },
      include: { stops: { select: { id: true } } },
    });
    const runIds = runs.map((r) => r.id);
    const runStopIds = runs.flatMap((r) => r.stops.map((s) => s.id));

    // R3: any route — ADHOC or SCHEDULED — whose run has started or finished
    // carries run stops with POD photos, signatures and arrival/completion
    // timestamps. Deleting it would destroy that history with no way to
    // rebuild it, so refuse regardless of route.kind. Drafts (and
    // scheduled/cancelled runs, which recorded nothing) stay deletable.
    if (runs.some((r) => r.status === "IN_PROGRESS" || r.status === "COMPLETED")) {
      throw new BadRequestException(
        "This trip has already been delivered on and cannot be deleted — its proof of delivery would be lost.",
      );
    }

    await this.prisma.tenantTransaction(async (tx) => {
      // 1. Unlink orders from runs/stops
      if (runIds.length > 0) {
        await tx.order.updateMany({
          where: { routeRunId: { in: runIds } },
          data: { routeRunId: null, routeRunStopId: null },
        });
      }
      // 2. Unlink delivery mutations from run stops
      if (runStopIds.length > 0) {
        await tx.deliveryMutation.updateMany({
          where: { routeRunStopId: { in: runStopIds } },
          data: { routeRunStopId: null },
        });
        // 3. Delete run stops
        await tx.routeRunStop.deleteMany({ where: { id: { in: runStopIds } } });
      }
      // 4. Delete runs
      if (runIds.length > 0) {
        await tx.routeRun.deleteMany({ where: { id: { in: runIds } } });
      }
      // 5. Delete route stops and customer associations
      await tx.routeStop.deleteMany({ where: { routeId: id } });
      await tx.routeCustomer.deleteMany({ where: { routeId: id } });
      // 6. Delete the route itself
      await tx.route.delete({ where: { id } });
    });

    return { success: true };
  }

  async reorderRunStops(runId: string, order: { id: string; stopNumber: number }[]) {
    const run = await this.prisma.forTenant().routeRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException("Route run not found");
    if (run.status === "IN_PROGRESS" || run.status === "COMPLETED") {
      throw new BadRequestException("Cannot reorder stops on an active or completed route run");
    }
    const allStops = await this.prisma.forTenant().routeRunStop.findMany({
      where: { routeRunId: runId },
      select: { id: true, stopNumber: true },
    });
    const offset = allStops.length + order.length + 100;
    await this.prisma.$transaction([
      ...allStops.map((s) =>
        this.prisma.forTenant().routeRunStop.update({
          where: { id: s.id },
          data: { stopNumber: s.stopNumber + offset },
        }),
      ),
      ...order.map(({ id, stopNumber }) =>
        this.prisma.forTenant().routeRunStop.update({ where: { id }, data: { stopNumber } }),
      ),
      // The polyline lives on the parent route but is what this run's map
      // draws — a hand reorder here makes it wrong too. See
      // clearPlannedPolyline.
      this.prisma
        .forTenant()
        .route.update({ where: { id: run.routeId }, data: { plannedPolyline: null } }),
    ]);
    return { success: true };
  }

  async getPackingList(routeId: string) {
    const route = await this.prisma.forTenant().route.findUnique({
      where: { id: routeId },
      include: {
        stops: {
          include: { customer: { select: { id: true, businessName: true } } },
          orderBy: { stopNumber: "asc" },
        },
      },
    });
    if (!route) throw new NotFoundException("Route not found");

    const customerIds = route.stops.map((s) => s.customerId).filter((id): id is string => !!id);

    const orders = customerIds.length
      ? await this.prisma.forTenant().order.findMany({
          where: {
            customerId: { in: customerIds },
            status: { in: ["PENDING", "CONFIRMED"] },
          },
          include: {
            customer: { select: { id: true, businessName: true } },
            lineItems: {
              include: {
                product: { select: { id: true, name: true, sku: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];

    // Aggregate per product
    const map: Record<
      string,
      {
        productId: string;
        productName: string;
        sku?: string | null;
        totalQty: number;
        customers: { name: string; qty: number }[];
      }
    > = {};

    for (const order of orders) {
      for (const li of order.lineItems) {
        // Unlisted lines have no productId — key them by name so they still show
        // on the warehouse packing list.
        const key = li.productId ?? `unlisted:${li.name ?? li.id}`;
        if (!map[key]) {
          map[key] = {
            productId: li.productId ?? "",
            productName: li.product?.name ?? li.name ?? "Item",
            sku: li.product?.sku ?? null,
            totalQty: 0,
            customers: [],
          };
        }
        const qty = Number(li.qty);
        map[key].totalQty += qty;
        const cName = order.customer?.businessName ?? "Unknown";
        const existing = map[key].customers.find((c) => c.name === cName);
        if (existing) existing.qty += qty;
        else map[key].customers.push({ name: cName, qty });
      }
    }

    const packingList = Object.values(map).sort((a, b) =>
      a.productName.localeCompare(b.productName),
    );

    return { orders, packingList };
  }

  // ── Customer Route Assignments ─────────────────────────────────────────

  async getCustomerRouteAssignments(): Promise<
    Record<string, { routeId: string; routeName: string }[]>
  > {
    const stops = await this.prisma.forTenant().routeStop.findMany({
      // ADHOC trips must never populate the "Currently in:" customer hints —
      // those are a SCHEDULED-route concept and a one-shot trip isn't a
      // recurring assignment.
      where: { customerId: { not: null }, route: { kind: RouteKind.SCHEDULED } },
      select: {
        customerId: true,
        route: { select: { id: true, name: true } },
      },
    });

    const map: Record<string, { routeId: string; routeName: string }[]> = {};
    for (const stop of stops) {
      if (!stop.customerId) continue;
      if (!map[stop.customerId]) map[stop.customerId] = [];
      // Avoid duplicate route entries for the same customer
      if (!map[stop.customerId].some((r) => r.routeId === stop.route.id)) {
        map[stop.customerId].push({ routeId: stop.route.id, routeName: stop.route.name });
      }
    }
    return map;
  }

  async getLiveRoutes() {
    const runs = await this.prisma.forTenant().routeRun.findMany({
      where: { status: RouteRunStatus.IN_PROGRESS },
      include: {
        route: { select: { id: true, name: true } },
        driver: {
          select: {
            id: true,
            contactName: true,
            user: { select: { username: true } },
          },
        },
        stops: {
          orderBy: { stopNumber: "asc" },
          include: {
            customer: { select: { businessName: true } },
            customerAddress: { select: { lat: true, lng: true } },
          },
        },
      },
    });

    const driverIds = runs.map((r) => r.driverId).filter((d): d is string => !!d);
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    const recentLocations = driverIds.length
      ? await this.prisma.forTenant().driverLocation.findMany({
          where: { driverId: { in: driverIds }, recordedAt: { gte: fiveMinAgo } },
          orderBy: { recordedAt: "desc" },
        })
      : [];
    const latestByDriver = new Map<string, (typeof recentLocations)[number]>();
    for (const loc of recentLocations) {
      if (!latestByDriver.has(loc.driverId)) latestByDriver.set(loc.driverId, loc);
    }

    return {
      routes: runs.map((run) => {
        const stops = run.stops.map((s) => ({
          id: s.id,
          customerId: s.customerId,
          customerName: s.customer?.businessName ?? "",
          lat: s.customerAddress?.lat != null ? Number(s.customerAddress.lat) : null,
          lng: s.customerAddress?.lng != null ? Number(s.customerAddress.lng) : null,
          stopNumber: s.stopNumber,
          status: s.status,
        }));
        const nextStopIndex = stops.findIndex(
          (s) => s.status === "PENDING" || s.status === "IN_PROGRESS",
        );
        const loc = run.driverId ? latestByDriver.get(run.driverId) : undefined;
        const driverName = run.driver
          ? (run.driver.contactName ?? run.driver.user?.username ?? null)
          : null;
        return {
          runId: run.id,
          routeId: run.routeId,
          routeName: run.route.name,
          driverId: run.driverId,
          driverName,
          status: run.status,
          latestLocation: loc
            ? {
                lat: Number(loc.lat),
                lng: Number(loc.lng),
                recordedAt: loc.recordedAt.toISOString(),
                speedKph: loc.speedKph != null ? Number(loc.speedKph) : null,
                heading: loc.heading != null ? Number(loc.heading) : null,
              }
            : null,
          stops,
          nextStopIndex: nextStopIndex >= 0 ? nextStopIndex : stops.length,
        };
      }),
    };
  }

  // ── Route Runs ─────────────────────────────────────────────────────────

  async createRun(dto: CreateRouteRunDto, user?: JwtPayload) {
    const route = await this.prisma.forTenant().route.findUnique({
      where: { id: dto.routeId },
      include: {
        // REG-B131: a removed (soft-deleted) customer's stop is not dispatched — no RouteRunStop
        // and, because the order sweep below runs off run.stops, no order attached either. Filtered
        // in the query (never in JS after the fact) so the count below is the only other read. A
        // stop with NO customer (customerId null — a manual/depot stop) is not a customer stop and
        // stays. Stateless: restoreCustomer() clears deletedAt and the next dispatch includes it.
        stops: {
          where: { OR: [{ customerId: null }, { customer: { deletedAt: null } }] },
          orderBy: { stopNumber: "asc" },
        },
      },
    });
    if (!route) throw new NotFoundException("Route not found");

    // A stop the filter above dropped leaves no trace in the dispatch response (stopCount simply
    // reads lower), so count the suppressed set once per dispatch — otherwise a route whose stops
    // all belong to removed customers dispatches an empty run with no explanation anywhere.
    const suppressedStops =
      (await this.prisma.forTenant().routeStop.count({
        where: { routeId: dto.routeId, customer: { deletedAt: { not: null } } },
      })) ?? 0;
    if (suppressedStops > 0) {
      this.logger.warn(
        `REG-B131: ${suppressedStops} route stop(s) skipped — customer removed (route ${dto.routeId})`,
      );
    }

    // orderIds narrows the dispatch sweep below to exactly the requested orders —
    // only meaningful for an ADHOC trip (a SCHEDULED route's stops already imply
    // their own order set). Reject it outright on a SCHEDULED route rather than
    // silently ignoring it.
    if (dto.orderIds?.length && route.kind !== RouteKind.ADHOC) {
      throw new BadRequestException(
        "orderIds can only be provided when dispatching an ad-hoc trip",
      );
    }
    // ...and the inverse. An ad-hoc trip stores NO order linkage of its own (a
    // draft trip performs zero order writes), so dispatching one without
    // orderIds would let the sweep below attach EVERY open order of each stop's
    // customer — not just the ones the operator picked. Only the trip builder
    // knows that selection, so reject every other dispatch path (route-detail
    // "Dispatch Run", a re-dispatch of a finished trip) instead of over-attaching.
    if (route.kind === RouteKind.ADHOC && !dto.orderIds?.length) {
      throw new BadRequestException(
        "An ad-hoc trip must be dispatched from the trip builder, which sends the exact orders to deliver. Rebuild this trip from the Orders list.",
      );
    }
    const adhocOrderIds =
      route.kind === RouteKind.ADHOC && dto.orderIds?.length ? dto.orderIds : null;

    // For stops missing a customerAddressId, resolve the customer's default address now
    // so the run stop gets a proper address FK (needed for map pins and optimization).
    const stopsNeedingAddr = route.stops.filter((s) => !s.customerAddressId && s.customerId);
    if (stopsNeedingAddr.length > 0) {
      const defaultAddrs = await this.prisma.forTenant().customerAddress.findMany({
        where: {
          customerId: { in: stopsNeedingAddr.map((s) => s.customerId!) },
          isDefault: true,
        },
        select: { id: true, customerId: true },
      });
      const addrByCustomer = new Map(defaultAddrs.map((a) => [a.customerId, a.id]));
      for (const s of route.stops) {
        if (!s.customerAddressId && s.customerId) {
          (s as any).customerAddressId = addrByCustomer.get(s.customerId) ?? null;
        }
      }
    }

    // Drivers can only create runs for themselves.
    // BUG-W-7: when an operator dispatches a route without an explicit
    // dto.driverId, fall back to the route's assigned driver. Otherwise the
    // run is created with driverId=null and the run-detail subtitle reads
    // "Unassigned" even though the underlying Route has a driver.
    let resolvedDriverId = dto.driverId ?? route.driverId ?? undefined;
    if (user?.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      resolvedDriverId = driver?.id ?? undefined;
    }

    const run = await this.prisma.tenantTransaction(async (tx) => {
      // Lock the Route row so concurrent dispatch requests serialize here
      // instead of racing past the duplicate-run check below.
      await tx.$executeRaw`SELECT id FROM "Route" WHERE id = ${dto.routeId} FOR UPDATE`;

      // Prevent duplicate active runs for the same route (atomic inside transaction)
      const activeRun = await tx.routeRun.findFirst({
        where: {
          routeId: dto.routeId,
          status: { in: [RouteRunStatus.SCHEDULED, RouteRunStatus.IN_PROGRESS] },
        },
        select: { id: true },
      });
      if (activeRun) {
        throw new ConflictException(
          "This route already has an active run. Complete or cancel it before dispatching again.",
        );
      }

      // Snapshot the route's own depot onto the run, if the route has one set.
      // This is NOT the multi-tier resolution (system default / geocoded tenant
      // address) — that lookup lives in route-optimization.service.resolveDepot
      // and runs separately at optimize time. A route with no depot set here
      // simply gets an undepotted run; optimize resolves it later.
      let depotLat: number | undefined;
      let depotLng: number | undefined;
      let depotAddress: string | undefined;
      if (route.depotLat != null && route.depotLng != null) {
        depotLat = route.depotLat;
        depotLng = route.depotLng;
        depotAddress = route.depotAddress ?? undefined;
      }

      return tx.routeRun.create({
        data: {
          routeId: dto.routeId,
          driverId: resolvedDriverId,
          scheduledDate: new Date(dto.scheduledDate),
          startTime: dto.startTime,
          depotLat,
          depotLng,
          depotAddress,
          notes: dto.notes,
          // RF-001: include tenantId on the RouteRun record itself (previously
          // only the child RouteRunStops received tenantId, leaving RouteRun
          // rows with tenantId=null and bypassing tenant query scoping).
          tenantId: this.prisma.getTenantId(),
          stops: {
            create: route.stops.map((s) => ({
              routeStopId: s.id,
              stopNumber: s.stopNumber,
              customerId: s.customerId,
              customerAddressId: s.customerAddressId,
              podPhotoUrls: [],
              tenantId: this.prisma.getTenantId(),
            })),
          },
        },
        include: {
          route: { select: { id: true, name: true } },
          driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
          stops: {
            include: {
              customer: { select: { id: true, businessName: true } },
              customerAddress: true,
            },
            orderBy: { stopNumber: "asc" },
          },
        },
      });
    });

    // Assign pending/confirmed orders to their respective run stops (outside the lock transaction)
    const sweepResults = await Promise.all(
      run.stops
        .filter((s) => s.customerId)
        .map((s) =>
          this.prisma.forTenant().order.updateMany({
            where: {
              customerId: s.customerId!,
              status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
              routeRunStopId: null,
              // SHIP orders go out via a carrier, so they must never attach to a
              // run stop — a driver would otherwise see them on the route and
              // could complete the stop (and take a delivery payment) against
              // goods a carrier is shipping. This mirrors TripsService's
              // checkEligibility and is what makes "won't appear on delivery
              // routes" true for SCHEDULED routes too, not just trips.
              //
              // This key is a DELIBERATE deviation from the plan's "SCHEDULED
              // sweep stays byte-identical" criterion, and it needs owner
              // sign-off — see the pre-deploy audit in
              // docs/phase0-adhoc-trips-findings.md. Every EXISTING order is
              // unaffected (the column defaults to ROUTE and the migration
              // performs no backfill), but OrdersService.create seeds new orders
              // from `Customer.fulfillPath`, which was writable via DTOs long
              // before anything read it. A legacy customer row left on SHIP
              // would therefore drop its new orders off scheduled runs too, not
              // just off trips — hence the audit before deploy.
              fulfillPath: FulfillPath.ROUTE,
              ...(adhocOrderIds ? { id: { in: adhocOrderIds } } : {}),
            },
            data: { routeRunId: run.id, routeRunStopId: s.id },
          }),
        ),
    );
    // How many orders the sweep actually attached. For an ad-hoc trip the client
    // asked for a specific set, and orders can be cancelled or dispatched
    // elsewhere between building the trip and sending it — reporting this lets
    // the builder surface what got dropped instead of claiming the full set.
    const attachedOrderCount = sweepResults.reduce((sum, r) => sum + (r?.count ?? 0), 0);

    // Phase 4 (W7b): flag stops whose newly-assigned orders contain an age/ID-gated
    // category so the driver app can surface "regulated — signature required"
    // before the delivery is attempted. Best-effort — a flag failure must not
    // block dispatch (the completion gate re-derives authoritatively anyway).
    await this.applyStopRegulatedFlags(run.stops.map((s) => s.id)).catch((e) =>
      this.logger.warn(
        `applyStopRegulatedFlags failed for run ${run.id}: ${e instanceof Error ? e.message : e}`,
      ),
    );

    // RF-015: notify the assigned driver via WebSocket + push so the run
    // appears on their device immediately after dispatch (no pull-to-refresh needed).
    if (run.driverId) {
      const tenantId = this.prisma.getTenantId();
      const dispatchPayload = {
        runId: run.id,
        routeId: run.route.id,
        routeName: run.route.name,
        scheduledDate: run.scheduledDate.toISOString(),
        stopCount: run.stops.length,
      };

      // Socket.IO: delivers instantly when driver is connected
      this.gateway.emitToDriver(tenantId, run.driverId, dispatchPayload);

      // Push notification: delivers when driver is offline/backgrounded
      this.notifications
        .sendToDriver(
          run.driverId,
          "New route dispatched",
          `You have been assigned to ${run.route.name} (${run.stops.length} stop${run.stops.length !== 1 ? "s" : ""})`,
          { runId: run.id, screen: "route" },
        )
        .catch(() => {
          // Best-effort — do not fail dispatch if push is unavailable
        });
    }

    return { ...run, attachedOrderCount };
  }

  /**
   * Phase 4 (W7b): persist per-stop age/ID requirement flags from the categories
   * of each stop's assigned orders. Fast-paths to a no-op for tenants that run no
   * age/ID-gated category. The completion gate re-derives authoritatively, so
   * these flags only drive the driver-app stop card.
   */
  private async applyStopRegulatedFlags(stopIds: string[]): Promise<void> {
    if (stopIds.length === 0) return;
    const scoped = this.prisma.forTenant();
    const db = scoped as unknown as RegulatedDeliveryDb;
    const sets = await loadAgeIdCategorySets(db);
    if (!sets.any) return;
    for (const stopId of stopIds) {
      const { requiresAge, requiresId } = await deriveStopRegulatedRequirements(
        db,
        { stopId },
        sets,
      );
      if (requiresAge || requiresId) {
        await scoped.routeRunStop.update({
          where: { id: stopId },
          data: { ageCheckRequired: requiresAge, identityCheckRequired: requiresId },
        });
      }
    }
  }

  async findAllRuns(query: ListRunsDto, user: JwtPayload) {
    const { assignedToMe, status, activeOnly, date, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (status) {
      where.status = status;
    } else if (activeOnly) {
      // Mirror the dispatch endpoint's definition of "active" so orphan
      // SCHEDULED/IN_PROGRESS runs that block dispatch are surfaced to the
      // operator regardless of scheduledDate.
      where.status = { in: [RouteRunStatus.SCHEDULED, RouteRunStatus.IN_PROGRESS] };
    }
    if (date) {
      const d = new Date(date);
      const nextDay = new Date(d);
      nextDay.setDate(nextDay.getDate() + 1);
      where.scheduledDate = { gte: d, lt: nextDay };
    }

    let isDriverScoped = false;
    if (user.role === UserRole.DRIVER || assignedToMe) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (driver) {
        where.driverId = driver.id;
        isDriverScoped = true;
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.forTenant().routeRun.findMany({
        where,
        include: {
          route: {
            select: {
              id: true,
              name: true,
              kind: true,
              depotLat: true,
              depotLng: true,
              depotAddress: true,
              endKind: true,
              endLat: true,
              endLng: true,
            },
          },
          driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
          _count: { select: { stops: true } },
          stops: {
            include: RUN_STOP_INCLUDE,
            orderBy: { stopNumber: "asc" },
          },
        },
        skip,
        take: limit,
        orderBy: { scheduledDate: "desc" },
      }),
      this.prisma.forTenant().routeRun.count({ where }),
    ]);

    // Same normalisation as findOneRun: legacy/seeded run stops may lack a
    // direct customer/address link — fall back to the template RouteStop's
    // data so address-dependent UI (Maps button, "no location" badge) works.
    const normalisedData = data.map((run: any) => ({
      ...run,
      stops: run.stops.map((s: any) => ({
        ...s,
        customer: s.customer ?? s.routeStop?.customer ?? null,
        customerAddress: s.customerAddress ?? s.routeStop?.customerAddress ?? null,
      })),
    }));

    // F05 / R5: `collectedPayments` only for a driver's own list — operator-wide
    // lists (every run, every driver) skip it; the operator reads cash truth
    // per-run on the detail page instead, not summed across a whole page.
    const enrichedData = isDriverScoped
      ? await this.enrichRunsWithCollectedPayments(normalisedData)
      : normalisedData;

    return {
      data: enrichedData,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOneRun(id: string, user?: any) {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            kind: true,
            depotLat: true,
            depotLng: true,
            depotAddress: true,
            endKind: true,
            endLat: true,
            endLng: true,
          },
        },
        driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
        stops: {
          include: {
            customer: {
              select: {
                id: true,
                businessName: true,
                contactName: true,
                phone: true,
                deliveryWindowStart: true,
                deliveryWindowEnd: true,
              },
            },
            customerAddress: true,
            orders: {
              select: {
                id: true,
                orderNumber: true,
                status: true,
                urgent: true,
                notes: true,
                lineItems: { select: RUN_LINE_ITEMS_SELECT },
              },
            },
            routeStop: {
              include: {
                customer: {
                  select: {
                    id: true,
                    businessName: true,
                    contactName: true,
                    phone: true,
                    deliveryWindowStart: true,
                    deliveryWindowEnd: true,
                  },
                },
                customerAddress: true,
              },
            },
            deliveryMutations: {
              select: {
                id: true,
                orderItemId: true,
                productId: true,
                type: true,
                quantityDelivered: true,
                note: true,
                createdAt: true,
                product: { select: { id: true, name: true, unit: true } },
              },
            },
          },
          orderBy: { stopNumber: "asc" },
        },
      },
    });
    if (!run) throw new NotFoundException("Route run not found");

    // Drivers can only access their own assigned run
    if (user?.role === "DRIVER") {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id)
        throw new ForbiddenException("You do not have access to this route run");
    }

    // F05 / R5: server cash truth, always exposed on the detail read — the
    // driver settlement screen and the web read-only Settlement card both
    // need it, and it's cheap (two indexed findMany calls) next to everything
    // else this endpoint already joins.
    const collectedPayments = await this.getRunCashCollections(id, run.startedAt);

    // Normalise stops: if the run stop lacks direct customer/address links, fall back to the
    // template RouteStop's data (happens with seeded or legacy runs created before dispatch logic
    // copied customer refs onto the run stop).
    const normalisedStops = run.stops.map((s: any) => ({
      ...s,
      customer: s.customer ?? s.routeStop?.customer ?? null,
      customerAddress: s.customerAddress ?? s.routeStop?.customerAddress ?? null,
      // Resolve customerId for later order lookup
      _resolvedCustomerId: s.customerId ?? s.routeStop?.customerId ?? null,
    }));

    // Final fallback: if a stop still has no address (route stop FK was never set),
    // look up the customer's default address so map pins and optimization work.
    const stillMissingAddr = normalisedStops.filter(
      (s: any) => !s.customerAddress && s._resolvedCustomerId,
    );
    if (stillMissingAddr.length > 0) {
      const defaultAddrs = await this.prisma.forTenant().customerAddress.findMany({
        where: {
          customerId: { in: stillMissingAddr.map((s: any) => s._resolvedCustomerId) },
          isDefault: true,
        },
      });
      const addrByCustomer = new Map(defaultAddrs.map((a) => [a.customerId, a]));
      for (const s of normalisedStops) {
        if (!s.customerAddress && s._resolvedCustomerId) {
          s.customerAddress = addrByCustomer.get(s._resolvedCustomerId) ?? null;
        }
      }
    }

    // Fallback for runs where orders were not linked at dispatch time (legacy/seeded data):
    // if no stop has linked orders, fetch active orders per customer and merge them in.
    const anyLinked = normalisedStops.some((s: any) => (s.orders as any[]).length > 0);
    // F11 (spec R4): a run that has gone TERMINAL has released the undelivered
    // orders of every stop that recorded no work, so it is exactly the "no stop
    // has linked orders" shape this legacy fallback keys on — without the guard
    // its detail page would display the customers' CURRENT open orders (created
    // days later, in any state) as if they had been on the run. Both terminal
    // states reach that shape: a cancel releases every non-COMPLETED stop's
    // orders, and a run completed with EVERY stop skipped releases all of them
    // too. (An un-cancelled, fully-released run still reaches the fallback —
    // recorded as a follow-up row; the durable fix is retiring the fallback.)
    //
    // The COMPLETED arm is NARROWED to the shape a release can actually
    // produce: the helper is only ever handed the ids of stops whose status is
    // not COMPLETED, so a COMPLETED run whose stops are ALL COMPLETED was never
    // released by F11 — its empty `orders` arrays are the genuine legacy/seeded
    // shape this fallback exists for (demo-seed's `past-1`/`past-2` runs are
    // exactly that: every stop COMPLETED, no `Order.routeRunStopId` ever
    // written). Blanket-skipping COMPLETED would blank every stop on those
    // detail pages.
    const runWentTerminal =
      run.status === RouteRunStatus.CANCELLED ||
      (run.status === RouteRunStatus.COMPLETED &&
        normalisedStops.some((s: any) => s.status !== "COMPLETED"));
    if (!anyLinked && normalisedStops.length > 0 && !runWentTerminal) {
      const customerIds = normalisedStops
        .map((s: any) => s._resolvedCustomerId)
        .filter((cid: string | null): cid is string => cid !== null);
      if (customerIds.length > 0) {
        const orders = await this.prisma.forTenant().order.findMany({
          where: {
            customerId: { in: customerIds },
            status: { notIn: [OrderStatus.CANCELLED] },
          },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            urgent: true,
            notes: true,
            customerId: true,
            lineItems: { select: RUN_LINE_ITEMS_SELECT },
          },
        });
        const byCustomer: Record<string, any[]> = {};
        for (const o of orders) {
          (byCustomer[o.customerId] ??= []).push(o);
        }
        return {
          ...run,
          stops: normalisedStops.map((s: any) => ({
            ...s,
            orders: s._resolvedCustomerId ? (byCustomer[s._resolvedCustomerId] ?? []) : [],
          })),
          collectedPayments,
        };
      }
    }

    return { ...run, stops: normalisedStops, collectedPayments };
  }

  async updateRun(
    id: string,
    dto: { driverId?: string | null; scheduledDate?: string; notes?: string },
    user?: JwtPayload,
  ) {
    const run = await this.prisma.forTenant().routeRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException("Route run not found");

    if (user?.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) {
        throw new ForbiddenException("You can only manage your own route runs");
      }
      if (dto.driverId !== undefined) {
        throw new ForbiddenException("Drivers cannot reassign route runs");
      }
    }

    const data: any = {};
    if (dto.driverId !== undefined) data.driverId = dto.driverId;
    if (dto.scheduledDate) data.scheduledDate = new Date(dto.scheduledDate);
    if (dto.notes !== undefined) data.notes = dto.notes;
    return this.prisma.forTenant().routeRun.update({ where: { id }, data });
  }

  async deleteRun(id: string) {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id },
      include: { stops: { select: { id: true } } },
    });
    if (!run) throw new NotFoundException("Route run not found");

    const stopIds = run.stops.map((s) => s.id);

    if (stopIds.length > 0) {
      const existingMutation = await this.prisma.forTenant().deliveryMutation.findFirst({
        where: { routeRunStopId: { in: stopIds } },
        select: { id: true },
      });
      if (existingMutation) {
        throw new BadRequestException(
          "This run has recorded deliveries; cancel it instead of deleting.",
        );
      }
    }

    await this.prisma.tenantTransaction(async (tx) => {
      // 1. Unlink orders from run and stops
      await tx.order.updateMany({
        where: { routeRunId: id },
        data: { routeRunId: null, routeRunStopId: null },
      });

      if (stopIds.length > 0) {
        // 2. Unlink delivery mutations referencing these stops
        await tx.deliveryMutation.updateMany({
          where: { routeRunStopId: { in: stopIds } },
          data: { routeRunStopId: null },
        });

        // 3. Delete the run stops
        await tx.routeRunStop.deleteMany({
          where: { routeRunId: id },
        });
      }

      // 4. Delete the run itself
      await tx.routeRun.delete({ where: { id } });
    });

    return { success: true };
  }

  async updateRunStatus(id: string, dto: UpdateRunStatusDto, user: JwtPayload) {
    const run = await this.prisma.forTenant().routeRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException("Route run not found");

    // B72: OWNERSHIP FIRST, then state. A state guard that fires before the
    // driver binding tells an unassigned driver whether the run is CANCELLED or
    // COMPLETED — a driver who may not touch the run should not learn its state
    // either. `attachPodArtifact` orders these the same way; keep all four
    // entry points consistent.
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) {
        throw new ForbiddenException("You do not have access to this route run");
      }

      const allowedStatuses: RouteRunStatus[] = [
        RouteRunStatus.IN_PROGRESS,
        RouteRunStatus.COMPLETED,
      ];
      if (!allowedStatuses.includes(dto.status)) {
        throw new ForbiddenException("Drivers can only set IN_PROGRESS or COMPLETED");
      }

      // B72: un-cancelling is an operator decision. The matrix keeps
      // CANCELLED→SCHEDULED/IN_PROGRESS legal because it is the only recovery an
      // accidentally cancelled run has (deleteRun refuses runs with recorded
      // deliveries), but a stale driver device must not resurrect a called-off
      // run by replaying "start run".
      if (run.status === RouteRunStatus.CANCELLED) {
        throw new ForbiddenException("This run was cancelled — ask your operator to restart it.");
      }
    }

    // B72: from-state guard — see forbiddenRunTransition's doc for the matrix.
    const denied = forbiddenRunTransition(run.status, dto.status);
    if (denied) throw new ConflictException(denied);

    // B72 (composite path): the matrix is edge-wise, so it cannot see
    // COMPLETED → IN_PROGRESS → SCHEDULED — two individually-legal PATCHes that
    // together re-schedule a completed run, which the matrix's own contract says
    // can never happen. `completedAt` survives the first hop, so it is the
    // durable evidence that this run has already been completed once.
    if (dto.status === RouteRunStatus.SCHEDULED && run.completedAt) {
      throw new ConflictException(
        "This run has already been completed — it cannot go back to scheduled. Reopen a stop instead.",
      );
    }

    // Require all stops to be completed or skipped before marking run as COMPLETED
    if (dto.status === RouteRunStatus.COMPLETED) {
      const stops = await this.prisma.forTenant().routeRunStop.findMany({
        where: { routeRunId: id },
        select: { status: true },
      });
      const incomplete = stops.filter((s) => s.status !== "COMPLETED" && s.status !== "SKIPPED");
      if (incomplete.length > 0) {
        throw new BadRequestException(
          `Cannot complete run: ${incomplete.length} stop(s) are still pending. Complete or skip all stops first.`,
        );
      }

      // R7a / B152 backstop: a run still carrying physical money (cash OR
      // check) cannot close unsettled via ANY path (role-agnostic — no
      // web/operator surface sends COMPLETED here today, but this must hold
      // regardless of who/what does). The helper short-circuits to 0 once a
      // settlement note exists, so re-checking a settled run never re-queries
      // payments.
      const outstanding = await this.getUnsettledPhysicalMoney(id, run);
      if (outstanding > 0.001) {
        throw new BadRequestException(
          `This run collected $${outstanding.toFixed(2)} in cash/checks. Record the run settlement before completing.`,
        );
      }
    }

    const updates: any = { status: dto.status };
    if (dto.status === RouteRunStatus.IN_PROGRESS && !run.startedAt) updates.startedAt = new Date();
    if (dto.status === RouteRunStatus.COMPLETED) updates.completedAt = new Date();

    const include = {
      driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
    };

    // F11 (B129 / B211): the two TERMINAL transitions release the orders of
    // every stop that recorded no work, in the SAME transaction as the status
    // write. Stop ids are read inside the tx (not from the findUnique above) so
    // a driver's completeStop that committed in between is seen as COMPLETED
    // and drops out; the helper's status filter is the second guard. Gate
    // reads above (stops-complete, cash backstop) ran pre-release against the
    // FULL order set, which can only make them stricter. SCHEDULED /
    // IN_PROGRESS writes — including un-cancel — stay the bare update: un-cancel
    // is a status-only restore that re-pins NOTHING. It restores the RUN row
    // (its completed stops' POD and settlement), never its order set: createRun
    // refuses a route that already carries a SCHEDULED/IN_PROGRESS run, so
    // re-dispatching the released orders means cancelling this run again and
    // dispatching a FRESH run on the route — un-cancel is not a path back to
    // them (spec R3; follow-up row).
    //
    // No run-row FOR UPDATE is taken (follow-up row). Concurrent PATCHes are
    // idempotent under the matrix and the release matches 0 rows twice, but
    // this branch locks the run row BEFORE the order rows while completeStop /
    // completeWithPayment lock a stop's order rows before the run row — a
    // simultaneous operator cancel and driver stop completion can therefore
    // deadlock, and Postgres aborts one of the two requests.
    const releasesOrders =
      dto.status === RouteRunStatus.CANCELLED || dto.status === RouteRunStatus.COMPLETED;

    const updated = releasesOrders
      ? await this.prisma.tenantTransaction(async (tx) => {
          const row = await tx.routeRun.update({ where: { id }, data: updates, include });
          const stops = await tx.routeRunStop.findMany({
            where: { routeRunId: id, status: { not: "COMPLETED" } },
            select: { id: true },
          });
          const stopIds = stops.map((s: { id: string }) => s.id);
          // Without this line the release is invisible: an operator asking
          // "why did these orders come off run X / reappear in dispatch?" has
          // nothing but a null pointer, indistinguishable from an order that
          // was never dispatched (same reason completeStop logs its withheld
          // auto-completion below).
          const { released } = await this.releaseUndeliveredOrders(tx, stopIds);
          if (released > 0) {
            this.logger.log(
              `updateRunStatus: run ${id} → ${dto.status} released ${released} undelivered order(s) ` +
                `from stop(s) ${stopIds.join(",")}.`,
            );
          }
          return row;
        })
      : await this.prisma.forTenant().routeRun.update({ where: { id }, data: updates, include });

    if (updated.driver) {
      this.gateway.emitDriverStatusUpdated(this.prisma.getTenantId(), {
        driverId: updated.driver.id,
        driverName: updated.driver.contactName ?? updated.driver.user?.username ?? "Driver",
        status: dto.status,
        updatedAt: new Date().toISOString(),
      });
    }

    return updated;
  }

  /**
   * F05 / R5 — the server's own cash truth for a run: CONFIRMED (PAID)
   * CASH/CHECK InvoicePayments billed to orders on this run (optionally
   * windowed to `paidAt >= startedAt`, so a driver's collections on a PRIOR
   * run against the same customer never bleed in) PLUS any AdvancePayment
   * booked from a driver's at-door over-collection on THIS run (B83 tags
   * those `RUN:<runId>:STOP:<stopId>` — see `recordDeliveryPaymentInTx`).
   * Never trust a client-supplied total — this is always server-computed.
   *
   * `client` lets a caller already inside a transaction (`completeStop` /
   * `completeWithPayment`'s RF-016 gate) pass its `tx` so a payment just
   * recorded earlier in THAT SAME transaction is visible here; every
   * out-of-transaction caller (`findOneRun`, `updateRunStatus`, `settleRun`,
   * the list enrichments) omits it and reads through `forTenant()`.
   */
  private async getRunCashCollections(
    runId: string,
    startedAt?: Date | null,
    client?: any,
  ): Promise<{ cashTotal: number; checkTotal: number; count: number }> {
    const db = client ?? this.prisma.forTenant();
    const [invoicePayments, advances] = await Promise.all([
      db.invoicePayment.findMany({
        where: {
          ...CONFIRMED_PAYMENT,
          method: { in: [PaymentMethod.CASH, PaymentMethod.CHECK] },
          invoice: { order: { routeRunId: runId } },
          ...(startedAt ? { paidAt: { gte: startedAt } } : {}),
        },
        select: { amount: true, method: true },
      }),
      db.advancePayment.findMany({
        where: {
          method: { in: [PaymentMethod.CASH, PaymentMethod.CHECK] },
          reference: { startsWith: `RUN:${runId}` },
          // B306: a reversed at-door over-collection (its door payments were
          // voided) no longer reflects real collected money.
          NOT: { reference: { endsWith: ":REVERSED" } },
        },
        select: { amount: true, method: true },
      }),
    ]);

    let cashTotal = 0;
    let checkTotal = 0;
    let count = 0;
    for (const p of [...invoicePayments, ...advances]) {
      const amt = Number((p as any).amount);
      if ((p as any).method === PaymentMethod.CASH) cashTotal = roundMoney(cashTotal + amt);
      else if ((p as any).method === PaymentMethod.CHECK) checkTotal = roundMoney(checkTotal + amt);
      count++;
    }
    return { cashTotal, checkTotal, count };
  }

  /**
   * F05 / R7 — physical money the driver is still carrying unreconciled for
   * this run: CASH **plus CHECK**, the same basis mobile's
   * `shouldForceSettlement` gates on (`lib/run-settlement.ts`). A cash-only
   * predicate would let a check-only run auto-complete before the driver ever
   * reached the settlement screen — the B152 gap again, just via CHECK.
   * Returns 0 once a settlement is already on record, so every gate
   * short-circuits without re-querying payments.
   */
  private async getUnsettledPhysicalMoney(
    runId: string,
    run: { startedAt?: Date | null; settlementNote?: string | null },
    client?: any,
  ): Promise<number> {
    if (run.settlementNote != null) return 0;
    const { cashTotal, checkTotal } = await this.getRunCashCollections(
      runId,
      run.startedAt,
      client,
    );
    return roundMoney(cashTotal + checkTotal);
  }

  /**
   * F11 (B129 / B211): a run going terminal releases the orders of every stop
   * that recorded no work, so createRun's sweep (`routeRunStopId: null`) and the
   * trip builder (`checkEligibility`) can re-collect them. Callers pass the ids
   * of stops whose status !== "COMPLETED" — the ONLY durable "work happened
   * here" marker: completeStop and completeWithPayment both write
   * stop.status = "COMPLETED" inside their own transaction, deliveries[] is
   * optional on both, so a deliveryMutation-existence predicate would release a
   * payment-only completion (the exact hole F05 found in deleteRun). Every
   * at-door payment therefore sits on a COMPLETED stop and is never in scope.
   *
   * Two writes, this order, both on the caller's tx client:
   *   1. OUT_FOR_DELIVERY → CONFIRMED, scoped to the released stops, BEFORE the
   *      unlink (the stop filter is lost once the pointer is null). Defensive:
   *      no run-lifecycle code writes OUT_FOR_DELIVERY, but an office-set one
   *      must be trip-eligible again (TRIP_ELIGIBLE_STATUSES excludes it).
   *   2. Null both pointers for orders whose status ∉ {DELIVERED, CANCELLED}.
   *
   * BOTH writes carry `routeRunStop: { status: { not: "COMPLETED" } }`: each
   * write re-checks the stop's status in the same statement, so a stop
   * completed between the caller's read and this write is excluded. Without it
   * the caller's `routeRunStop.findMany` and these writes are two statements
   * under READ COMMITTED, and a driver's completeWithPayment committing in that
   * window (it takes no run-row lock while other stops are still PENDING, so
   * RF-016 never fires) leaves the stop COMPLETED with its order
   * PARTIALLY_DELIVERED — a status that is NOT in the notIn list, so the unlink
   * would strip the pointers of an order the driver had just delivered and paid
   * for at the door: its cash drops out of getRunCashCollections'
   * `invoice.order.routeRunId` join and the order reappears as trip-eligible.
   * PARTIALLY_DELIVERED is deliberately NOT added to the notIn list — a
   * partially-delivered order on a genuinely non-completed stop must still
   * release. No FOR UPDATE is taken and the write order is unchanged; the
   * relation filter is the whole fix.
   *
   * A third write follows: every PENDING ChangeRequest on an order write 2
   * actually released is DECLINED. ChangeRequests are only created (and only
   * applied) while `order.routeRun.status === IN_PROGRESS`, so a released order
   * is back in the buyer's direct-edit window (`updateOrderItems` has no
   * pending-CR check) while its CR sits PENDING — on re-dispatch the driver
   * could approve it and apply the same items a second time. `updateMany`
   * returns no ids, so write 2's row set is read FIRST (same predicate) and
   * write 2 is then keyed by those ids as well as the predicate, which makes
   * the released set and the declined set provably the same rows. No
   * notification is sent (`notifyRequester` is a follow-up row) — this is a
   * system decline inside someone else's transaction, so the resolver identity
   * fields are left null.
   *
   * An office-recorded CONFIRMED CASH/CHECK InvoicePayment on such an order is
   * RELEASED, not refused (spec R15): getRunCashCollections joins through
   * invoice.order.routeRunId, so its attribution moves off the run by design —
   * the money was never collected at the door (that always COMPLETEs the stop),
   * and refusing would re-create the stranded order.
   *
   * TWO reports attribute through that pointer and BOTH shift by design:
   * getRunCashCollections (a run's expected cash, above) and
   * BookkeepingService.getSalesByDriver, which credits an invoice to the driver
   * of its order's CURRENT run and skips an order with no run — so EVERY
   * invoice on a released order (payment or not, not just the R15 edge) drops
   * out of Sales-by-Driver until a re-dispatch re-pins it, and the credit then
   * lands on the driver who actually delivers. Accepted, not worked around:
   * both reads have always followed the live pointer (a re-dispatch or a driver
   * reassignment already moved them), and a stop that recorded no work is the
   * proof this driver never delivered that order. Stop rows are kept as
   * history. Never route through OrdersService.changeStatus (own txs, gates,
   * notifications) and never wrap in a retry loop (only safe in a FRESH tx).
   */
  private async releaseUndeliveredOrders(
    tx: any,
    stopIds: string[],
  ): Promise<{ released: number }> {
    if (stopIds.length === 0) return { released: 0 };
    // Re-checked by EVERY statement below, never read once into a variable: a
    // stop the caller saw as non-COMPLETED can be COMPLETED by the time each
    // write runs.
    const stopStillOpen = { routeRunStop: { status: { not: "COMPLETED" } } };
    await tx.order.updateMany({
      where: {
        routeRunStopId: { in: stopIds },
        ...stopStillOpen,
        status: OrderStatus.OUT_FOR_DELIVERY,
      },
      data: { status: OrderStatus.CONFIRMED },
    });
    const releaseWhere = {
      routeRunStopId: { in: stopIds },
      ...stopStillOpen,
      status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
    };
    const releasedIds: string[] = (
      await tx.order.findMany({ where: releaseWhere, select: { id: true } })
    ).map((o: { id: string }) => o.id);
    const { count } = await tx.order.updateMany({
      where: { id: { in: releasedIds }, ...releaseWhere },
      data: { routeRunId: null, routeRunStopId: null },
    });
    if (releasedIds.length > 0) {
      await tx.changeRequest.updateMany({
        where: { orderId: { in: releasedIds }, status: ChangeRequestStatus.PENDING },
        data: {
          status: ChangeRequestStatus.DECLINED,
          resolution: "DECLINED",
          resolutionReason: RELEASED_CHANGE_REQUEST_REASON,
          resolvedAt: new Date(),
        },
      });
    }
    return { released: count };
  }

  /**
   * F05 / R5 — batched `collectedPayments` for a PAGE of driver-scoped runs
   * (`findAllRuns` when driver/`assignedToMe`-scoped, `findMyRuns` always).
   * ONE `invoicePayment.findMany` over every run's id plus one
   * `advancePayment.findMany` over their RUN-tagged references, bucketed per
   * run against THAT run's own `startedAt` — never N+1 (one
   * `getRunCashCollections` round-trip per run). Operator-wide lists never
   * call this.
   */
  private async enrichRunsWithCollectedPayments<
    T extends { id: string; startedAt?: Date | string | null },
  >(
    runs: T[],
  ): Promise<
    (T & { collectedPayments: { cashTotal: number; checkTotal: number; count: number } })[]
  > {
    if (runs.length === 0) return runs as any;
    const runIds = runs.map((r) => r.id);
    const [invoicePayments, advances] = await Promise.all([
      this.prisma.forTenant().invoicePayment.findMany({
        where: {
          ...CONFIRMED_PAYMENT,
          method: { in: [PaymentMethod.CASH, PaymentMethod.CHECK] },
          invoice: { order: { routeRunId: { in: runIds } } },
        },
        select: {
          amount: true,
          method: true,
          paidAt: true,
          invoice: { select: { order: { select: { routeRunId: true } } } },
        },
      }),
      this.prisma.forTenant().advancePayment.findMany({
        where: {
          method: { in: [PaymentMethod.CASH, PaymentMethod.CHECK] },
          OR: runIds.map((rid) => ({ reference: { startsWith: `RUN:${rid}` } })),
          // B306: a reversed at-door over-collection (its door payments were
          // voided) no longer reflects real collected money.
          NOT: { reference: { endsWith: ":REVERSED" } },
        },
        select: { amount: true, method: true, reference: true },
      }),
    ]);

    const startedAtByRun = new Map(
      runs.map((r) => [r.id, r.startedAt ? new Date(r.startedAt) : null]),
    );
    const buckets = new Map<string, { cashTotal: number; checkTotal: number; count: number }>();
    for (const id of runIds) buckets.set(id, { cashTotal: 0, checkTotal: 0, count: 0 });

    for (const p of invoicePayments as any[]) {
      const rid = p.invoice?.order?.routeRunId;
      const bucket = rid ? buckets.get(rid) : undefined;
      if (!bucket) continue;
      const startedAt = startedAtByRun.get(rid);
      if (startedAt && p.paidAt && new Date(p.paidAt) < startedAt) continue;
      const amt = Number(p.amount);
      if (p.method === PaymentMethod.CASH) bucket.cashTotal = roundMoney(bucket.cashTotal + amt);
      else if (p.method === PaymentMethod.CHECK)
        bucket.checkTotal = roundMoney(bucket.checkTotal + amt);
      bucket.count++;
    }
    for (const a of advances as any[]) {
      const rid = runIds.find((id) => (a.reference ?? "").startsWith(`RUN:${id}`));
      const bucket = rid ? buckets.get(rid) : undefined;
      if (!bucket) continue;
      const amt = Number(a.amount);
      if (a.method === PaymentMethod.CASH) bucket.cashTotal = roundMoney(bucket.cashTotal + amt);
      else if (a.method === PaymentMethod.CHECK)
        bucket.checkTotal = roundMoney(bucket.checkTotal + amt);
      bucket.count++;
    }

    return runs.map((r) => ({ ...r, collectedPayments: buckets.get(r.id)! }));
  }

  /**
   * F05 / R6 — POST /route-runs/:id/settlement. A NEW endpoint (never a
   * retrofit of `PATCH :id`, which shipped mobile builds still use to PATCH
   * `notes` mid-deploy-skew). Records a driver's or operator's end-of-run
   * cash/check reconciliation into the dedicated `settlementNote` /
   * `settlementVariance` columns — `run.notes` is never touched. The
   * server computes `expected` itself via `getRunCashCollections`; a
   * client-supplied total is never trusted.
   */
  async settleRun(id: string, dto: SettleRunDto, user: JwtPayload): Promise<any> {
    const run = await this.prisma.forTenant().routeRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException("Route run not found");

    // R6 accepts IN_PROGRESS (the driver's own end-of-run flow), COMPLETED (an
    // operator's post-hoc correction) and CANCELLED — nothing else. Settling a
    // run that never started is a $0 no-op that still writes `settlementNote`,
    // which would permanently disarm R7's gates for every collection made
    // afterwards.
    //
    // CANCELLED is accepted deliberately (Fable final pass, 2026-08-31). A run
    // cancelled mid-route — a breakdown after five paid stops — still has the
    // driver's cash in the truck, and R7 gates only the COMPLETED transition,
    // so the cancel itself is not blocked here. Refusing to settle afterwards
    // would strand that money: unreconcilable forever, invisible on every
    // settlement surface. Post-hoc reconciliation is the whole point, and the
    // web Settlement card already renders for every status.
    //
    // ⚠️ Gating the CANCEL path itself (and `deleteRun`, whose only guard is an
    // existing deliveryMutation — which a payment-only completion never
    // creates) belongs to F11 "Run cancel and skip reconciliation", which owns
    // those transitions by charter and is next in this lane. See the F05
    // close-out handoff.
    if (
      run.status !== RouteRunStatus.IN_PROGRESS &&
      run.status !== RouteRunStatus.COMPLETED &&
      run.status !== RouteRunStatus.CANCELLED
    ) {
      throw new BadRequestException(
        "Cannot settle a route run that has not started — start the run first.",
      );
    }

    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) {
        throw new ForbiddenException("You can only settle your own route runs");
      }
      // A driver settles once; only an operator may amend/overwrite an
      // existing settlement (e.g. after a dispute or a counting correction).
      // Coded so a client whose settle response was lost can tell "your write
      // already landed" apart from a real refusal and carry on to the COMPLETED
      // flip instead of dead-ending on the settlement screen.
      if (run.settlementNote != null) {
        throw new BadRequestException({
          code: "RUN_ALREADY_SETTLED",
          message: "This run has already been settled. Ask an operator to amend it.",
        });
      }
    }

    // The reconciliation basis is the PHYSICAL money the driver carries —
    // cash AND checks. `getRunCashCollections` keeps the two split for
    // reporting; every settlement comparison uses their sum, matching the
    // mobile screen's "Cash & checks to reconcile" line, its device-local
    // `summarizeCollections().cashTotal`, and `shouldForceSettlement`.
    const expected = await this.getRunCashCollections(id, run.startedAt);
    const expectedPhysical = roundMoney(expected.cashTotal + expected.checkTotal);
    const variance = roundMoney(dto.countedCash - expectedPhysical);
    if (Math.abs(variance) > 0.01 && !dto.varianceReason) {
      throw new BadRequestException(
        "Counted cash does not match the expected amount — a varianceReason is required.",
      );
    }

    const when = new Date();
    const sign = variance < 0 ? "-" : "+";
    const noteLines = [
      `Settlement recorded by ${user.username} at ${when.toISOString()}`,
      `Expected (cash + checks): $${expectedPhysical.toFixed(2)}`,
      `Counted: $${dto.countedCash.toFixed(2)}`,
      `Variance: ${sign}$${Math.abs(variance).toFixed(2)}`,
    ];
    if (dto.varianceReason) noteLines.push(`Reason: ${dto.varianceReason}`);

    const updated = await this.prisma.forTenant().routeRun.update({
      where: { id },
      data: { settlementNote: noteLines.join("\n"), settlementVariance: variance },
    });

    return {
      ...updated,
      expectedCash: expectedPhysical,
      countedCash: dto.countedCash,
      variance,
    };
  }

  async updateStopStatus(
    runId: string,
    stopId: string,
    dto: { status: "IN_PROGRESS" | "SKIPPED"; driverNote?: string },
    user: JwtPayload,
  ) {
    const stop = await this.prisma.forTenant().routeRunStop.findFirst({
      where: { id: stopId, routeRunId: runId },
    });
    if (!stop) throw new NotFoundException("Stop not found");

    const run = await this.prisma
      .forTenant()
      .routeRun.findFirst({ where: { id: runId }, select: { driverId: true, status: true } });
    if (!run) throw new NotFoundException("Route run not found");

    // B72: OWNERSHIP FIRST, then state — same ordering as updateRunStatus and
    // attachPodArtifact. A driver with no claim on this run must not learn from
    // the error whether the stop is completed or the run cancelled.
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) {
        throw new ForbiddenException("You do not have access to this route run");
      }
    }

    // B71: COMPLETED is exited only via reopenStop — it reverses the delivery's
    // mutations, stock-truth and payment guard; flipping the column here would
    // strand those side effects and blind the delivered-order demotion guard,
    // which keys on stop.status === COMPLETED.
    if (stop.status === "COMPLETED") {
      throw new ConflictException(
        "This stop is completed. Reopen it instead — that reverses the delivery correctly.",
      );
    }

    if (run.status === RouteRunStatus.COMPLETED || run.status === RouteRunStatus.CANCELLED) {
      throw new ConflictException(`Cannot change a stop on a ${run.status.toLowerCase()} run.`);
    }

    const updates: any = { status: dto.status };
    if (dto.driverNote !== undefined) updates.driverNote = dto.driverNote;
    if (dto.status === "IN_PROGRESS" && !stop.arrivedAt) updates.arrivedAt = new Date();

    return this.prisma.forTenant().routeRunStop.update({ where: { id: stopId }, data: updates });
  }

  // ── RF-019: Idempotency helpers ───────────────────────────────────────────
  // Uses raw SQL so the feature works before the IdempotencyKey table migration
  // is applied — queries are wrapped in try/catch and fail silently if the table
  // does not yet exist.

  private makeKeyHash(key: string, scope: string): string {
    return createHash("sha256").update(`${scope}:${key}`).digest("hex");
  }

  private async checkIdempotencyKey(key: string, scope: string): Promise<unknown> {
    const hash = this.makeKeyHash(key, scope);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    try {
      const rows = await this.prisma.$queryRaw<{ response: string }[]>`
        SELECT response FROM "IdempotencyKey"
        WHERE "keyHash" = ${hash} AND "createdAt" >= ${cutoff}
        LIMIT 1
      `;
      if (!rows || rows.length === 0) return null;
      return JSON.parse(rows[0].response);
    } catch {
      return null; // table doesn't exist yet — degrade gracefully
    }
  }

  private async saveIdempotencyKey(key: string, scope: string, response: unknown): Promise<void> {
    const hash = this.makeKeyHash(key, scope);
    try {
      const responseJson = JSON.stringify(response);
      await this.prisma.$executeRaw`
        INSERT INTO "IdempotencyKey" ("id", "keyHash", "response", "createdAt")
        VALUES (gen_random_uuid(), ${hash}, ${responseJson}, now())
        ON CONFLICT ("keyHash") DO UPDATE
          SET response   = EXCLUDED.response,
              "createdAt" = now()
      `;
    } catch {
      // best-effort — don't fail the request if idempotency storage errors
    }
  }

  // ── Durable proof-of-delivery artifacts ────────────────────────────────
  // POD photos/signatures arrive as data URLs inside plain JSON (never
  // multipart — FormData is excluded from the mobile offline queue) and are
  // ingested into storage under tenants/<tenantId>/pod/<stopId>/; the
  // existing RouteRunStop columns then hold storage keys. Legacy strings
  // (file:// URIs, the old "native-captured" sentinel) pass through
  // unchanged so not-yet-updated driver builds keep completing stops.

  /** Tenant id for POD storage keys — every POD caller is a tenant-scoped request. */
  private requireTenantId(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new ForbiddenException("Tenant context required");
    return tenantId;
  }

  /**
   * Rasterize + store one data-URL artifact; returns the storage key, or null
   * when the value isn't an ingestable image data URL OR the rasterize fails —
   * on failure the caller keeps the original data URL, which is still durable
   * and renderable by the web client (just larger than a stored file).
   */
  private async ingestPodDataUrl(
    value: string,
    stopId: string,
    kind: PodArtifactKind,
    artifactId?: string,
  ): Promise<string | null> {
    const parsed = parseImageDataUrl(value);
    if (!parsed) return null;
    try {
      const compressed = await compressImage(
        parsed.buffer,
        parsed.mimeType,
        kind === "signature" ? 1000 : 1600,
      );
      const key = podArtifactKey(
        this.requireTenantId(),
        stopId,
        kind,
        artifactId ?? randomUUID(),
        compressed.ext,
      );
      await this.storage.upload(key, compressed.buffer, compressed.mimeType);
      return key;
    } catch (e) {
      this.logger.warn(
        `POD ${kind} ingest failed for stop ${stopId}: ${(e as Error)?.message ?? e}`,
      );
      return null;
    }
  }

  /** Rewrite a completion payload's data-URL artifacts to storage keys in place. */
  private async ingestPodCapture(
    dto: { signatureUrl?: string; podPhotoUrls?: string[] },
    stopId: string,
  ): Promise<void> {
    if (dto.signatureUrl) {
      const key = await this.ingestPodDataUrl(dto.signatureUrl, stopId, "signature");
      if (key) dto.signatureUrl = key;
    }
    if (dto.podPhotoUrls?.length) {
      const rewritten: string[] = [];
      for (const value of dto.podPhotoUrls) {
        const key = await this.ingestPodDataUrl(value, stopId, "photo");
        rewritten.push(key ?? value);
      }
      dto.podPhotoUrls = rewritten;
    }
  }

  /**
   * Attach one POD artifact to a run stop, before OR after completion (the
   * driver app uploads photos right before firing the completion; an offline
   * queue replays them in the same order). Idempotent per artifactId so a
   * replay whose response was lost never duplicates a photo.
   */
  async attachPodArtifact(
    runId: string,
    stopId: string,
    dto: AttachPodArtifactDto,
    user: JwtPayload,
  ) {
    const run = await this.prisma.forTenant().routeRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException("Route run not found");
    const stop = await this.prisma
      .forTenant()
      .routeRunStop.findFirst({ where: { id: stopId, routeRunId: runId } });
    if (!stop) throw new NotFoundException("Stop not found");

    // B121: same driver binding as reopenStop/updateStopStatus — checked before
    // the idempotent read so another driver's replay cannot read the stored
    // artifact either.
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) {
        throw new ForbiddenException("You do not have access to this route run");
      }
    }

    if (!parseImageDataUrl(dto.dataUrl)) {
      throw new BadRequestException("dataUrl must be a data:image/... URL");
    }

    const tenantId = this.requireTenantId();
    const artifactId = dto.artifactId ?? randomUUID();
    const marker = `/${dto.kind}-${artifactId}.`;
    const existing =
      dto.kind === "photo"
        ? (stop.podPhotoUrls ?? []).find((k) => isPodStorageKey(k, tenantId) && k.includes(marker))
        : stop.signatureUrl &&
            isPodStorageKey(stop.signatureUrl, tenantId) &&
            stop.signatureUrl.includes(marker)
          ? stop.signatureUrl
          : undefined;
    if (existing) {
      return { key: existing, url: await this.storage.presignedUrl(existing) };
    }

    // B121: the signature that satisfied the regulated-delivery gate is
    // immutable once the stop is COMPLETED — a different artifact may not
    // replace it (the same-artifactId offline replay returned above). Photos
    // stay appendable; reopenStop is the sanctioned path to re-capture.
    if (
      dto.kind === "signature" &&
      stop.status === "COMPLETED" &&
      (stop.signatureUrl ?? "").trim().length > 0
    ) {
      throw new ConflictException(
        "This completed stop already has a signature. Reopen the stop to re-capture it.",
      );
    }

    const key = await this.ingestPodDataUrl(dto.dataUrl, stopId, dto.kind, artifactId);
    if (!key) throw new BadRequestException("File is not a decodable image");

    await this.prisma.forTenant().routeRunStop.update({
      where: { id: stopId },
      data: dto.kind === "photo" ? { podPhotoUrls: { push: key } } : { signatureUrl: key },
    });
    return { key, url: await this.storage.presignedUrl(key) };
  }

  /**
   * Retrievable POD for one stop: presigned URLs for stored artifacts, data
   * URLs passed through, legacy strings surfaced only as counts/flags so the
   * web UI can say "captured by an older app version" instead of lying.
   */
  async getStopPod(runId: string, stopId: string, user: JwtPayload) {
    const stop = await this.prisma
      .forTenant()
      .routeRunStop.findFirst({ where: { id: stopId, routeRunId: runId } });
    if (!stop) throw new NotFoundException("Stop not found");

    // B121: POD is regulated-delivery evidence and personal data (the customer's
    // signature) — bind the read to the run's CURRENT driver exactly as
    // attachPodArtifact binds the write, otherwise a driver whose run was
    // reassigned keeps presigning its signature/photos indefinitely.
    if (user.role === UserRole.DRIVER) {
      const run = await this.prisma
        .forTenant()
        .routeRun.findFirst({ where: { id: runId }, select: { driverId: true } });
      if (!run) throw new NotFoundException("Route run not found");
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) {
        throw new ForbiddenException("You do not have access to this route run");
      }
    }

    const tenantId = this.requireTenantId();
    const photos: { url: string }[] = [];
    let legacyPhotoCount = 0;
    for (const value of stop.podPhotoUrls ?? []) {
      if (isPodStorageKey(value, tenantId)) {
        photos.push({ url: await this.storage.presignedUrl(value) });
      } else if (isRenderableDataUrl(value)) {
        photos.push({ url: value });
      } else {
        legacyPhotoCount++;
      }
    }

    const sig = (stop.signatureUrl ?? "").trim();
    const signatureUrl = isPodStorageKey(sig, tenantId)
      ? await this.storage.presignedUrl(sig)
      : isRenderableDataUrl(sig)
        ? sig
        : null;

    return {
      photos,
      legacyPhotoCount,
      signatureUrl,
      signatureCaptured: sig.length > 0,
      driverNote: stop.driverNote ?? null,
      completedAt: stop.completedAt ?? null,
      ageCheckRequired: stop.ageCheckRequired,
      ageVerified: stop.ageVerified,
      identityCheckRequired: stop.identityCheckRequired,
      identityVerified: stop.identityVerified,
      identityType: stop.identityType ?? null,
    };
  }

  async completeStop(
    runId: string,
    stopId: string,
    dto: CompleteStopDto & { idempotencyKey?: string },
    user: JwtPayload,
  ) {
    // RF-003: fetch the parent run first and reject if it hasn't been started.
    // Previously completeStop() accepted stops on SCHEDULED runs, letting
    // drivers mark deliveries done without ever dispatching the run.
    const run = await this.prisma.forTenant().routeRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException("Route run not found");
    if (run.status !== RouteRunStatus.IN_PROGRESS) {
      throw new ForbiddenException(
        `Cannot complete a stop on a run that is not in progress (current status: ${run.status}).`,
      );
    }

    const stop = await this.prisma.forTenant().routeRunStop.findFirst({
      where: { id: stopId, routeRunId: runId },
      include: {
        orders: {
          select: { id: true, status: true, customerId: true, orderNumber: true, total: true },
        },
      },
    });
    if (!stop) throw new NotFoundException("Stop not found");
    if (stop.status === "COMPLETED") throw new BadRequestException("Stop is already completed");

    const driver =
      user.role === UserRole.DRIVER
        ? await this.prisma.forTenant().driver.findFirst({ where: { userId: user.sub } })
        : null;
    // B72: a driver may only complete stops on a run assigned to them — checked
    // before the idempotency read and POD ingest so a hijacker's capture is
    // never stored.
    if (user.role === UserRole.DRIVER && (!driver || run.driverId !== driver.id)) {
      throw new ForbiddenException("You do not have access to this route run");
    }

    // RF-019: Idempotency check (outside transaction for speed)
    if (dto.idempotencyKey) {
      const scope = `completeStop:${runId}:${stopId}`;
      const cached = await this.checkIdempotencyKey(dto.idempotencyKey, scope);
      if (cached) return cached;
    }

    // Durable POD: rewrite data-URL artifacts to storage keys before the tx
    // (after the idempotency check so a cached replay never re-uploads).
    await this.ingestPodCapture(dto, stopId);

    let autoCompleted = false;
    await this.prisma.tenantTransaction(async (tx) => {
      // Phase 4 (W7b): regulated-delivery POD gate. Re-derive the age/ID
      // requirement from the stop's current orders (authoritative — orders can be
      // linked after dispatch), then block a regulated completion that lacks the
      // required checks / signature / hands it to a safe-drop, and normalise the
      // captured values onto the stop.
      const db = tx as unknown as RegulatedDeliveryDb;
      const sets = await loadAgeIdCategorySets(db);
      const requirements = await deriveStopRegulatedRequirements(
        db,
        { stopId, orderItemIds: dto.deliveries?.map((d) => d.orderItemId) },
        sets,
      );
      const regulatedPatch = assertRegulatedDeliverySatisfied({
        requirements,
        capture: dto,
        existingSignatureUrl: stop.signatureUrl,
      });

      // 1. Mark stop completed
      await tx.routeRunStop.update({
        where: { id: stopId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          ...(dto.driverNote !== undefined ? { driverNote: dto.driverNote } : {}),
          ...(dto.podPhotoUrls ? { podPhotoUrls: dto.podPhotoUrls } : {}),
          ...(dto.signatureUrl !== undefined ? { signatureUrl: dto.signatureUrl } : {}),
          ...(dto.safeDropEnabled !== undefined ? { safeDropEnabled: dto.safeDropEnabled } : {}),
          ...regulatedPatch,
        },
      });

      // 2. Record delivery mutations if provided
      if (dto.deliveries && dto.deliveries.length > 0) {
        for (const d of dto.deliveries) {
          const item = await tx.orderItem.findFirst({
            where: { id: d.orderItemId },
            select: { orderId: true, productId: true, unitPrice: true },
          });
          if (!item) continue;
          await tx.deliveryMutation.create({
            data: {
              orderId: item.orderId,
              orderItemId: d.orderItemId,
              // B148/R3: `DeliveryMutation.productId` is a real Product FK, so
              // it comes from the tenant-scoped order item — never verbatim
              // from the body. A stale/blank/foreign client id would either
              // blow up the whole completion transaction on the FK or park a
              // cross-tenant reference the owning tenant's product purge can
              // never see. Unlisted (free-text) lines have no product: null.
              productId: item.productId ?? null,
              routeRunStopId: stopId,
              ...(driver ? { driverId: driver.id } : {}),
              type: (d.type as any) ?? "DELIVERED",
              quantityDelivered: d.quantityDelivered,
              ...(d.note ? { note: d.note } : {}),
            },
          });
        }
      }

      // 3. Mark linked orders as DELIVERED
      const orderIds = stop.orders.map((o) => o.id);
      if (orderIds.length > 0) {
        await tx.order.updateMany({
          where: {
            id: { in: orderIds },
            status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELIVERED] },
          },
          data: { status: OrderStatus.DELIVERED },
        });
      }

      // RF-016: Auto-complete run when last stop is done
      const allStops = await tx.routeRunStop.findMany({
        where: { routeRunId: runId },
        select: { id: true, status: true },
      });
      const allDone = allStops.every(
        (s: any) => s.id === stopId || s.status === "COMPLETED" || s.status === "SKIPPED",
      );
      if (allDone) {
        // R7b / B152: same cash-settlement gate as updateRunStatus's backstop,
        // but here because RF-016 bypasses updateRunStatus entirely on the
        // common path (last stop closes -> auto-complete). Read via `tx` so a
        // payment recorded earlier in THIS transaction is visible. Leaves the
        // run IN_PROGRESS — the driver lands on settle-then-complete instead.
        const outstanding = await this.getUnsettledPhysicalMoney(runId, run, tx);
        if (outstanding > 0.001) {
          // Withholding the auto-completion is otherwise invisible —
          // `autoCompleted: false` has no client consumer, so without this line
          // an operator asking "every stop is done, why is the run still open?"
          // finds nothing in the logs.
          this.logger.log(
            `completeStop: RF-016 auto-completion withheld for run ${runId} (stop ${stopId}) — ` +
              `$${outstanding.toFixed(2)} in cash/checks is unsettled.`,
          );
        } else {
          await tx.routeRun.update({
            where: { id: runId },
            data: { status: RouteRunStatus.COMPLETED, completedAt: new Date() },
          });
          // F11 / B211: the run is COMPLETED now — release the orders of the
          // stops that recorded no work (the SKIPPED ones; allDone already
          // excluded PENDING/IN_PROGRESS). `allStops` was read after THIS
          // stop's COMPLETED write, so `id !== stopId` is a second guard for a
          // snapshot that still shows it PENDING. A withheld auto-completion
          // (the `if` branch above) releases nothing — the run is still open.
          const releasedStopIds = allStops
            .filter((s: any) => s.id !== stopId && s.status !== "COMPLETED")
            .map((s: any) => s.id);
          const { released } = await this.releaseUndeliveredOrders(tx, releasedStopIds);
          if (released > 0) {
            // Logged for the same reason as the withheld branch above: once the
            // pointers are null nothing else records that this run released
            // them.
            this.logger.log(
              `completeStop: RF-016 auto-completion of run ${runId} released ${released} ` +
                `undelivered order(s) from stop(s) ${releasedStopIds.join(",")}.`,
            );
          }
          autoCompleted = true;
        }
      }
    });

    // P6-5: DELIVERED per order this completion flipped (driver bypasses
    // changeStatus). AFTER the tx, fire-and-forget; skip already CANCELLED/DELIVERED.
    for (const o of stop.orders) {
      if (o.status === OrderStatus.CANCELLED || o.status === OrderStatus.DELIVERED) continue;
      this.messaging
        .notifyEvent(NotificationEvent.DELIVERED, {
          customerId: o.customerId,
          senderId: user.sub || null,
          vars: { orderNumber: o.orderNumber ?? "", orderTotal: formatMoney(o.total) },
        })
        .catch(() => {});
    }

    if (autoCompleted) {
      const completed = await this.prisma.forTenant().routeRun.findUnique({
        where: { id: runId },
        include: {
          driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
        },
      });
      if (completed?.driver) {
        this.gateway.emitDriverStatusUpdated(this.prisma.getTenantId(), {
          driverId: completed.driver.id,
          driverName: completed.driver.contactName ?? completed.driver.user?.username ?? "Driver",
          status: RouteRunStatus.COMPLETED,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const result = await this.prisma
      .forTenant()
      .routeRunStop.findUniqueOrThrow({ where: { id: stopId } });

    // RF-019: persist idempotency key after successful write
    if (dto.idempotencyKey) {
      const scope = `completeStop:${runId}:${stopId}`;
      await this.saveIdempotencyKey(dto.idempotencyKey, scope, result);
    }

    return result;
  }

  /**
   * RF-005: Atomic complete + payment endpoint.
   * POST /route-runs/:runId/stops/:stopId/complete-with-payment
   * Both the stop completion and invoice payment land in one transaction so
   * neither can succeed without the other.
   */
  async completeWithPayment(
    runId: string,
    stopId: string,
    dto: CompleteWithPaymentDto & { idempotencyKey?: string },
    user: JwtPayload,
  ) {
    const run = await this.prisma.forTenant().routeRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException("Route run not found");
    if (run.status !== RouteRunStatus.IN_PROGRESS) {
      throw new ForbiddenException(
        `Cannot complete a stop on a run that is not in progress (current status: ${run.status}).`,
      );
    }

    const stop = await this.prisma.forTenant().routeRunStop.findFirst({
      where: { id: stopId, routeRunId: runId },
      include: {
        orders: {
          select: { id: true, status: true, customerId: true, orderNumber: true, total: true },
        },
      },
    });
    if (!stop) throw new NotFoundException("Stop not found");
    if (stop.status === "COMPLETED") throw new BadRequestException("Stop is already completed");

    const driver =
      user.role === UserRole.DRIVER
        ? await this.prisma.forTenant().driver.findFirst({ where: { userId: user.sub } })
        : null;
    // B72: a driver may only complete stops on a run assigned to them — checked
    // before the idempotency read and POD ingest so a hijacker's capture is
    // never stored.
    if (user.role === UserRole.DRIVER && (!driver || run.driverId !== driver.id)) {
      throw new ForbiddenException("You do not have access to this route run");
    }

    // RF-006: reject physical-money payment with zero amount
    if (dto.payment && dto.payment.amount <= 0) {
      const physicalMethods = ["CASH", "CHECK", "CREDIT_CARD"];
      if (physicalMethods.includes(dto.payment.method.toUpperCase())) {
        throw new BadRequestException(
          `Payment amount must be greater than 0 for ${dto.payment.method} payments.`,
        );
      }
    }

    // RF-019: Idempotency check
    if (dto.idempotencyKey) {
      const scope = `completeWithPayment:${runId}:${stopId}`;
      const cached = await this.checkIdempotencyKey(dto.idempotencyKey, scope);
      if (cached) return cached;
    }

    // Durable POD: rewrite data-URL artifacts to storage keys before the tx
    // (after the idempotency check so a cached replay never re-uploads).
    await this.ingestPodCapture(dto, stopId);

    let autoCompleted = false;
    let paymentIds: string[] = [];
    // B83: over-collection additively surfaced on the response (undefined when
    // no payment was collected this completion — no payment call, no fields).
    let excess: number | undefined;
    let advancePaymentId: string | null | undefined;
    await this.prisma.tenantTransaction(async (tx) => {
      // Phase 4 (W7b): regulated-delivery POD gate (same as completeStop).
      const db = tx as unknown as RegulatedDeliveryDb;
      const sets = await loadAgeIdCategorySets(db);
      const requirements = await deriveStopRegulatedRequirements(
        db,
        { stopId, orderItemIds: dto.deliveries?.map((d) => d.orderItemId) },
        sets,
      );
      const regulatedPatch = assertRegulatedDeliverySatisfied({
        requirements,
        capture: dto,
        existingSignatureUrl: stop.signatureUrl,
      });

      // 1. Mark stop completed
      await tx.routeRunStop.update({
        where: { id: stopId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          ...(dto.driverNote !== undefined ? { driverNote: dto.driverNote } : {}),
          ...(dto.podPhotoUrls ? { podPhotoUrls: dto.podPhotoUrls } : {}),
          ...(dto.signatureUrl !== undefined ? { signatureUrl: dto.signatureUrl } : {}),
          ...(dto.safeDropEnabled !== undefined ? { safeDropEnabled: dto.safeDropEnabled } : {}),
          ...regulatedPatch,
        },
      });

      // 2. Record delivery mutations. Track which orders were actually delivered
      // in THIS completion — only they may be reconciled to the delivered basis
      // below. An order merely linked to the stop but not delivered here (e.g. one
      // the office already marked DELIVERED) keeps its existing invoice; reconciling
      // it against a deliveredQty of 0 would wrongly zero its open draft.
      const deliveredOrderIdSet = new Set<string>();
      if (dto.deliveries && dto.deliveries.length > 0) {
        for (const d of dto.deliveries) {
          const item = await tx.orderItem.findFirst({
            where: { id: d.orderItemId },
            select: { orderId: true, productId: true },
          });
          if (!item) continue;
          deliveredOrderIdSet.add(item.orderId);
          await tx.deliveryMutation.create({
            data: {
              orderId: item.orderId,
              orderItemId: d.orderItemId,
              // B148/R3: from the tenant-scoped order item, never verbatim from
              // the body — see the completeStop create site for why.
              productId: item.productId ?? null,
              routeRunStopId: stopId,
              ...(driver ? { driverId: driver.id } : {}),
              type: (d.type as any) ?? "DELIVERED",
              quantityDelivered: d.quantityDelivered,
            },
          });
          // Record the delivered qty so a payment-path invoice bills what was
          // actually delivered (short/refused lines don't over-bill). Consumed by
          // recordDeliveryPaymentInTx → reconcileOrderDraftInvoice(basis:"delivered").
          await tx.orderItem.update({
            where: { id: d.orderItemId },
            data: { deliveredQty: (d.type as any) === "REFUSED" ? 0 : d.quantityDelivered },
          });
        }
      }

      // 3. Mark linked orders as DELIVERED
      const orderIds = stop.orders.map((o) => o.id);
      if (orderIds.length > 0) {
        await tx.order.updateMany({
          where: {
            id: { in: orderIds },
            status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELIVERED] },
          },
          data: { status: OrderStatus.DELIVERED },
        });
      }

      // 4. Record payment (atomic with stop completion — RF-005). The invoice is
      // resolved SERVER-side from the delivered orders — the mobile client cannot
      // supply an invoiceId (Order has no invoiceId scalar), so the old
      // client-invoiceId path silently recorded nothing. This ensures a finalized
      // invoice exists and records the payment the canonical way (InvoicePayment
      // + recomputeStatus over non-VOID sums).
      if (dto.payment && dto.payment.amount > 0) {
        const deliveredOrderIds = stop.orders
          .filter((o) => o.status !== OrderStatus.CANCELLED)
          .map((o) => o.id);
        const recorded = await this.invoicesService.recordDeliveryPaymentInTx(
          tx,
          deliveredOrderIds,
          dto.payment.amount,
          dto.payment.method,
          Array.from(deliveredOrderIdSet),
          { runId, stopId },
        );
        paymentIds = recorded.paymentIds;
        excess = recorded.excess;
        advancePaymentId = recorded.advancePaymentId;
        if (advancePaymentId) {
          this.logger.log(
            `completeWithPayment: ${excess} over-collection booked to advance ${advancePaymentId} (run ${runId}, stop ${stopId})`,
          );
        } else if (recorded.applied + 0.005 < dto.payment.amount) {
          this.logger.warn(
            `completeWithPayment: collected ${dto.payment.amount} but only ${recorded.applied} applied to ` +
              `invoices for orders ${deliveredOrderIds.join(",")} (remainder unrecorded).`,
          );
        }
      }

      // 5. RF-016: Auto-complete run when last stop is done
      const allStops = await tx.routeRunStop.findMany({
        where: { routeRunId: runId },
        select: { id: true, status: true },
      });
      const allDone = allStops.every(
        (s: any) => s.id === stopId || s.status === "COMPLETED" || s.status === "SKIPPED",
      );
      if (allDone) {
        // R7b / B152: same cash-settlement gate as updateRunStatus's backstop,
        // but here because RF-016 bypasses updateRunStatus entirely on the
        // common path (last stop closes -> auto-complete). Read via `tx` so a
        // payment recorded earlier in THIS transaction is visible. Leaves the
        // run IN_PROGRESS — the driver lands on settle-then-complete instead.
        const outstanding = await this.getUnsettledPhysicalMoney(runId, run, tx);
        if (outstanding > 0.001) {
          // See completeStop's gate: without this the withheld completion
          // leaves no trace at all in the logs.
          this.logger.log(
            `completeWithPayment: RF-016 auto-completion withheld for run ${runId} (stop ${stopId}) — ` +
              `$${outstanding.toFixed(2)} in cash/checks is unsettled.`,
          );
        } else {
          await tx.routeRun.update({
            where: { id: runId },
            data: { status: RouteRunStatus.COMPLETED, completedAt: new Date() },
          });
          // F11 / B211: the run is COMPLETED now — release the orders of the
          // stops that recorded no work (the SKIPPED ones; allDone already
          // excluded PENDING/IN_PROGRESS). `allStops` was read after THIS
          // stop's COMPLETED write, so `id !== stopId` is a second guard for a
          // snapshot that still shows it PENDING. A withheld auto-completion
          // (the `if` branch above) releases nothing — the run is still open.
          const releasedStopIds = allStops
            .filter((s: any) => s.id !== stopId && s.status !== "COMPLETED")
            .map((s: any) => s.id);
          const { released } = await this.releaseUndeliveredOrders(tx, releasedStopIds);
          if (released > 0) {
            // Logged for the same reason as the withheld branch above: once the
            // pointers are null nothing else records that this run released
            // them.
            this.logger.log(
              `completeWithPayment: RF-016 auto-completion of run ${runId} released ${released} ` +
                `undelivered order(s) from stop(s) ${releasedStopIds.join(",")}.`,
            );
          }
          autoCompleted = true;
        }
      }
    });

    // P6-5: DELIVERED per order this completion flipped (driver bypasses
    // changeStatus). AFTER the tx, fire-and-forget; skip already CANCELLED/DELIVERED.
    for (const o of stop.orders) {
      if (o.status === OrderStatus.CANCELLED || o.status === OrderStatus.DELIVERED) continue;
      this.messaging
        .notifyEvent(NotificationEvent.DELIVERED, {
          customerId: o.customerId,
          senderId: user.sub || null,
          vars: { orderNumber: o.orderNumber ?? "", orderTotal: formatMoney(o.total) },
        })
        .catch(() => {});
    }

    if (autoCompleted) {
      const completed = await this.prisma.forTenant().routeRun.findUnique({
        where: { id: runId },
        include: {
          driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
        },
      });
      if (completed?.driver) {
        this.gateway.emitDriverStatusUpdated(this.prisma.getTenantId(), {
          driverId: completed.driver.id,
          driverName: completed.driver.contactName ?? completed.driver.user?.username ?? "Driver",
          status: RouteRunStatus.COMPLETED,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const result = await this.prisma
      .forTenant()
      .routeRunStop.findUniqueOrThrow({ where: { id: stopId } });

    // Additive: ids of the InvoicePayment row(s) created in step 4 (empty when no
    // payment was collected). Consumed by the driver app to attach a best-effort
    // payment photo to paymentIds[0] after the stop completes.
    const response = { ...result, paymentIds, excess, advancePaymentId };

    // RF-019: persist idempotency key
    if (dto.idempotencyKey) {
      const scope = `completeWithPayment:${runId}:${stopId}`;
      await this.saveIdempotencyKey(dto.idempotencyKey, scope, response);
    }

    return response;
  }

  async getRunPackingList(runId: string) {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id: runId },
      include: {
        stops: {
          include: {
            customer: {
              select: {
                id: true,
                businessName: true,
                deliveryWindowStart: true,
                deliveryWindowEnd: true,
              },
            },
            customerAddress: true,
            orders: {
              where: { status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELIVERED] } },
              include: {
                lineItems: {
                  include: { product: { select: { id: true, name: true, sku: true } } },
                },
              },
            },
            routeStop: {
              include: {
                customer: {
                  select: {
                    id: true,
                    businessName: true,
                    deliveryWindowStart: true,
                    deliveryWindowEnd: true,
                  },
                },
                customerAddress: true,
              },
            },
          },
          orderBy: { stopNumber: "asc" },
        },
      },
    });
    if (!run) throw new NotFoundException("Route run not found");

    // Normalise stops: fall back to routeStop customer/address for legacy/seeded runs
    let stops: any[] = run.stops.map((s: any) => ({
      ...s,
      customer: s.customer ?? s.routeStop?.customer ?? null,
      customerAddress: s.customerAddress ?? s.routeStop?.customerAddress ?? null,
      _resolvedCustomerId: s.customerId ?? s.routeStop?.customerId ?? null,
    }));

    // Fallback for unlinked orders (legacy/seeded data — same logic as findOneRun)
    const anyLinked = stops.some((s: any) => (s.orders as any[]).length > 0);
    if (!anyLinked && stops.length > 0) {
      const customerIds = stops
        .map((s: any) => s._resolvedCustomerId)
        .filter((cid: string | null): cid is string => cid !== null);
      if (customerIds.length > 0) {
        const orders = await this.prisma.forTenant().order.findMany({
          where: {
            customerId: { in: customerIds },
            status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELIVERED] },
          },
          include: {
            lineItems: {
              include: { product: { select: { id: true, name: true, sku: true } } },
            },
          },
        });
        const byCustomer: Record<string, typeof orders> = {};
        for (const o of orders) {
          (byCustomer[o.customerId] ??= []).push(o);
        }
        stops = stops.map((s: any) => ({
          ...s,
          orders: (s._resolvedCustomerId ? (byCustomer[s._resolvedCustomerId] ?? []) : []) as any,
        }));
      }
    }

    // Aggregate packing list by product
    const map: Record<
      string,
      {
        productId: string;
        productName: string;
        sku?: string | null;
        totalQty: number;
        customers: { name: string; qty: number }[];
      }
    > = {};

    for (const stop of stops) {
      for (const order of stop.orders as any[]) {
        for (const li of order.lineItems ?? []) {
          if (!map[li.productId]) {
            map[li.productId] = {
              productId: li.productId,
              productName: li.product?.name ?? li.productId,
              sku: li.product?.sku ?? null,
              totalQty: 0,
              customers: [],
            };
          }
          const qty = Number(li.qty);
          map[li.productId].totalQty += qty;
          const cName = stop.customer?.businessName ?? "Unknown";
          const existing = map[li.productId].customers.find((c) => c.name === cName);
          if (existing) existing.qty += qty;
          else map[li.productId].customers.push({ name: cName, qty });
        }
      }
    }

    return {
      stops,
      packingList: Object.values(map).sort((a, b) => a.productName.localeCompare(b.productName)),
    };
  }

  async findMyRuns(user: JwtPayload) {
    const driver = await this.prisma.forTenant().driver.findFirst({ where: { userId: user.sub } });
    if (!driver) return { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } };

    const data = await this.prisma.forTenant().routeRun.findMany({
      where: {
        driverId: driver.id,
        status: { in: [RouteRunStatus.SCHEDULED, RouteRunStatus.IN_PROGRESS] },
      },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            kind: true,
            depotLat: true,
            depotLng: true,
            depotAddress: true,
            endKind: true,
            endLat: true,
            endLng: true,
          },
        },
        driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
        _count: { select: { stops: true } },
        stops: {
          include: RUN_STOP_INCLUDE,
          orderBy: { stopNumber: "asc" },
        },
      },
      orderBy: { scheduledDate: "asc" },
    });

    const normalisedData = data.map((run: any) => ({
      ...run,
      stops: run.stops.map((s: any) => ({
        ...s,
        customer: s.customer ?? s.routeStop?.customer ?? null,
        customerAddress: s.customerAddress ?? s.routeStop?.customerAddress ?? null,
      })),
    }));

    // F05 / R5: this endpoint is always driver-scoped (the authenticated
    // driver's own runs), so it always gets `collectedPayments`.
    const enrichedData = await this.enrichRunsWithCollectedPayments(normalisedData);

    return {
      data: enrichedData,
      meta: { total: enrichedData.length, page: 1, limit: enrichedData.length, totalPages: 1 },
    };
  }

  async getMyStats(user: JwtPayload) {
    const driver = await this.prisma.forTenant().driver.findFirst({ where: { userId: user.sub } });
    if (!driver)
      return {
        totalStopsCompleted: 0,
        onTimeDeliveryPct: 100,
        avgStopsPerRoute: 0,
        returnsRate: 0,
      };

    const runs = await this.prisma.forTenant().routeRun.findMany({
      where: { driverId: driver.id, status: "COMPLETED" },
      include: {
        stops: { select: { id: true, status: true, completedAt: true } },
      },
    });

    let totalStops = 0;
    let stopsPerRunSum = 0;
    for (const run of runs) {
      const completed = run.stops.filter((s) => s.status === "COMPLETED");
      totalStops += completed.length;
      stopsPerRunSum += completed.length;
    }

    const avgStopsPerRoute = runs.length === 0 ? 0 : Math.round(stopsPerRunSum / runs.length);
    return {
      totalStopsCompleted: totalStops,
      onTimeDeliveryPct: 100,
      avgStopsPerRoute,
      returnsRate: 0,
    };
  }

  async reopenStop(runId: string, stopId: string, user: JwtPayload) {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id: runId },
      include: {
        stops: { where: { id: stopId }, include: { orders: { include: { lineItems: true } } } },
      },
    });
    if (!run) throw new NotFoundException("Route run not found");

    const stop = run.stops[0];
    if (!stop) throw new NotFoundException("Stop not found");

    if (run.status === "CANCELLED")
      throw new BadRequestException("Cannot reopen a stop on a cancelled run");
    if (stop.status !== "COMPLETED" && stop.status !== "SKIPPED")
      throw new BadRequestException("Only completed or skipped stops can be reopened");

    // F11 / B211 (spec R7): after F11 every COMPLETED transition releases the
    // orders of its SKIPPED stops, so "run COMPLETED ∧ stop SKIPPED" IS the
    // state "this stop's orders were released" — one named condition (L-030),
    // not `stop.orders.length === 0`, which would read the release's EFFECT
    // and let a pre-fix stranded stop reopen into a run whose settlement is
    // already closed until the D4 repair happens to run. REFUSAL, not
    // reversal: the released orders are dispatchable on a new run. Reopening a
    // COMPLETED stop on a COMPLETED run is unchanged. Sits with the existing
    // state checks — reordering against the ownership block below is a
    // B72-class change with its own row.
    //
    // The REFUSAL is keyed on the state pair only. The MESSAGE is not: rows
    // completed BEFORE this deploy are refused by the same pair but were never
    // released (their pointers still stand), so telling that operator the
    // orders are "in dispatch" sends them to a trip builder that cannot see
    // them. The honest discriminator is the RELEASE HELPER'S OWN PREDICATE, not
    // `orders.length > 0`: `releaseUndeliveredOrders` leaves DELIVERED and
    // CANCELLED orders pinned, so a post-deploy release can hand this stop back
    // still holding some — and those rows are exactly the ones the D4 repair
    // (`scripts/repair-f11-stranded-orders.mjs`, same status filter) would skip,
    // so pointing that operator at the repair sends them on a flight that can
    // never report anything to fix. Only an order the release WOULD have taken
    // and did not means "this row predates the fix".
    if (stop.status === "SKIPPED" && run.status === "COMPLETED") {
      const stranded = stop.orders.some(
        (o) => o.status !== OrderStatus.DELIVERED && o.status !== OrderStatus.CANCELLED,
      );
      throw new BadRequestException(
        stranded
          ? "This run is complete and this skipped stop's orders are still attached to it (they predate the release fix) — ask an operator to run the F11 stranded-order repair, which frees them for a new run."
          : "This run is complete and the skipped stop's orders were released to dispatch — dispatch them on a new run instead of reopening this stop.",
      );
    }

    // Driver isolation
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id)
        throw new ForbiddenException("You do not have access to this route run");
    }

    const orderIds = [...new Set(stop.orders.map((o) => o.id))];

    // B54: the live at-door writer is InvoicePayment via
    // recordDeliveryPaymentInTx — the legacy `transaction` model has no writer
    // left, so the guard below it can never fire on new data. Block the reopen
    // while confirmed money stands against any of this stop's orders' invoices:
    // reversing delivery state under a live payment strands a PAID invoice on
    // an order the system then says was never delivered, and the re-delivery's
    // second collection is unrecorded (PAYABLE excludes PAID).
    if (orderIds.length > 0) {
      const liveMoney = await this.prisma.forTenant().invoice.findFirst({
        where: {
          orderId: { in: orderIds },
          OR: [
            { status: { in: [InvoiceStatus.PAID, InvoiceStatus.PARTIAL] } },
            { payments: { some: CONFIRMED_PAYMENT } },
          ],
        },
        select: { id: true },
      });
      if (liveMoney) {
        throw new BadRequestException(
          "Payment already recorded against this delivery — contact your operator to correct",
        );
      }
    }

    // B306: a zero-payable-invoice completion books the WHOLE at-door amount
    // as an AdvancePayment with no InvoicePayment row, so the liveMoney guard
    // above never sees it. Block reopen while that advance stands — voiding
    // the door payments reverses it (invoices.service.ts voidPayment).
    const runAdvance = await this.prisma.forTenant().advancePayment.findFirst({
      where: { reference: `RUN:${runId}:STOP:${stopId}` },
      select: { id: true },
    });
    if (runAdvance) {
      throw new BadRequestException(
        "An at-door over-collection advance is booked against this stop — void the delivery payments (which reverses it) before reopening",
      );
    }

    // Check for recorded payments on any transaction — block reopen if payment exists
    if (orderIds.length > 0) {
      const transactions = await this.prisma.forTenant().transaction.findMany({
        where: { orderId: { in: orderIds } },
        include: { payments: { take: 1 } },
      });
      for (const txn of transactions) {
        if (txn.payments.length > 0 || txn.status === "PAID" || txn.status === "PARTIAL") {
          throw new BadRequestException(
            "Payment already recorded against this delivery — contact your operator to correct",
          );
        }
      }
    }

    await this.prisma.tenantTransaction(async (tx) => {
      // 1. Delete delivery mutations for this stop
      await tx.deliveryMutation.deleteMany({ where: { routeRunStopId: stopId } });

      // 2. Reset order items → PENDING, order status → CONFIRMED (safe
      // fallback — it was at least CONFIRMED before going OUT_FOR_DELIVERY),
      // and delete UNPAID transactions.
      //
      // `deliveredQty` MUST be reset with the status. `completeWithPayment`
      // writes it per item (`deliveredQty: REFUSED ? 0 : quantityDelivered`)
      // independently of whether money changed hands, and
      // `reconcileOrderDraftInvoice(basis:"delivered")` bills
      // `Number(li.deliveredQty ?? 0)`. Leaving it standing after a reversal
      // bills the UNDONE delivery: complete a stop on account (item A 5, item B
      // 3, $0 collected) → reopen (permitted, since the B54 live-money guard
      // sees no confirmed payment) → re-deliver only item A with payment, and
      // item B is invoiced for 3 units nobody delivered. One order maps to one
      // stop (`Order.routeRunStopId`), so zeroing every item of this stop's
      // orders reverses exactly this stop's delivery and nothing else.
      for (const order of stop.orders) {
        await tx.orderItem.updateMany({
          where: { orderId: order.id },
          data: { status: "PENDING", deliveredQty: 0 },
        });
        if (order.status === "DELIVERED" || order.status === "OUT_FOR_DELIVERY") {
          await tx.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
        }
        await tx.transaction.deleteMany({ where: { orderId: order.id, status: "UNPAID" } });
      }

      // 3. B120: the reset below discards the only pointers to the stored POD
      // artifacts (these columns are storage keys since #477). Archive them in
      // this same transaction so regulated-delivery evidence stays recoverable
      // and the storage objects stay referenced; tenantId is injected by the
      // tenantTransaction write proxy.
      await tx.auditLog.create({
        data: {
          userId: user.sub ?? null,
          action: "route_stop.reopened",
          entityType: "RouteRunStop",
          entityId: stopId,
          meta: {
            runId,
            signatureUrl: stop.signatureUrl ?? null,
            podPhotoUrls: stop.podPhotoUrls ?? [],
            safeDropEnabled: stop.safeDropEnabled ?? false,
            driverNote: stop.driverNote ?? null,
            completedAt: stop.completedAt ? stop.completedAt.toISOString() : null,
            ageVerified: stop.ageVerified ?? false,
            identityVerified: stop.identityVerified ?? false,
            identityType: stop.identityType ?? null,
            identityVerifiedAt: stop.identityVerifiedAt
              ? stop.identityVerifiedAt.toISOString()
              : null,
          },
        },
      });

      // 4. Reset stop (incl. Phase 4 W7b regulated POD capture so a re-completion
      // must re-capture the age/ID checks; requirement flags are re-derived then).
      // B120: the audit row above is the who/when trail; `podHistory` is the
      // stop-local, append-only pointer archive the F01 schema batch added for
      // exactly this write (schema.prisma RouteRunStop.podHistory), so a stop
      // read surface can recover displaced evidence without an AuditLog query.
      // Prisma has no `push` for Json, so prior entries are re-spread; nothing
      // is appended when the reopen displaces no pointers (a SKIPPED stop).
      const displaced =
        (stop.signatureUrl ?? "").trim().length > 0 || (stop.podPhotoUrls ?? []).length > 0;
      const podArchive = displaced
        ? {
            podHistory: [
              ...(Array.isArray(stop.podHistory) ? stop.podHistory : []),
              {
                archivedAt: new Date().toISOString(),
                signatureUrl: stop.signatureUrl ?? null,
                podPhotoUrls: stop.podPhotoUrls ?? [],
                reason: "reopen",
              },
            ],
          }
        : null;
      await tx.routeRunStop.update({
        where: { id: stopId },
        data: {
          status: "PENDING",
          completedAt: null,
          arrivedAt: null,
          driverNote: null,
          podPhotoUrls: [],
          safeDropEnabled: false,
          signatureUrl: null,
          ageVerified: false,
          identityVerified: false,
          identityType: null,
          identityVerifiedAt: null,
          ...(podArchive ?? {}),
        },
      });

      // 5. If run was COMPLETED, reopen it too — and drop any settlement
      // record either way (F05 / R7). Reopening a stop means this run can
      // collect money again, while R7's three gates all key on
      // `settlementNote == null`: a note left over from the earlier, smaller
      // count would disarm every one of them for the re-collection AND keep
      // the web Settlement card describing a count that no longer covers the
      // run. The driver/operator settles again after the re-delivery.
      const settlementReset =
        run.settlementNote != null || run.settlementVariance != null
          ? { settlementNote: null, settlementVariance: null }
          : null;
      if (run.status === "COMPLETED") {
        await tx.routeRun.update({
          where: { id: runId },
          data: { status: "IN_PROGRESS", completedAt: null, ...(settlementReset ?? {}) },
        });
      } else if (settlementReset) {
        await tx.routeRun.update({ where: { id: runId }, data: settlementReset });
      }
    });

    return { success: true, message: "Stop reopened — you can now re-submit the delivery." };
  }

  private async findRouteOrThrow(id: string) {
    const route = await this.prisma.forTenant().route.findUnique({ where: { id } });
    if (!route) throw new NotFoundException("Route not found");
    return route;
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import {
  UserRole,
  RouteRunStatus,
  OrderStatus,
  NotificationEvent,
  Prisma,
  RouteKind,
  FulfillPath,
} from "@prisma/client";
import { ListRoutesDto } from "./dto/list-routes.dto";
import { CreateRouteDto } from "./dto/create-route.dto";
import { UpdateRouteDto } from "./dto/update-route.dto";
import { AddStopDto } from "./dto/add-stop.dto";
import { CreateRouteRunDto } from "./dto/create-route-run.dto";
import { UpdateRunStatusDto } from "./dto/update-run-status.dto";
import { ListRunsDto } from "./dto/list-runs.dto";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { formatMoney } from "../messaging/messaging.helpers";
import { CompleteStopDto } from "./dto/complete-stop.dto";
import { CompleteWithPaymentDto } from "./dto/complete-with-payment.dto";
import {
  assertRegulatedDeliverySatisfied,
  deriveStopRegulatedRequirements,
  loadAgeIdCategorySets,
  type RegulatedDeliveryDb,
} from "../common/regulated-delivery";

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
      lineItems: {
        select: {
          id: true,
          productId: true,
          product: { select: { id: true, name: true, unit: true } },
          qty: true,
          unitPrice: true,
          status: true,
        },
      },
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

  async createRoute(dto: CreateRouteDto) {
    return this.prisma.forTenant().route.create({
      data: {
        name: dto.name,
        driverId: dto.driverId || undefined,
        depotLat: dto.depotLat,
        depotLng: dto.depotLng,
        depotAddress: dto.depotAddress,
      },
    });
  }

  async updateRoute(id: string, dto: UpdateRouteDto) {
    await this.findRouteOrThrow(id);
    return this.prisma.forTenant().route.update({ where: { id }, data: dto });
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

    return this.prisma.forTenant().routeStop.create({
      data: {
        routeId,
        customerId: dto.customerId,
        customerAddressId,
        stopNumber,
        notes: dto.notes,
      },
    });
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
    ]);
    return { success: true };
  }

  async deleteRoute(id: string) {
    const route = await this.findRouteOrThrow(id);

    // Collect all run IDs and run-stop IDs for this route before deleting
    const runs = await this.prisma.forTenant().routeRun.findMany({
      where: { routeId: id },
      include: { stops: { select: { id: true } } },
    });
    const runIds = runs.map((r) => r.id);
    const runStopIds = runs.flatMap((r) => r.stops.map((s) => s.id));

    // An ad-hoc trip IS the only delivery record its orders have — there is no
    // recurring route to rebuild it from. Deleting one whose run has started or
    // finished would destroy the run stops carrying POD photos, signatures and
    // arrival/completion timestamps, so refuse. Drafts (and scheduled/cancelled
    // runs, which recorded nothing) stay deletable. SCHEDULED routes are
    // untouched by this guard.
    if (
      route.kind === RouteKind.ADHOC &&
      runs.some((r) => r.status === "IN_PROGRESS" || r.status === "COMPLETED")
    ) {
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
      include: { stops: { orderBy: { stopNumber: "asc" } } },
    });
    if (!route) throw new NotFoundException("Route not found");

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

    if (user.role === UserRole.DRIVER || assignedToMe) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (driver) where.driverId = driver.id;
    }

    const [data, total] = await Promise.all([
      this.prisma.forTenant().routeRun.findMany({
        where,
        include: {
          route: { select: { id: true, name: true } },
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

    return {
      data: normalisedData,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOneRun(id: string, user?: any) {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id },
      include: {
        route: { select: { id: true, name: true } },
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
                lineItems: {
                  select: {
                    id: true,
                    productId: true,
                    product: { select: { id: true, name: true, unit: true } },
                    qty: true,
                    unitPrice: true,
                    status: true,
                  },
                },
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
    if (!anyLinked && normalisedStops.length > 0) {
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
            lineItems: {
              select: {
                id: true,
                productId: true,
                product: { select: { id: true, name: true, unit: true } },
                qty: true,
                unitPrice: true,
                status: true,
              },
            },
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
        };
      }
    }

    return { ...run, stops: normalisedStops };
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

    if (user.role === UserRole.DRIVER) {
      const allowedStatuses: RouteRunStatus[] = [
        RouteRunStatus.IN_PROGRESS,
        RouteRunStatus.COMPLETED,
      ];
      if (!allowedStatuses.includes(dto.status)) {
        throw new ForbiddenException("Drivers can only set IN_PROGRESS or COMPLETED");
      }
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
    }

    const updates: any = { status: dto.status };
    if (dto.status === RouteRunStatus.IN_PROGRESS && !run.startedAt) updates.startedAt = new Date();
    if (dto.status === RouteRunStatus.COMPLETED) updates.completedAt = new Date();

    const updated = await this.prisma.forTenant().routeRun.update({
      where: { id },
      data: updates,
      include: {
        driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
      },
    });

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

    if (user.role === UserRole.DRIVER) {
      const run = await this.prisma
        .forTenant()
        .routeRun.findFirst({ where: { id: runId }, select: { driverId: true } });
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || !run || run.driverId !== driver.id) {
        throw new ForbiddenException("You do not have access to this route run");
      }
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

    // RF-019: Idempotency check (outside transaction for speed)
    if (dto.idempotencyKey) {
      const scope = `completeStop:${runId}:${stopId}`;
      const cached = await this.checkIdempotencyKey(dto.idempotencyKey, scope);
      if (cached) return cached;
    }

    const driver =
      user.role === UserRole.DRIVER
        ? await this.prisma.forTenant().driver.findFirst({ where: { userId: user.sub } })
        : null;

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
            select: { orderId: true, unitPrice: true },
          });
          if (!item) continue;
          await tx.deliveryMutation.create({
            data: {
              orderId: item.orderId,
              orderItemId: d.orderItemId,
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
        await tx.routeRun.update({
          where: { id: runId },
          data: { status: RouteRunStatus.COMPLETED, completedAt: new Date() },
        });
        autoCompleted = true;
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

    const driver =
      user.role === UserRole.DRIVER
        ? await this.prisma.forTenant().driver.findFirst({ where: { userId: user.sub } })
        : null;

    let autoCompleted = false;
    let paymentIds: string[] = [];
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
            select: { orderId: true },
          });
          if (!item) continue;
          deliveredOrderIdSet.add(item.orderId);
          await tx.deliveryMutation.create({
            data: {
              orderId: item.orderId,
              orderItemId: d.orderItemId,
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
        const { applied, paymentIds: recordedPaymentIds } =
          await this.invoicesService.recordDeliveryPaymentInTx(
            tx,
            deliveredOrderIds,
            dto.payment.amount,
            dto.payment.method,
            Array.from(deliveredOrderIdSet),
          );
        paymentIds = recordedPaymentIds;
        if (applied + 0.005 < dto.payment.amount) {
          this.logger.warn(
            `completeWithPayment: collected ${dto.payment.amount} but only ${applied} applied to ` +
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
        await tx.routeRun.update({
          where: { id: runId },
          data: { status: RouteRunStatus.COMPLETED, completedAt: new Date() },
        });
        autoCompleted = true;
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
    const response = { ...result, paymentIds };

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
        route: { select: { id: true, name: true } },
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

    return {
      data: normalisedData,
      meta: { total: normalisedData.length, page: 1, limit: normalisedData.length, totalPages: 1 },
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

    // Driver isolation
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id)
        throw new ForbiddenException("You do not have access to this route run");
    }

    // Load delivery mutations for this stop
    const mutations = await this.prisma.forTenant().deliveryMutation.findMany({
      where: { routeRunStopId: stopId },
      include: { order: { select: { orderNumber: true } } },
    });
    const orderIds = [...new Set(stop.orders.map((o) => o.id))];

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
      // 1. Reverse stock movements for each SALE created by this stop's mutations.
      // Written as a compensating SALE with POSITIVE quantity carrying the
      // original sale's unit cost, so signed COGS aggregations net to zero —
      // an un-costed ADJUSTMENT would leave the original cost in COGS forever.
      for (const mutation of mutations) {
        const qty = Number(mutation.quantityDelivered ?? 0);
        if (
          qty > 0 &&
          mutation.productId &&
          (mutation.type === "DELIVERED" || mutation.type === "PARTIAL")
        ) {
          const product = await tx.product.findFirst({
            where: { id: mutation.productId },
            select: { currentStock: true, averageCost: true },
          });
          // Cost of the original SALE for this order, else current average
          const originalSale = await tx.stockMovement.findFirst({
            where: {
              productId: mutation.productId,
              type: "SALE",
              quantity: { lt: 0 },
              reference: mutation.order?.orderNumber ?? undefined,
            },
            orderBy: { createdAt: "desc" },
            select: { unitCost: true },
          });
          const unitCost = originalSale?.unitCost ?? product?.averageCost ?? null;
          const stockAfter = (product?.currentStock ?? new Prisma.Decimal(0)).add(qty);

          await tx.stockMovement.create({
            data: {
              productId: mutation.productId,
              type: "SALE",
              quantity: new Prisma.Decimal(qty),
              unitCost,
              avgCostAfter: product?.averageCost ?? null,
              stockAfter,
              reference: `Reopen stop ${stopId}`,
              performedById: user.sub,
            },
          });
          await tx.product.update({
            where: { id: mutation.productId },
            data: { currentStock: { increment: qty } },
          });
        }
      }

      // 2. Delete delivery mutations for this stop
      await tx.deliveryMutation.deleteMany({ where: { routeRunStopId: stopId } });

      // 3. Reset order items → PENDING
      for (const order of stop.orders) {
        await tx.orderItem.updateMany({
          where: { orderId: order.id },
          data: { status: "PENDING" },
        });
        // 4. Reset order status → CONFIRMED (safe fallback — it was at least CONFIRMED before going OUT_FOR_DELIVERY)
        if (order.status === "DELIVERED" || order.status === "OUT_FOR_DELIVERY") {
          await tx.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
        }
        // 5. Delete UNPAID transactions
        await tx.transaction.deleteMany({ where: { orderId: order.id, status: "UNPAID" } });
      }

      // 6. Reset stop (incl. Phase 4 W7b regulated POD capture so a re-completion
      // must re-capture the age/ID checks; requirement flags are re-derived then).
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
        },
      });

      // 7. If run was COMPLETED, reopen it too
      if (run.status === "COMPLETED") {
        await tx.routeRun.update({
          where: { id: runId },
          data: { status: "IN_PROGRESS", completedAt: null },
        });
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

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole, RouteRunStatus, OrderStatus, Prisma } from "@prisma/client";
import { ListRoutesDto } from "./dto/list-routes.dto";
import { CreateRouteDto } from "./dto/create-route.dto";
import { UpdateRouteDto } from "./dto/update-route.dto";
import { AddStopDto } from "./dto/add-stop.dto";
import { CreateRouteRunDto } from "./dto/create-route-run.dto";
import { UpdateRunStatusDto } from "./dto/update-run-status.dto";
import { ListRunsDto } from "./dto/list-runs.dto";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Route Templates ────────────────────────────────────────────────────

  async findAllRoutes(query: ListRoutesDto) {
    const { search, isActive, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (isActive !== undefined) where.isActive = isActive;
    if (search) where.name = { contains: search, mode: "insensitive" };

    const [data, total] = await Promise.all([
      this.prisma.forTenant().route.findMany({
        where,
        include: {
          _count: { select: { stops: true } },
          runs: { take: 1, orderBy: { createdAt: "desc" } },
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
    // Two-phase update to avoid @@unique([routeId, stopNumber]) constraint violations:
    // Phase 1 — shift all stops to temporary positions (current target + large offset)
    // Phase 2 — set the actual target positions
    // Without this, updating stop A from 2→5 while stop B still sits at 5 causes a
    // unique-constraint violation mid-transaction.
    const offset = order.length + 100;
    await this.prisma.$transaction([
      ...order.map(({ id, stopNumber }) =>
        this.prisma.forTenant().routeStop.update({
          where: { id },
          data: { stopNumber: stopNumber + offset },
        }),
      ),
      ...order.map(({ id, stopNumber }) =>
        this.prisma.forTenant().routeStop.update({ where: { id }, data: { stopNumber } }),
      ),
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
    // Two-phase update to avoid @@unique([routeRunId, stopNumber]) constraint violations:
    // Phase 1 — shift all stops to temporary positions (current target + large offset)
    // Phase 2 — set the actual target positions
    const offset = order.length + 100;
    await this.prisma.$transaction([
      ...order.map(({ id, stopNumber }) =>
        this.prisma.forTenant().routeRunStop.update({
          where: { id },
          data: { stopNumber: stopNumber + offset },
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
        const cName = order.customer?.businessName ?? "Unknown";
        const existing = map[li.productId].customers.find((c) => c.name === cName);
        if (existing) existing.qty += qty;
        else map[li.productId].customers.push({ name: cName, qty });
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
      where: { customerId: { not: null } },
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

    // Drivers can only create runs for themselves
    let resolvedDriverId = dto.driverId;
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

      // Resolve depot for snapshot: route-level → system default → geocoded tenant address
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
    await Promise.all(
      run.stops
        .filter((s) => s.customerId)
        .map((s) =>
          this.prisma.forTenant().order.updateMany({
            where: {
              customerId: s.customerId!,
              status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
              routeRunStopId: null,
            },
            data: { routeRunId: run.id, routeRunStopId: s.id },
          }),
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

    return run;
  }

  async findAllRuns(query: ListRunsDto, user: JwtPayload) {
    const { assignedToMe, status, date, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (status) where.status = status;
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
  ) {
    const stop = await this.prisma.forTenant().routeRunStop.findFirst({
      where: { id: stopId, routeRunId: runId },
    });
    if (!stop) throw new NotFoundException("Stop not found");

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

  private async checkIdempotencyKey(key: string, scope: string): Promise<unknown | null> {
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
    dto: {
      driverNote?: string;
      podPhotoUrls?: string[];
      signatureUrl?: string;
      safeDropEnabled?: boolean;
      deliveries?: Array<{
        orderItemId: string;
        type: string;
        quantityDelivered: number;
        note?: string;
      }>;
      idempotencyKey?: string;
    },
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
      include: { orders: { select: { id: true, status: true, customerId: true } } },
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

    await this.prisma.tenantTransaction(async (tx) => {
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
        },
      });

      // 2. Record delivery mutations if provided
      if (dto.deliveries && dto.deliveries.length > 0) {
        for (const d of dto.deliveries) {
          const item = await tx.orderItem.findUnique({
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
      }
    });

    const result = await this.prisma.forTenant().routeRunStop.findUniqueOrThrow({ where: { id: stopId } });

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
    dto: {
      driverNote?: string;
      podPhotoUrls?: string[];
      signatureUrl?: string;
      safeDropEnabled?: boolean;
      deliveries?: Array<{
        orderItemId: string;
        type: string;
        quantityDelivered: number;
        note?: string;
      }>;
      payment?: {
        invoiceId: string;
        amount: number;
        method: string;
      };
      idempotencyKey?: string;
    },
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
      include: { orders: { select: { id: true, status: true, customerId: true } } },
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

    await this.prisma.tenantTransaction(async (tx) => {
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
        },
      });

      // 2. Record delivery mutations
      if (dto.deliveries && dto.deliveries.length > 0) {
        for (const d of dto.deliveries) {
          const item = await tx.orderItem.findUnique({
            where: { id: d.orderItemId },
            select: { orderId: true },
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

      // 4. Record payment (atomic with stop completion — RF-005)
      if (dto.payment && dto.payment.invoiceId && dto.payment.amount > 0) {
        const invoice = await tx.invoice.findFirst({
          where: { id: dto.payment.invoiceId },
          select: { id: true, balance: true },
        });
        if (invoice) {
          const paidAmount = new Prisma.Decimal(dto.payment.amount);
          await tx.invoicePayment.create({
            data: {
              invoiceId: invoice.id,
              amount: paidAmount,
              method: dto.payment.method as any,
              paidAt: new Date(),
              tenantId: this.prisma.getTenantId(),
            },
          });
          const newBalance = new Prisma.Decimal(invoice.balance ?? 0).minus(paidAmount);
          await tx.invoice.update({
            where: { id: invoice.id },
            data: {
              balance: newBalance,
              status: newBalance.lessThanOrEqualTo(0) ? ("PAID" as any) : ("PARTIAL" as any),
            },
          });
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
      }
    });

    const result = await this.prisma.forTenant().routeRunStop.findUniqueOrThrow({ where: { id: stopId } });

    // RF-019: persist idempotency key
    if (dto.idempotencyKey) {
      const scope = `completeWithPayment:${runId}:${stopId}`;
      await this.saveIdempotencyKey(dto.idempotencyKey, scope, result);
    }

    return result;
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
      // 1. Reverse stock movements for each SALE created by this stop's mutations
      for (const mutation of mutations) {
        const qty = Number(mutation.quantityDelivered ?? 0);
        if (
          qty > 0 &&
          mutation.productId &&
          (mutation.type === "DELIVERED" || mutation.type === "PARTIAL")
        ) {
          await tx.stockMovement.create({
            data: {
              productId: mutation.productId,
              type: "ADJUSTMENT",
              quantity: new Prisma.Decimal(qty),
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

      // 6. Reset stop
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

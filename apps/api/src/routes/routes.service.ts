import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
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
    await this.prisma.forTenant().routeStop.delete({ where: { id: stopId } });
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

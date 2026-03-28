import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
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
      this.prisma.route.findMany({
        where,
        include: {
          _count: { select: { stops: true } },
          runs: { take: 1, orderBy: { createdAt: "desc" } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.route.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOneRoute(id: string) {
    const route = await this.prisma.route.findUnique({
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
    return route;
  }

  async createRoute(dto: CreateRouteDto) {
    return this.prisma.route.create({ data: { name: dto.name } });
  }

  async updateRoute(id: string, dto: UpdateRouteDto) {
    await this.findRouteOrThrow(id);
    return this.prisma.route.update({ where: { id }, data: dto });
  }

  async addStop(routeId: string, dto: AddStopDto) {
    await this.findRouteOrThrow(routeId);

    let stopNumber = dto.stopNumber;
    if (stopNumber === undefined) {
      const last = await this.prisma.routeStop.findFirst({
        where: { routeId },
        orderBy: { stopNumber: "desc" },
        select: { stopNumber: true },
      });
      stopNumber = (last?.stopNumber ?? 0) + 1;
    }

    return this.prisma.routeStop.create({
      data: {
        routeId,
        customerId: dto.customerId,
        customerAddressId: dto.customerAddressId,
        stopNumber,
        notes: dto.notes,
      },
    });
  }

  async removeStop(routeId: string, stopId: string) {
    const stop = await this.prisma.routeStop.findFirst({ where: { id: stopId, routeId } });
    if (!stop) throw new NotFoundException("Stop not found");
    await this.prisma.routeStop.delete({ where: { id: stopId } });
    return { success: true };
  }

  async reorderStops(routeId: string, order: { id: string; stopNumber: number }[]) {
    await this.findRouteOrThrow(routeId);
    await this.prisma.$transaction(
      order.map(({ id, stopNumber }) =>
        this.prisma.routeStop.update({ where: { id }, data: { stopNumber } }),
      ),
    );
    return { success: true };
  }

  async deleteRoute(id: string) {
    await this.findRouteOrThrow(id);
    await this.prisma.route.delete({ where: { id } });
    return { success: true };
  }

  async reorderRunStops(runId: string, order: { id: string; stopNumber: number }[]) {
    const run = await this.prisma.routeRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Route run not found');
    if (run.status === 'IN_PROGRESS' || run.status === 'COMPLETED') {
      throw new BadRequestException('Cannot reorder stops on an active or completed route run');
    }
    await this.prisma.$transaction(
      order.map(({ id, stopNumber }) =>
        this.prisma.routeRunStop.update({ where: { id }, data: { stopNumber } }),
      ),
    );
    return { success: true };
  }

  async getPackingList(routeId: string) {
    const route = await this.prisma.route.findUnique({
      where: { id: routeId },
      include: {
        stops: {
          include: { customer: { select: { id: true, businessName: true } } },
          orderBy: { stopNumber: "asc" },
        },
      },
    });
    if (!route) throw new NotFoundException("Route not found");

    const customerIds = route.stops
      .map((s) => s.customerId)
      .filter((id): id is string => !!id);

    const orders = customerIds.length
      ? await this.prisma.order.findMany({
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

  async getCustomerRouteAssignments(): Promise<Record<string, { routeId: string; routeName: string }[]>> {
    const stops = await this.prisma.routeStop.findMany({
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

  // ── Route Runs ─────────────────────────────────────────────────────────

  async createRun(dto: CreateRouteRunDto, user?: JwtPayload) {
    const route = await this.prisma.route.findUnique({
      where: { id: dto.routeId },
      include: { stops: { orderBy: { stopNumber: "asc" } } },
    });
    if (!route) throw new NotFoundException("Route not found");

    // Drivers can only create runs for themselves
    let resolvedDriverId = dto.driverId;
    if (user?.role === UserRole.DRIVER) {
      const driver = await this.prisma.driver.findFirst({ where: { userId: user.sub } });
      resolvedDriverId = driver?.id ?? undefined;
    }

    const run = await this.prisma.routeRun.create({
      data: {
        routeId: dto.routeId,
        driverId: resolvedDriverId,
        scheduledDate: new Date(dto.scheduledDate),
        notes: dto.notes,
        stops: {
          create: route.stops.map((s) => ({
            routeStopId: s.id,
            stopNumber: s.stopNumber,
            customerId: s.customerId,
            customerAddressId: s.customerAddressId,
            podPhotoUrls: [],
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

    // Assign pending/confirmed orders to their respective run stops
    await Promise.all(
      run.stops
        .filter((s) => s.customerId)
        .map((s) =>
          this.prisma.order.updateMany({
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
      const driver = await this.prisma.driver.findFirst({ where: { userId: user.sub } });
      if (driver) where.driverId = driver.id;
    }

    const [data, total] = await Promise.all([
      this.prisma.routeRun.findMany({
        where,
        include: {
          route: { select: { id: true, name: true } },
          driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
          _count: { select: { stops: true } },
          stops: { select: { id: true, status: true } },
        },
        skip,
        take: limit,
        orderBy: { scheduledDate: "desc" },
      }),
      this.prisma.routeRun.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOneRun(id: string, user?: any) {
    const run = await this.prisma.routeRun.findUnique({
      where: { id },
      include: {
        route: { select: { id: true, name: true } },
        driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
        stops: {
          include: {
            customer: { select: { id: true, businessName: true, contactName: true, phone: true, deliveryWindowStart: true, deliveryWindowEnd: true } },
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
                customer: { select: { id: true, businessName: true, contactName: true, phone: true, deliveryWindowStart: true, deliveryWindowEnd: true } },
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
      const driver = await this.prisma.driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) throw new ForbiddenException("You do not have access to this route run");
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
        const orders = await this.prisma.order.findMany({
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

  async updateRun(id: string, dto: { driverId?: string | null; scheduledDate?: string; notes?: string }, user?: JwtPayload) {
    const run = await this.prisma.routeRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException("Route run not found");

    if (user?.role === UserRole.DRIVER) {
      const driver = await this.prisma.driver.findFirst({ where: { userId: user.sub } });
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
    return this.prisma.routeRun.update({ where: { id }, data });
  }

  async deleteRun(id: string) {
    const run = await this.prisma.routeRun.findUnique({
      where: { id },
      include: { stops: { select: { id: true } } },
    });
    if (!run) throw new NotFoundException("Route run not found");

    const stopIds = run.stops.map((s) => s.id);

    // 1. Unlink orders from run and stops
    await this.prisma.order.updateMany({
      where: { routeRunId: id },
      data: { routeRunId: null, routeRunStopId: null },
    });

    if (stopIds.length > 0) {
      // 2. Unlink delivery mutations referencing these stops
      await this.prisma.deliveryMutation.updateMany({
        where: { routeRunStopId: { in: stopIds } },
        data: { routeRunStopId: null },
      });

      // 3. Delete the run stops
      await this.prisma.routeRunStop.deleteMany({
        where: { routeRunId: id },
      });
    }

    // 4. Delete the run itself
    await this.prisma.routeRun.delete({ where: { id } });
    return { success: true };
  }

  async updateRunStatus(id: string, dto: UpdateRunStatusDto, user: JwtPayload) {
    const run = await this.prisma.routeRun.findUnique({ where: { id } });
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

    const updates: any = { status: dto.status };
    if (dto.status === RouteRunStatus.IN_PROGRESS && !run.startedAt) updates.startedAt = new Date();
    if (dto.status === RouteRunStatus.COMPLETED) updates.completedAt = new Date();

    const updated = await this.prisma.routeRun.update({
      where: { id },
      data: updates,
      include: { driver: { select: { id: true, contactName: true, user: { select: { username: true } } } } },
    });

    if (updated.driver) {
      this.gateway.emitDriverStatusUpdated({
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
    dto: { status: 'IN_PROGRESS' | 'SKIPPED'; driverNote?: string },
  ) {
    const stop = await this.prisma.routeRunStop.findFirst({
      where: { id: stopId, routeRunId: runId },
    });
    if (!stop) throw new NotFoundException('Stop not found');

    const updates: any = { status: dto.status };
    if (dto.driverNote !== undefined) updates.driverNote = dto.driverNote;
    if (dto.status === 'IN_PROGRESS' && !stop.arrivedAt) updates.arrivedAt = new Date();

    return this.prisma.routeRunStop.update({ where: { id: stopId }, data: updates });
  }

  async getRunPackingList(runId: string) {
    const run = await this.prisma.routeRun.findUnique({
      where: { id: runId },
      include: {
        stops: {
          include: {
            customer: { select: { id: true, businessName: true, deliveryWindowStart: true, deliveryWindowEnd: true } },
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
                customer: { select: { id: true, businessName: true, deliveryWindowStart: true, deliveryWindowEnd: true } },
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
      const customerIds = stops.map((s: any) => s._resolvedCustomerId).filter((cid: string | null): cid is string => cid !== null);
      if (customerIds.length > 0) {
        const orders = await this.prisma.order.findMany({
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
      { productId: string; productName: string; sku?: string | null; totalQty: number; customers: { name: string; qty: number }[] }
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
    const driver = await this.prisma.driver.findFirst({ where: { userId: user.sub } });
    if (!driver) return { totalStopsCompleted: 0, onTimeDeliveryPct: 100, avgStopsPerRoute: 0, returnsRate: 0 };

    const runs = await this.prisma.routeRun.findMany({
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
    return { totalStopsCompleted: totalStops, onTimeDeliveryPct: 100, avgStopsPerRoute, returnsRate: 0 };
  }

  async reopenStop(runId: string, stopId: string, user: JwtPayload) {
    const run = await this.prisma.routeRun.findUnique({
      where: { id: runId },
      include: { stops: { where: { id: stopId }, include: { orders: { include: { lineItems: true } } } } },
    });
    if (!run) throw new NotFoundException("Route run not found");

    const stop = run.stops[0];
    if (!stop) throw new NotFoundException("Stop not found");

    if (run.status === "CANCELLED") throw new BadRequestException("Cannot reopen a stop on a cancelled run");
    if (stop.status !== "COMPLETED" && stop.status !== "SKIPPED") throw new BadRequestException("Only completed or skipped stops can be reopened");

    // Driver isolation
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma.driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) throw new ForbiddenException("You do not have access to this route run");
    }

    // Load delivery mutations for this stop
    const mutations = await this.prisma.deliveryMutation.findMany({ where: { routeRunStopId: stopId } });
    const orderIds = [...new Set(stop.orders.map((o) => o.id))];

    // Check for recorded payments on any transaction — block reopen if payment exists
    if (orderIds.length > 0) {
      const transactions = await this.prisma.transaction.findMany({
        where: { orderId: { in: orderIds } },
        include: { payments: { take: 1 } },
      });
      for (const txn of transactions) {
        if (txn.payments.length > 0 || txn.status === "PAID" || txn.status === "PARTIAL") {
          throw new BadRequestException("Payment already recorded against this delivery — contact your operator to correct");
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Reverse stock movements for each SALE created by this stop's mutations
      for (const mutation of mutations) {
        const qty = Number(mutation.quantityDelivered ?? 0);
        if (qty > 0 && mutation.productId && (mutation.type === "DELIVERED" || mutation.type === "PARTIAL")) {
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
        await tx.orderItem.updateMany({ where: { orderId: order.id }, data: { status: "PENDING" } });
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
        await tx.routeRun.update({ where: { id: runId }, data: { status: "IN_PROGRESS", completedAt: null } });
      }
    });

    return { success: true, message: "Stop reopened — you can now re-submit the delivery." };
  }

  private async findRouteOrThrow(id: string) {
    const route = await this.prisma.route.findUnique({ where: { id } });
    if (!route) throw new NotFoundException("Route not found");
    return route;
  }
}

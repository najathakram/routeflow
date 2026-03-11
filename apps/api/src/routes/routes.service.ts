import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole, RouteRunStatus } from "@prisma/client";
import { ListRoutesDto } from "./dto/list-routes.dto";
import { CreateRouteDto } from "./dto/create-route.dto";
import { UpdateRouteDto } from "./dto/update-route.dto";
import { AddStopDto } from "./dto/add-stop.dto";
import { CreateRouteRunDto } from "./dto/create-route-run.dto";
import { UpdateRunStatusDto } from "./dto/update-run-status.dto";
import { ListRunsDto } from "./dto/list-runs.dto";

@Injectable()
export class RoutesService {
  constructor(private readonly prisma: PrismaService) {}

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
        map[li.productId].totalQty += li.qty;
        const cName = order.customer?.businessName ?? "Unknown";
        const existing = map[li.productId].customers.find((c) => c.name === cName);
        if (existing) existing.qty += li.qty;
        else map[li.productId].customers.push({ name: cName, qty: li.qty });
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

  async createRun(dto: CreateRouteRunDto) {
    const route = await this.prisma.route.findUnique({
      where: { id: dto.routeId },
      include: { stops: { orderBy: { stopNumber: "asc" } } },
    });
    if (!route) throw new NotFoundException("Route not found");

    return this.prisma.routeRun.create({
      data: {
        routeId: dto.routeId,
        driverId: dto.driverId,
        scheduledDate: new Date(dto.scheduledDate),
        notes: dto.notes,
        stops: {
          create: route.stops.map((s) => ({
            routeStopId: s.id,
            stopNumber: s.stopNumber,
            customerId: s.customerId,
            customerAddressId: s.customerAddressId,
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
        },
        skip,
        take: limit,
        orderBy: { scheduledDate: "desc" },
      }),
      this.prisma.routeRun.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOneRun(id: string) {
    const run = await this.prisma.routeRun.findUnique({
      where: { id },
      include: {
        route: { select: { id: true, name: true } },
        driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
        stops: {
          include: {
            customer: { select: { id: true, businessName: true, contactName: true } },
            customerAddress: true,
            orders: { select: { id: true, orderNumber: true, status: true } },
          },
          orderBy: { stopNumber: "asc" },
        },
      },
    });
    if (!run) throw new NotFoundException("Route run not found");
    return run;
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

    return this.prisma.routeRun.update({ where: { id }, data: updates });
  }

  private async findRouteOrThrow(id: string) {
    const route = await this.prisma.route.findUnique({ where: { id } });
    if (!route) throw new NotFoundException("Route not found");
    return route;
  }
}

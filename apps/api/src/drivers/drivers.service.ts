import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { ListDriversDto } from "./dto/list-drivers.dto";
import { CreateDriverDto } from "./dto/create-driver.dto";
import { UpdateDriverDto } from "./dto/update-driver.dto";
import { ChangeDriverStatusDto } from "./dto/change-driver-status.dto";
import { PostLocationDto } from "./dto/post-location.dto";
import { geocodeAddress } from "../common/geocode.util";

@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async findAll(query: ListDriversDto) {
    const { search, status, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { contactName: { contains: search, mode: "insensitive" } },
        { user: { username: { contains: search, mode: "insensitive" } } },
        { phone: { contains: search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.forTenant().driver.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              email: true,
              status: true,
              forcePasswordChange: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().driver.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findByUserId(userId: string) {
    const driver = await this.prisma.forTenant().driver.findFirst({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            status: true,
            forcePasswordChange: true,
          },
        },
      },
    });
    if (!driver) throw new NotFoundException("Driver profile not found");
    return driver;
  }

  async updateByUserId(userId: string, dto: UpdateDriverDto) {
    const driver = await this.prisma.forTenant().driver.findFirst({ where: { userId } });
    if (!driver) throw new NotFoundException("Driver profile not found");
    return this.update(driver.id, dto);
  }

  async recordLocation(userId: string, dto: PostLocationDto) {
    const driver = await this.prisma.forTenant().driver.findFirst({
      where: { userId },
      select: { id: true, tenantId: true },
    });
    if (!driver) throw new NotFoundException("Driver profile not found");

    const recordedAt = new Date(dto.recordedAt);
    if (Number.isNaN(recordedAt.getTime())) {
      throw new BadRequestException("recordedAt must be an ISO date string");
    }

    await this.prisma.forTenant().driverLocation.create({
      data: {
        driverId: driver.id,
        runId: dto.runId ?? null,
        lat: dto.lat,
        lng: dto.lng,
        heading: dto.heading,
        speedKph: dto.speedKph,
        batteryPct: dto.batteryPct,
        accuracy: dto.accuracy,
        recordedAt,
      },
    });
    return { ok: true };
  }

  async findOne(id: string, user: JwtPayload) {
    const driver = await this.prisma.forTenant().driver.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            status: true,
            forcePasswordChange: true,
          },
        },
      },
    });
    if (!driver) throw new NotFoundException("Driver not found");
    if (
      user.role !== UserRole.OPERATOR &&
      user.role !== UserRole.TENANT_ADMIN &&
      driver.userId !== user.sub
    ) {
      throw new ForbiddenException("Access denied");
    }
    return driver;
  }

  async create(dto: CreateDriverDto) {
    return this.prisma.tenantTransaction(async (tx) => {
      const [existingEmail, existingUsername] = await Promise.all([
        tx.user.findFirst({ where: { email: dto.email } }),
        tx.user.findFirst({ where: { username: dto.username } }),
      ]);
      if (existingEmail) throw new BadRequestException("Email already in use");
      if (existingUsername) throw new BadRequestException("Username already in use");

      const tempPassword = `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      const user = await tx.user.create({
        data: {
          email: dto.email,
          username: dto.username,
          password: hashedPassword,
          role: UserRole.DRIVER,
          forcePasswordChange: true,
        },
      });

      const driver = await tx.driver.create({
        data: {
          userId: user.id,
          contactName: dto.contactName,
          phone: dto.phone,
          vehicleMake: dto.vehicleMake,
          vehicleModel: dto.vehicleModel,
          vehicleColour: dto.vehicleColour,
          vehiclePlate: dto.vehiclePlate,
        },
        include: { user: { select: { id: true, username: true, email: true, status: true } } },
      });

      return { driver, tempPassword };
    });
  }

  async update(id: string, dto: UpdateDriverDto) {
    await this.findOneOrThrow(id);
    const { homeLine1, homeCity, homeState, homeZip, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };
    const homeFieldPresent =
      homeLine1 !== undefined ||
      homeCity !== undefined ||
      homeState !== undefined ||
      homeZip !== undefined;

    if (homeFieldPresent) {
      const parts = [homeLine1, homeCity, homeState, homeZip].filter(
        (part): part is string => !!part,
      );
      data.homeAddress = parts.length > 0 ? parts.join(", ") : null;

      const key = this.config.get<string>("googleMaps.apiKey") ?? "";
      const coords = await geocodeAddress(
        {
          line1: homeLine1 ?? "",
          city: homeCity ?? "",
          state: homeState ?? "",
          zip: homeZip ?? "",
        },
        key,
        this.logger,
      );
      data.homeLat = coords?.lat ?? null;
      data.homeLng = coords?.lng ?? null;
    }

    return this.prisma.forTenant().driver.update({
      where: { id },
      data,
      include: { user: { select: { id: true, username: true, email: true, status: true } } },
    });
  }

  async changeStatus(id: string, dto: ChangeDriverStatusDto) {
    await this.findOneOrThrow(id);
    await this.prisma.forTenant().driver.update({ where: { id }, data: { status: dto.status } });
    return { success: true };
  }

  async findHistory(id: string, page = 1, limit = 20) {
    await this.findOneOrThrow(id);
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.forTenant().routeRun.findMany({
        where: { driverId: id },
        include: {
          route: { select: { id: true, name: true } },
          _count: { select: { stops: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().routeRun.count({ where: { driverId: id } }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findMetrics(id: string) {
    await this.findOneOrThrow(id);
    const [completedRuns, totalRuns] = await Promise.all([
      this.prisma.forTenant().routeRun.count({ where: { driverId: id, status: "COMPLETED" } }),
      this.prisma.forTenant().routeRun.count({ where: { driverId: id } }),
    ]);
    return { completedRuns, totalRuns };
  }

  async remove(id: string) {
    const driver = await this.findOneOrThrow(id);

    // Block deletion if the driver has any active or scheduled runs
    const activeRuns = await this.prisma.forTenant().routeRun.count({
      where: { driverId: id, status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
    });
    if (activeRuns > 0) {
      throw new BadRequestException(
        "Cannot delete a driver with scheduled or in-progress route runs. Deactivate them instead.",
      );
    }

    await this.prisma.tenantTransaction(async (tx) => {
      // Nullify driver foreign keys so historical records are preserved
      await tx.route.updateMany({ where: { driverId: id }, data: { driverId: null } });
      await tx.routeRun.updateMany({ where: { driverId: id }, data: { driverId: null } });
      await tx.deliveryMutation.updateMany({ where: { driverId: id }, data: { driverId: null } });

      const linkedUser = await tx.user.findUnique({
        where: { id: driver.userId },
        select: { role: true },
      });

      // Delete the driver profile, then decide what happens to the linked login
      await tx.driver.delete({ where: { id } });

      if (linkedUser?.role === UserRole.DRIVER) {
        // Pure driver accounts exist only to drive — remove the login with the profile.
        await tx.user.delete({ where: { id: driver.userId } });
      } else {
        // Dual-role staff (OPERATOR / TENANT_ADMIN acting as driver): NEVER delete the
        // login (owner decision 2026-08-28 — deleting the admin's driver profile must not
        // nuke the tenant's admin account, and restrict-FKs on User made the whole tx roll
        // back silently, which is why deleted admin drivers "kept coming back"). Clear the
        // capability flag so Settings/nav stop offering driver surfaces and
        // toggleDriverPermit cannot silently resurrect the row.
        await tx.user.update({ where: { id: driver.userId }, data: { canActAsDriver: false } });
      }
    });

    return { success: true };
  }

  private async findOneOrThrow(id: string) {
    const driver = await this.prisma.forTenant().driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException("Driver not found");
    return driver;
  }
}

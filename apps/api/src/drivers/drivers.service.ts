import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import * as crypto from "crypto";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { ListDriversDto } from "./dto/list-drivers.dto";
import { CreateDriverDto } from "./dto/create-driver.dto";
import { UpdateDriverDto } from "./dto/update-driver.dto";
import { ChangeDriverStatusDto } from "./dto/change-driver-status.dto";

@Injectable()
export class DriversService {
  constructor(private readonly prisma: PrismaService) {}

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
      this.prisma.driver.findMany({
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
      this.prisma.driver.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findByUserId(userId: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { userId },
      include: { user: { select: { id: true, username: true, email: true, status: true, forcePasswordChange: true } } },
    });
    if (!driver) throw new NotFoundException("Driver profile not found");
    return driver;
  }

  async updateByUserId(userId: string, dto: UpdateDriverDto) {
    const driver = await this.prisma.driver.findFirst({ where: { userId } });
    if (!driver) throw new NotFoundException("Driver profile not found");
    return this.update(driver.id, dto);
  }

  async findOne(id: string, user: JwtPayload) {
    const driver = await this.prisma.driver.findUnique({
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
    if (user.role !== UserRole.OPERATOR && driver.userId !== user.sub) {
      throw new ForbiddenException("Access denied");
    }
    return driver;
  }

  async create(dto: CreateDriverDto) {
    return this.prisma.$transaction(async (tx) => {
      const [existingEmail, existingUsername] = await Promise.all([
        tx.user.findUnique({ where: { email: dto.email } }),
        tx.user.findUnique({ where: { username: dto.username } }),
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
    return this.prisma.driver.update({
      where: { id },
      data: dto,
      include: { user: { select: { id: true, username: true, email: true, status: true } } },
    });
  }

  async changeStatus(id: string, dto: ChangeDriverStatusDto) {
    await this.findOneOrThrow(id);
    await this.prisma.driver.update({ where: { id }, data: { status: dto.status } });
    return { success: true };
  }

  async findHistory(id: string, page = 1, limit = 20) {
    await this.findOneOrThrow(id);
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.routeRun.findMany({
        where: { driverId: id },
        include: {
          route: { select: { id: true, name: true } },
          _count: { select: { stops: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.routeRun.count({ where: { driverId: id } }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findMetrics(id: string) {
    await this.findOneOrThrow(id);
    const [completedRuns, totalRuns] = await Promise.all([
      this.prisma.routeRun.count({ where: { driverId: id, status: "COMPLETED" } }),
      this.prisma.routeRun.count({ where: { driverId: id } }),
    ]);
    return { completedRuns, totalRuns };
  }

  async remove(id: string) {
    const driver = await this.findOneOrThrow(id);

    // Block deletion if the driver has any active or scheduled runs
    const activeRuns = await this.prisma.routeRun.count({
      where: { driverId: id, status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
    });
    if (activeRuns > 0) {
      throw new BadRequestException(
        "Cannot delete a driver with scheduled or in-progress route runs. Deactivate them instead.",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Nullify driver foreign keys so historical records are preserved
      await tx.route.updateMany({ where: { driverId: id }, data: { driverId: null } });
      await tx.routeRun.updateMany({ where: { driverId: id }, data: { driverId: null } });
      await tx.deliveryMutation.updateMany({ where: { driverId: id }, data: { driverId: null } });
      // Delete driver profile then the linked user account
      await tx.driver.delete({ where: { id } });
      await tx.user.delete({ where: { id: driver.userId } });
    });

    return { success: true };
  }

  private async findOneOrThrow(id: string) {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException("Driver not found");
    return driver;
  }
}

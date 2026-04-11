import { Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { User, UserRole, UserStatus } from "@prisma/client";
import * as crypto from "crypto";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { ListUsersDto } from "./dto/list-users.dto";
import { CreateOperatorDto } from "./dto/create-operator.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { ChangeUserStatusDto } from "./dto/change-user-status.dto";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByUsername(username: string, tenantId?: string | null): Promise<User | null> {
    return this.prisma.forTenant().user.findFirst({
      where: { username, tenantId: tenantId ?? null },
    });
  }

  async findById(id: string): Promise<Omit<User, "password" | "googleId"> & { googleLinked: boolean } | null> {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id } });
    if (!user) return null;
    const { password: _pw, googleId, ...rest } = user;
    return { ...rest, googleLinked: !!googleId };
  }

  async findAll(query: ListUsersDto) {
    const { search, status, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {
      role: { not: UserRole.CUSTOMER },
    };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { username: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.forTenant().user.findMany({
        where,
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          status: true,
          forcePasswordChange: true,
          createdAt: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().user.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async createOperator(dto: CreateOperatorDto) {
    const [existingEmail, existingUsername] = await Promise.all([
      this.prisma.forTenant().user.findFirst({ where: { email: dto.email } }),
      this.prisma.forTenant().user.findFirst({ where: { username: dto.username } }),
    ]);
    if (existingEmail) throw new BadRequestException("Email already in use");
    if (existingUsername) throw new BadRequestException("Username already in use");

    const tempPassword = `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const user = await this.prisma.forTenant().user.create({
      data: {
        email: dto.email,
        username: dto.username,
        password: hashedPassword,
        role: UserRole.OPERATOR,
        forcePasswordChange: true,
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        forcePasswordChange: true,
      },
    });

    return { user, tempPassword };
  }

  async changeStatus(userId: string, dto: ChangeUserStatusDto) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    return this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { status: dto.status },
      select: { id: true, username: true, email: true, role: true, status: true },
    });
  }

  async updateUser(userId: string, dto: UpdateUserDto) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    return this.prisma.forTenant().user.update({
      where: { id: userId },
      data: dto,
      select: { id: true, username: true, email: true, role: true, status: true },
    });
  }

  async resetPassword(userId: string) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    const tempPassword = `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    await this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { password: hashedPassword, forcePasswordChange: true },
    });
    return { tempPassword };
  }

  async getPreferences(userId: string): Promise<Record<string, string>> {
    const prefs = await this.prisma.forTenant().userPreference.findMany({ where: { userId } });
    return Object.fromEntries(prefs.map((p) => [p.key, p.value]));
  }

  async setPreference(userId: string, key: string, value: string): Promise<void> {
    await this.prisma.forTenant().userPreference.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value },
      update: { value },
    });
  }

  async setPreferences(userId: string, prefs: Record<string, string>): Promise<void> {
    await Promise.all(
      Object.entries(prefs).map(([key, value]) => this.setPreference(userId, key, value)),
    );
  }
}

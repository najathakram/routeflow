import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
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
    // Accept either username or email in the login field
    return this.prisma.forTenant().user.findFirst({
      where: {
        OR: [
          { username, tenantId: tenantId ?? null },
          { email: username, tenantId: tenantId ?? null },
        ],
      },
    });
  }

  async findById(
    id: string,
  ): Promise<(Omit<User, "password" | "googleId"> & { googleLinked: boolean }) | null> {
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
          isAdmin: true,
          canActAsDriver: true,
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

    // Prevent changing role of TENANT_ADMIN users
    if (user.role === UserRole.TENANT_ADMIN && dto.role && dto.role !== UserRole.TENANT_ADMIN) {
      throw new ForbiddenException("Cannot change the role of the tenant admin.");
    }

    // Only allow OPERATOR or DRIVER roles when changing role
    if (
      dto.role &&
      dto.role !== user.role &&
      dto.role !== UserRole.OPERATOR &&
      dto.role !== UserRole.DRIVER
    ) {
      throw new BadRequestException("Users can only be assigned OPERATOR or DRIVER roles.");
    }

    return this.prisma.forTenant().user.update({
      where: { id: userId },
      data: dto,
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        isAdmin: true,
        canActAsDriver: true,
      },
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

  async toggleAdmin(userId: string, callerIsAdmin: boolean) {
    if (!callerIsAdmin) {
      throw new ForbiddenException("Only admins can assign admin rights.");
    }
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (user.role !== UserRole.OPERATOR) {
      throw new BadRequestException("Admin rights can only be assigned to operators.");
    }
    return this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { isAdmin: !user.isAdmin },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        isAdmin: true,
        canActAsDriver: true,
      },
    });
  }

  async toggleDriverPermit(userId: string) {
    const user = await this.prisma.forTenant().user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (user.role !== UserRole.OPERATOR && user.role !== UserRole.TENANT_ADMIN) {
      throw new BadRequestException("Driver permit can only be assigned to operators.");
    }

    const newValue = !user.canActAsDriver;

    // Auto-create Driver record if enabling and no driver record exists
    if (newValue) {
      const existingDriver = await this.prisma.forTenant().driver.findFirst({
        where: { userId: user.id },
      });
      if (!existingDriver) {
        await this.prisma.forTenant().driver.create({
          data: {
            userId: user.id,
            contactName: user.username,
            phone: "",
            status: "ACTIVE",
          },
        });
      }
    }

    return this.prisma.forTenant().user.update({
      where: { id: userId },
      data: { canActAsDriver: newValue },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        isAdmin: true,
        canActAsDriver: true,
      },
    });
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

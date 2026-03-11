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

  async findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  async findById(id: string): Promise<Omit<User, "password"> | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return null;
    const { password: _pw, ...rest } = user;
    return rest;
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
      this.prisma.user.findMany({
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
      this.prisma.user.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async createOperator(dto: CreateOperatorDto) {
    const [existingEmail, existingUsername] = await Promise.all([
      this.prisma.user.findUnique({ where: { email: dto.email } }),
      this.prisma.user.findUnique({ where: { username: dto.username } }),
    ]);
    if (existingEmail) throw new BadRequestException("Email already in use");
    if (existingUsername) throw new BadRequestException("Username already in use");

    const tempPassword = `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const user = await this.prisma.user.create({
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
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    return this.prisma.user.update({
      where: { id: userId },
      data: { status: dto.status },
      select: { id: true, username: true, email: true, role: true, status: true },
    });
  }

  async updateUser(userId: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    return this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: { id: true, username: true, email: true, role: true, status: true },
    });
  }
}

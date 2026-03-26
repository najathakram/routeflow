import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { ChangeCustomerStatusDto } from "./dto/change-customer-status.dto";
import { CreateAddressDto } from "./dto/create-address.dto";
import { UpdateAddressDto } from "./dto/update-address.dto";
import { ListCustomersDto } from "./dto/list-customers.dto";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListCustomersDto) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      const q = query.search;
      where.OR = [
        { businessName: { contains: q, mode: "insensitive" } },
        { contactName: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
      ];
    }
    if (query.status) {
      where.user = { status: query.status };
    }

    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, username: true, status: true } },
          addresses: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findMyProfile(user: JwtPayload) {
    const customer = await this.prisma.customer.findFirst({
      where: { userId: user.sub },
      include: {
        user: { select: { id: true, email: true, username: true, status: true } },
        addresses: true,
      },
    });
    if (!customer) throw new NotFoundException("Customer profile not found");
    return customer;
  }

  async updateMyProfile(user: JwtPayload, dto: UpdateCustomerDto) {
    const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
    if (!customer) throw new NotFoundException("Customer profile not found");
    return this.update(customer.id, dto);
  }

  async getMyStatement(user: JwtPayload) {
    const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
    if (!customer) throw new NotFoundException("Customer profile not found");

    const [invoices, creditNotes] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          status: true,
          dueDate: true,
          createdAt: true,
          payments: { select: { amount: true } },
        },
      }),
      this.prisma.creditNote.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, creditNoteNumber: true, amount: true, status: true, createdAt: true },
      }),
    ]);

    const invoicesWithPaid = invoices.map((i) => ({
      ...i,
      amountPaid: i.payments.reduce((sum, p) => sum + Number(p.amount), 0),
    }));

    const outstanding = invoicesWithPaid
      .filter((i) => i.status !== "PAID" && i.status !== "VOID")
      .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0);

    const overdue = invoicesWithPaid
      .filter((i) => i.status !== "PAID" && i.status !== "VOID" && i.dueDate && new Date(i.dueDate) < new Date())
      .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0);

    const availableCredit = creditNotes
      .filter((c) => c.status === "ISSUED")
      .reduce((sum, c) => sum + Number(c.amount), 0);

    const transactions = [
      ...invoicesWithPaid.map((i) => ({
        type: "INVOICE" as const,
        id: i.id,
        description: `Invoice #${i.invoiceNumber}`,
        date: i.createdAt.toISOString(),
        amount: Number(i.total),
        runningBalance: -(Number(i.total) - i.amountPaid),
        status: i.status,
      })),
      ...creditNotes.map((c) => ({
        type: "CREDIT_NOTE" as const,
        id: c.id,
        description: `Credit Note #${c.creditNoteNumber}`,
        date: c.createdAt.toISOString(),
        amount: -Number(c.amount),
        runningBalance: c.status === "APPLIED" ? 0 : Number(c.amount),
        status: c.status,
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return { outstandingAmount: outstanding, overdueAmount: overdue, availableCredit, transactions };
  }

  async findOne(id: string, user: JwtPayload) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, username: true, status: true } },
        addresses: true,
      },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    if (user.role !== UserRole.OPERATOR && customer.userId !== user.sub) {
      throw new ForbiddenException();
    }
    return customer;
  }

  async create(dto: CreateCustomerDto) {
    const existingUser = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { username: dto.username }] },
    });
    if (existingUser) throw new BadRequestException("Email or username already taken");

    const tempPassword = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email,
          username: dto.username,
          password: hashedPassword,
          role: UserRole.CUSTOMER,
          forcePasswordChange: true,
        },
      });

      const customer = await tx.customer.create({
        data: {
          userId: user.id,
          businessName: dto.businessName,
          contactName: dto.contactName,
          phone: dto.phone,
          notes: dto.notes,
          fulfillPath: dto.fulfillPath ?? "ROUTE",
        },
      });

      if (dto.addresses && dto.addresses.length > 0) {
        await tx.customerAddress.createMany({
          data: dto.addresses.map((addr, idx) => ({
            customerId: customer.id,
            label: addr.label,
            line1: addr.line1,
            line2: addr.line2,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            isDefault: idx === 0,
          })),
        });
      }

      return {
        customer,
        user: { id: user.id, email: user.email, username: user.username },
        tempPassword,
      };
    });
  }

  async update(id: string, dto: UpdateCustomerDto) {
    await this.findCustomerOrThrow(id);
    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.businessName && { businessName: dto.businessName }),
        ...(dto.contactName && { contactName: dto.contactName }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.fulfillPath && { fulfillPath: dto.fulfillPath }),
        ...(dto.deliveryWindowStart !== undefined && { deliveryWindowStart: dto.deliveryWindowStart || null }),
        ...(dto.deliveryWindowEnd !== undefined && { deliveryWindowEnd: dto.deliveryWindowEnd || null }),
      },
    });
  }

  async changeStatus(id: string, dto: ChangeCustomerStatusDto) {
    const customer = await this.findCustomerOrThrow(id);
    return this.prisma.user.update({
      where: { id: customer.userId },
      data: { status: dto.status },
      select: { id: true, status: true },
    });
  }

  async findRoutes(id: string) {
    await this.findCustomerOrThrow(id);
    const stops = await this.prisma.routeStop.findMany({
      where: { customerId: id },
      include: {
        route: {
          include: {
            driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
          },
        },
        customerAddress: { select: { id: true, label: true, line1: true, city: true } },
      },
      orderBy: { route: { name: "asc" } },
    });

    // Deduplicate by routeId — keep the first stop per route
    const seen = new Set<string>();
    return stops
      .filter((s) => {
        if (seen.has(s.routeId)) return false;
        seen.add(s.routeId);
        return true;
      })
      .map((s) => ({
        id: s.route.id,
        name: s.route.name,
        isActive: s.route.isActive,
        stopNumber: s.stopNumber,
        stopId: s.id,
        addressLabel: s.customerAddress?.label ?? null,
        driverName: s.route.driver?.contactName ?? s.route.driver?.user?.username ?? null,
      }));
  }

  async findOrders(id: string, user: JwtPayload) {
    const customer = await this.findCustomerOrThrow(id);
    if (user.role !== UserRole.OPERATOR && customer.userId !== user.sub) {
      throw new ForbiddenException();
    }
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { customerId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      this.prisma.order.count({ where: { customerId: id } }),
    ]);
    return { data, meta: { total, page: 1, limit: 50, totalPages: Math.ceil(total / 50) } };
  }

  async addAddress(id: string, dto: CreateAddressDto) {
    await this.findCustomerOrThrow(id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId: id },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.create({
        data: {
          customerId: id,
          label: dto.label,
          line1: dto.line1,
          line2: dto.line2,
          city: dto.city,
          state: dto.state,
          zip: dto.zip,
          isDefault: dto.isDefault ?? false,
        },
      });
    });
  }

  async updateAddress(id: string, addrId: string, dto: UpdateAddressDto) {
    await this.findCustomerOrThrow(id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId: id, id: { not: addrId } },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.update({
        where: { id: addrId, customerId: id },
        data: dto,
      });
    });
  }

  private async findCustomerOrThrow(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("Customer not found");
    return customer;
  }

  private generateTempPassword(): string {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const raw = Array.from(crypto.randomBytes(8))
      .map((b) => chars[b % chars.length])
      .join("");
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }
}

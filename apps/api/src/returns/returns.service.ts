import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

const VALID_RETURN_REASONS = [
  "DAMAGED",
  "WRONG_ITEM",
  "CUSTOMER_REFUSED",
  "QUALITY_ISSUE",
  "EXCESS_ORDER",
] as const;
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  private generateReturnNumber(): string {
    const now = new Date();
    const year = now.getFullYear();
    const seq = Date.now().toString().slice(-6);
    return `RET-${year}-${seq}`;
  }

  async create(dto: any, userId: string, userRole?: string) {
    if (!VALID_RETURN_REASONS.includes(dto.reason)) {
      throw new BadRequestException(
        `Invalid reason. Must be one of: ${VALID_RETURN_REASONS.join(", ")}`,
      );
    }

    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: dto.orderId },
      include: {
        customer: { select: { id: true, businessName: true } },
        lineItems: { select: { productId: true, qty: true, unitPrice: true } },
        invoice: { select: { id: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== "DELIVERED")
      throw new BadRequestException("Returns can only be submitted for delivered orders");

    // Customers can only create returns for their own orders
    if (userRole === "CUSTOMER") {
      const customer = await this.prisma.forTenant().customer.findFirst({ where: { userId } });
      if (!customer || order.customerId !== customer.id) {
        throw new ForbiddenException("You can only submit returns for your own orders");
      }
    }

    // Validate return qty does not exceed ordered qty per item
    for (const item of dto.items) {
      if (!item.qty || item.qty <= 0)
        throw new BadRequestException("Return item quantity must be greater than zero");
      const orderLine = (order as any).lineItems?.find(
        (li: any) => li.productId === item.productId,
      );
      if (!orderLine)
        throw new BadRequestException(`Product ${item.productId} was not in the original order`);
      if (item.qty > Number(orderLine.qty))
        throw new BadRequestException(
          `Return qty (${item.qty}) exceeds ordered qty (${Number(orderLine.qty)}) for product ${item.productId}`,
        );
    }

    const ret = await this.prisma.forTenant().return.create({
      data: {
        returnNumber: this.generateReturnNumber(),
        orderId: dto.orderId,
        customerId: order.customerId,
        reason: dto.reason,
        notes: dto.notes,
        photoUrls: dto.photoUrls ?? [],
        status: "PENDING",
        items: {
          create: dto.items.map((i: any) => ({
            productId: i.productId,
            qty: i.qty,
            reason: i.reason,
            restock: i.restock ?? true,
          })),
        },
      },
      include: { items: true },
    });

    this.gateway.emitReturnCreated(this.prisma.getTenantId(), {
      returnId: ret.id,
      customerId: order.customerId,
      customerName: order.customer.businessName,
      orderId: dto.orderId,
      reason: dto.reason,
    });

    return ret;
  }

  async findAllForUser(
    user: JwtPayload,
    orderId?: string,
    customerId?: string,
    status?: string,
    reason?: string,
    page = 1,
    limit = 20,
  ) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma.forTenant().customer.findFirst({ where: { userId: user.sub } });
      return this.findAll(orderId, customer?.id, status, reason, page, limit);
    }
    return this.findAll(orderId, customerId, status, reason, page, limit);
  }

  async findAll(
    orderId?: string,
    customerId?: string,
    status?: string,
    reason?: string,
    page = 1,
    limit = 20,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (orderId) where.orderId = orderId;
    if (customerId) where.customerId = customerId;
    if (status) where.status = status;
    if (reason) where.reason = reason;
    const [data, total] = await Promise.all([
      this.prisma.forTenant().return.findMany({
        where,
        include: {
          order: { select: { id: true, orderNumber: true } },
          customer: { select: { id: true, businessName: true } },
          items: { include: { product: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.forTenant().return.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async approve(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status !== "PENDING")
      throw new BadRequestException("Only PENDING returns can be approved");
    return this.prisma.forTenant().return.update({ where: { id }, data: { status: "APPROVED" } });
  }

  async reject(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status !== "PENDING")
      throw new BadRequestException("Only PENDING returns can be rejected");
    return this.prisma.forTenant().return.update({ where: { id }, data: { status: "REJECTED" } });
  }

  async markInTransit(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status !== "APPROVED")
      throw new BadRequestException("Only APPROVED returns can be marked in transit");
    return this.prisma.forTenant().return.update({ where: { id }, data: { status: "IN_TRANSIT" } });
  }

  async receive(id: string, userId: string) {
    const ret = await this.prisma.forTenant().return.findUnique({ where: { id }, include: { items: true } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status !== "IN_TRANSIT")
      throw new BadRequestException("Only IN_TRANSIT returns can be received");

    return this.prisma.tenantTransaction(async (tx) => {
      for (const item of ret.items) {
        if (item.restock) {
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              type: "RETURN",
              quantity: Number(item.qty),
              performedById: userId,
              reference: `RET-${ret.id.slice(0, 8)}`,
            },
          });
          await tx.product.update({
            where: { id: item.productId },
            data: { currentStock: { increment: Number(item.qty) } },
          });
        }
      }
      return tx.return.update({ where: { id }, data: { status: "RECEIVED" } });
    });
  }

  async processRefund(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status !== "RECEIVED")
      throw new BadRequestException("Only RECEIVED returns can be refunded");
    return this.prisma.forTenant().return.update({ where: { id }, data: { status: "REFUNDED" } });
  }

  async cancel(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status === "CANCELLED") throw new BadRequestException("Return is already cancelled");
    if (ret.status === "REFUNDED") throw new BadRequestException("Refunded returns cannot be cancelled");

    return this.prisma.tenantTransaction(async (tx) => {
      // Reverse stock movements if items were already received into stock
      if (ret.status === "RECEIVED" || ret.status === "PROCESSED") {
        const returnRef = `RET-${ret.id.slice(0, 8)}`;
        for (const item of ret.items) {
          if (item.restock) {
            await tx.product.update({
              where: { id: item.productId },
              data: { currentStock: { decrement: Number(item.qty) } },
            });
          }
          await tx.stockMovement.deleteMany({
            where: { productId: item.productId, reference: returnRef },
          });
        }
      }
      return tx.return.update({ where: { id }, data: { status: "CANCELLED" } });
    });
  }

  async findOne(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({
      where: { id },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            lineItems: { select: { productId: true, qty: true, unitPrice: true } },
          },
        },
        customer: { select: { id: true, businessName: true } },
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
      },
    });
    if (!ret) throw new NotFoundException("Return not found");

    // Enrich each return item with orderedQty from the original order
    const enrichedItems = ret.items.map((item) => {
      const orderLine = ret.order?.lineItems?.find((li) => li.productId === item.productId);
      return {
        ...item,
        orderedQty: orderLine ? Number(orderLine.qty) : null,
        unitPrice: orderLine ? Number(orderLine.unitPrice) : null,
      };
    });

    return { ...ret, items: enrichedItems };
  }
}

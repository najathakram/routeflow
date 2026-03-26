import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";

const VALID_RETURN_REASONS = ["DAMAGED", "WRONG_ITEM", "CUSTOMER_REFUSED", "QUALITY_ISSUE", "EXCESS_ORDER"] as const;
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
      throw new BadRequestException(`Invalid reason. Must be one of: ${VALID_RETURN_REASONS.join(", ")}`);
    }

    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: {
        customer: { select: { id: true, businessName: true } },
        lineItems: { select: { productId: true, qty: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== "DELIVERED") throw new BadRequestException("Returns can only be submitted for delivered orders");

    // Customers can only create returns for their own orders
    if (userRole === "CUSTOMER") {
      const customer = await this.prisma.customer.findFirst({ where: { userId } });
      if (!customer || order.customerId !== customer.id) {
        throw new ForbiddenException("You can only submit returns for your own orders");
      }
    }

    // Validate return qty does not exceed ordered qty per item
    for (const item of dto.items) {
      if (!item.qty || item.qty <= 0) throw new BadRequestException("Return item quantity must be greater than zero");
      const orderLine = (order as any).lineItems?.find((li: any) => li.productId === item.productId);
      if (!orderLine) throw new BadRequestException(`Product ${item.productId} was not in the original order`);
      if (item.qty > Number(orderLine.qty)) throw new BadRequestException(`Return qty (${item.qty}) exceeds ordered qty (${Number(orderLine.qty)}) for product ${item.productId}`);
    }

    const ret = await this.prisma.$transaction(async (tx) => {
      const created = await tx.return.create({
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

      for (const item of dto.items) {
        if (item.restock) {
          await tx.stockMovement.create({
            data: { productId: item.productId, type: "RETURN", quantity: item.qty, performedById: userId, reference: `RET-${created.id.slice(0, 8)}` },
          });
          await tx.product.update({ where: { id: item.productId }, data: { currentStock: { increment: item.qty } } });
        } else {
          await tx.stockMovement.create({
            data: { productId: item.productId, type: "WRITE_OFF", quantity: -item.qty, performedById: userId, reference: `RET-${created.id.slice(0, 8)}` },
          });
        }
      }

      await tx.return.update({ where: { id: created.id }, data: { status: "PROCESSED" } });
      return created;
    });

    this.gateway.emitReturnCreated({
      returnId: ret.id,
      customerId: order.customerId,
      customerName: order.customer.businessName,
      orderId: dto.orderId,
      reason: dto.reason,
    });

    return ret;
  }

  async findAllForUser(user: JwtPayload, orderId?: string, customerId?: string, status?: string, reason?: string, page = 1, limit = 20) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      return this.findAll(orderId, customer?.id, status, reason, page, limit);
    }
    return this.findAll(orderId, customerId, status, reason, page, limit);
  }

  async findAll(orderId?: string, customerId?: string, status?: string, reason?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (orderId) where.orderId = orderId;
    if (customerId) where.customerId = customerId;
    if (status) where.status = status;
    if (reason) where.reason = reason;
    const [data, total] = await Promise.all([
      this.prisma.return.findMany({
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
      this.prisma.return.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async cancel(id: string) {
    const ret = await this.prisma.return.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException("Return not found");
    return this.prisma.return.update({ where: { id }, data: { status: "CANCELLED" } });
  }

  async findOne(id: string) {
    const ret = await this.prisma.return.findUnique({
      where: { id },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            lineItems: { select: { productId: true, qty: true } },
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
      return { ...item, orderedQty: orderLine ? Number(orderLine.qty) : null };
    });

    return { ...ret, items: enrichedItems };
  }
}

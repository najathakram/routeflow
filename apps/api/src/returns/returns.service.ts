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

    const order = await this.prisma.order.findUnique({
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
      const customer = await this.prisma.customer.findFirst({ where: { userId } });
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
            data: {
              productId: item.productId,
              type: "RETURN",
              quantity: item.qty,
              performedById: userId,
              reference: `RET-${created.id.slice(0, 8)}`,
            },
          });
          await tx.product.update({
            where: { id: item.productId },
            data: { currentStock: { increment: item.qty } },
          });
        } else {
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              type: "WRITE_OFF",
              quantity: -item.qty,
              performedById: userId,
              reference: `RET-${created.id.slice(0, 8)}`,
            },
          });
        }
      }

      // Auto-create a credit note for the return value
      const priceMap = new Map<string, number>(
        (order as any).lineItems.map((li: any) => [li.productId, Number(li.unitPrice)]),
      );
      const cnAmount = dto.items.reduce((sum: number, item: any) => {
        const price = priceMap.get(item.productId) ?? 0;
        return sum + item.qty * price;
      }, 0);

      let creditNoteId: string | null = null;
      if (cnAmount > 0) {
        const year = new Date().getFullYear();
        const prefix = `CN-${year}-`;
        const lastCn = await tx.creditNote.findFirst({
          where: { creditNoteNumber: { startsWith: prefix } },
          orderBy: { creditNoteNumber: "desc" },
        });
        const seq = lastCn ? parseInt(lastCn.creditNoteNumber.split("-")[2], 10) + 1 : 1;
        const cnNumber = `${prefix}${String(seq).padStart(4, "0")}`;

        const cn = await tx.creditNote.create({
          data: {
            creditNoteNumber: cnNumber,
            customerId: order.customerId,
            invoiceId: (order as any).invoice?.id ?? null,
            amount: cnAmount,
            reason: `Return ${created.returnNumber}: ${dto.reason}`,
            status: "ISSUED",
          },
        });
        creditNoteId = cn.id;
      }

      await tx.return.update({
        where: { id: created.id },
        data: { status: "PROCESSED", creditNoteId },
      });
      return { ...created, creditNoteId };
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
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
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
    const ret = await this.prisma.return.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status === "CANCELLED") throw new BadRequestException("Return is already cancelled");

    return this.prisma.$transaction(async (tx) => {
      // Reverse stock movements if the return was already PROCESSED
      if (ret.status === "PROCESSED") {
        const returnRef = `RET-${ret.id.slice(0, 8)}`;
        for (const item of ret.items) {
          if (item.restock) {
            // Was incremented on RETURN movement — now decrement back
            await tx.product.update({
              where: { id: item.productId },
              data: { currentStock: { decrement: item.qty } },
            });
          }
          // Delete the original stock movement
          await tx.stockMovement.deleteMany({
            where: { productId: item.productId, reference: returnRef },
          });
        }
      }

      return tx.return.update({ where: { id }, data: { status: "CANCELLED" } });
    });
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

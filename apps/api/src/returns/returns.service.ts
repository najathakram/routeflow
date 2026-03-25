import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ReturnsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: any, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: dto.orderId } });
    if (!order) throw new NotFoundException("Order not found");

    return this.prisma.$transaction(async (tx) => {
      const ret = await tx.return.create({
        data: {
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
            data: { productId: item.productId, type: "RETURN", quantity: item.qty, performedById: userId, reference: `RET-${ret.id.slice(0, 8)}` },
          });
          await tx.product.update({ where: { id: item.productId }, data: { currentStock: { increment: item.qty } } });
        } else {
          await tx.stockMovement.create({
            data: { productId: item.productId, type: "WRITE_OFF", quantity: -item.qty, performedById: userId, reference: `RET-${ret.id.slice(0, 8)}` },
          });
        }
      }

      await tx.return.update({ where: { id: ret.id }, data: { status: "PROCESSED" } });
      return ret;
    });
  }

  async findAll(orderId?: string, customerId?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (orderId) where.orderId = orderId;
    if (customerId) where.customerId = customerId;
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
        order: { select: { id: true, orderNumber: true } },
        customer: { select: { id: true, businessName: true } },
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
      },
    });
    if (!ret) throw new NotFoundException("Return not found");
    return ret;
  }
}

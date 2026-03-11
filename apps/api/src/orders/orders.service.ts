import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { OrderStatus, UserRole, ItemStatus, TxnStatus, MutationType } from "@prisma/client";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ChangeOrderStatusDto } from "./dto/change-order-status.dto";
import { CompleteStopDto } from "./dto/complete-stop.dto";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class OrdersService {
  private readonly taxRate: number;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue("invoices") private readonly invoiceQueue: Queue,
    private readonly gateway: RouteFlowGateway,
    private readonly config: ConfigService,
  ) {
    this.taxRate = this.config.get<number>("taxRate") ?? 0.1;
  }

  async findAll(query: ListOrdersDto, user: JwtPayload) {
    const { customerId, status, urgent, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer) throw new ForbiddenException("Customer record not found");
      where.customerId = customer.id;
    } else if (customerId) {
      where.customerId = customerId;
    }

    if (status) where.status = status;
    if (urgent !== undefined) where.urgent = urgent;

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, user: JwtPayload) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true } },
        lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        transaction: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }

    return order;
  }

  async create(dto: CreateOrderDto, user: JwtPayload) {
    if (user.role !== UserRole.CUSTOMER)
      throw new ForbiddenException("Only customers can create orders");

    const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
    if (!customer) throw new ForbiddenException("Customer record not found");

    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.items.map((i) => i.productId) } },
    });

    const productMap = new Map(products.map((p) => [p.id, p]));
    const orderNumber = `ORD-${Date.now()}`;

    let subtotal = 0;
    const lineItemsData = dto.items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
      const unitPrice = Number(product.pricePerUnit);
      const itemSubtotal = unitPrice * item.qty;
      subtotal += itemSubtotal;
      return {
        productId: item.productId,
        qty: item.qty,
        unitPrice,
        subtotal: itemSubtotal,
        notes: item.notes,
      };
    });

    const tax = subtotal * this.taxRate;
    const total = subtotal + tax;

    return this.prisma.order.create({
      data: {
        customerId: customer.id,
        orderNumber,
        subtotal,
        tax,
        total,
        notes: dto.notes,
        urgent: dto.urgent ?? false,
        lineItems: { create: lineItemsData },
      },
      include: {
        lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
      },
    });
  }

  async changeStatus(id: string, dto: ChangeOrderStatusDto, user: JwtPayload) {
    if (user.role !== UserRole.OPERATOR)
      throw new ForbiddenException("Only operators can change order status");
    await this.findOneOrThrow(id);
    return this.prisma.order.update({ where: { id }, data: { status: dto.status } });
  }

  async toggleUrgent(id: string, user: JwtPayload) {
    const order = await this.findOneOrThrow(id);
    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }
    return this.prisma.order.update({ where: { id }, data: { urgent: !order.urgent } });
  }

  async completeStop(runId: string, stopId: string, dto: CompleteStopDto, user: JwtPayload) {
    // Capture IDs of transactions created/updated so we can enqueue PDF jobs after commit
    const invoiceTransactionIds: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      const stop = await tx.routeRunStop.findFirst({
        where: { id: stopId, routeRunId: runId },
        include: { orders: { include: { lineItems: true } } },
      });
      if (!stop) throw new NotFoundException("Route run stop not found");

      for (const delivery of dto.deliveries) {
        const orderItem = await tx.orderItem.findUnique({ where: { id: delivery.orderItemId } });
        if (!orderItem) throw new NotFoundException(`Order item ${delivery.orderItemId} not found`);

        await tx.deliveryMutation.create({
          data: {
            orderId: orderItem.orderId,
            orderItemId: delivery.orderItemId,
            productId: orderItem.productId,
            routeRunStopId: stopId,
            type: delivery.type,
            quantityDelivered: delivery.quantityDelivered,
            note: delivery.note,
            driverId:
              user.role === UserRole.DRIVER
                ? ((await tx.driver.findFirst({ where: { userId: user.sub } }))?.id ?? undefined)
                : undefined,
          },
        });

        let newItemStatus: ItemStatus = ItemStatus.DELIVERED;
        if (delivery.type === MutationType.PARTIAL) newItemStatus = ItemStatus.PARTIAL;
        else if (delivery.type === MutationType.REFUSED) newItemStatus = ItemStatus.CANCELLED;

        await tx.orderItem.update({
          where: { id: delivery.orderItemId },
          data: { status: newItemStatus },
        });
      }

      for (const order of stop.orders) {
        const updatedItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
        const allDelivered = updatedItems.every((i) => i.status === ItemStatus.DELIVERED);
        const anyDelivered = updatedItems.some(
          (i) => i.status === ItemStatus.DELIVERED || i.status === ItemStatus.PARTIAL,
        );
        // Fix H2: allDelivered → DELIVERED, partiallyDelivered → OUT_FOR_DELIVERY, nothing → keep current
        const newOrderStatus = allDelivered
          ? OrderStatus.DELIVERED
          : anyDelivered
            ? OrderStatus.OUT_FOR_DELIVERY
            : order.status;

        await tx.order.update({ where: { id: order.id }, data: { status: newOrderStatus } });

        if (newOrderStatus === OrderStatus.DELIVERED) {
          const createdTxn = await tx.transaction.upsert({
            where: { orderId: order.id },
            create: {
              orderId: order.id,
              customerId: order.customerId,
              totalOwed: order.total,
              status: TxnStatus.UNPAID,
            },
            update: {},
          });
          invoiceTransactionIds.push(createdTxn.id);
        }
      }

      await tx.routeRunStop.update({
        where: { id: stopId },
        data: { status: "COMPLETED", completedAt: new Date(), driverNote: dto.driverNote },
      });
    });

    // Emit real-time updates for each affected order/customer
    const stop = await this.prisma.routeRunStop.findFirst({
      where: { id: stopId, routeRunId: runId },
      include: { orders: { select: { id: true, customerId: true } } },
    });
    if (stop) {
      for (const order of stop.orders) {
        this.gateway.emitStopCompleted({
          runId,
          stopId,
          customerId: order.customerId,
          orderId: order.id,
          completedAt: new Date().toISOString(),
        });
      }
    }

    // Enqueue PDF generation for each new invoice (after DB transaction commits).
    // Retry up to 3x with exponential back-off (5s -> 10s -> 20s).
    for (const txnId of invoiceTransactionIds) {
      await this.invoiceQueue.add(
        "generate-invoice",
        { transactionId: txnId },
        { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
      );
    }

    return { success: true };
  }

  private async findOneOrThrow(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }
}

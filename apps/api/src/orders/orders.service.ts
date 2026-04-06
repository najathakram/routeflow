import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import {
  OrderStatus,
  UserRole,
  ItemStatus,
  TxnStatus,
  MutationType,
  MovementType,
  InvoiceStatus,
  PriceType,
  Prisma,
} from "@prisma/client";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ChangeOrderStatusDto } from "./dto/change-order-status.dto";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { CompleteStopDto } from "./dto/complete-stop.dto";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "../notifications/notifications.service";
import { InvoicesService } from "../invoices/invoices.service";

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly taxRate: number;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue("invoices") private readonly invoiceQueue: Queue,
    private readonly gateway: RouteFlowGateway,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly invoicesService: InvoicesService,
  ) {
    this.taxRate = this.config.get<number>("taxRate") ?? 0.1;
  }

  async findAll(query: ListOrdersDto, user: JwtPayload) {
    const {
      customerId,
      search,
      status,
      urgent,
      page = 1,
      limit = 20,
      deliveryDateFrom,
      deliveryDateTo,
    } = query;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer) throw new ForbiddenException("Customer record not found");
      where.customerId = customer.id;
    } else if (customerId) {
      where.customerId = customerId;
    } else if (search) {
      where.customer = { businessName: { contains: search, mode: "insensitive" } };
    }

    if (status) where.status = status;
    if (urgent !== undefined) where.urgent = urgent;
    if (deliveryDateFrom || deliveryDateTo) {
      where.requestedDeliveryDate = {
        ...(deliveryDateFrom ? { gte: new Date(deliveryDateFrom) } : {}),
        ...(deliveryDateTo ? { lte: new Date(deliveryDateTo) } : {}),
      };
    }

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
        invoice: { select: { id: true, invoiceNumber: true, status: true, total: true } },
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
    // Resolve which customer this order is for
    let customerId: string;

    if (user.role === UserRole.OPERATOR) {
      // Operator creates on behalf of a customer — customerId comes from the DTO
      if (!dto.customerId) throw new BadRequestException("customerId is required");
      const customer = await this.prisma.customer.findUnique({
        where: { id: dto.customerId },
        include: { user: { select: { status: true } } },
      });
      if (!customer) throw new BadRequestException("Customer not found");
      if (customer.user.status === "SUSPENDED")
        throw new BadRequestException("Cannot create orders for a suspended customer");
      customerId = customer.id;
    } else if (user.role === UserRole.DRIVER) {
      // Driver creates on behalf of a customer (e.g. at a stop) — customerId must be supplied
      if (!dto.customerId) throw new BadRequestException("customerId is required");
      const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
      if (!customer) throw new BadRequestException("Customer not found");
      customerId = customer.id;
    } else {
      // Customer creates their own order
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer) throw new ForbiddenException("Customer record not found");
      customerId = customer.id;
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.items.map((i) => i.productId) } },
    });

    const productMap = new Map(products.map((p) => [p.id, p]));

    // Load any permanent customer-specific prices for this order
    const customerPrices = await this.prisma.customerPrice.findMany({
      where: {
        customerId,
        productId: { in: dto.items.map((i) => i.productId) },
      },
    });
    const cpMap = new Map(customerPrices.map((cp) => [cp.productId, Number(cp.specialPrice)]));

    const orderNumber = `ORD-${Date.now()}`;

    let subtotal = 0;
    const lineItemsData = dto.items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

      // Recompute qty from boxes/pieces when provided (backend is authoritative)
      let qty = item.qty;
      if (item.boxes != null || item.pieces != null) {
        const unitsPerBox = Number(product.unitsPerBox ?? 0);
        qty = (item.boxes ?? 0) * unitsPerBox + (item.pieces ?? 0);
      }

      // Price priority: operator one-time override (DISCOUNTED) > permanent special price (SPECIAL) > list price (STANDARD)
      const listPrice = Number(product.pricePerUnit);
      const specialPrice = cpMap.get(item.productId);
      const overridePrice = item.unitPrice;

      let unitPrice: number;
      let priceType: PriceType;
      let originalPrice: number | null = null;

      if (overridePrice != null && overridePrice < listPrice) {
        unitPrice = overridePrice;
        priceType = PriceType.DISCOUNTED;
        originalPrice = listPrice;
      } else if (specialPrice != null) {
        unitPrice = specialPrice;
        priceType = PriceType.SPECIAL;
        originalPrice = listPrice;
      } else {
        unitPrice = listPrice;
        priceType = PriceType.STANDARD;
      }

      const itemSubtotal = unitPrice * qty;
      subtotal += itemSubtotal;
      return {
        productId: item.productId,
        qty,
        boxes: item.boxes ?? null,
        pieces: item.pieces ?? null,
        unitPrice,
        priceType,
        originalPrice,
        subtotal: itemSubtotal,
        notes: (item as any).itemNote || item.notes,
      };
    });

    const orderDiscount = dto.discountAmount ?? 0;
    const tax = subtotal * this.taxRate;
    const total = subtotal + tax - orderDiscount;

    const order = await this.prisma.order.create({
      data: {
        customerId,
        orderNumber,
        subtotal,
        tax,
        total,
        discountAmount: orderDiscount,
        notes: dto.notes,
        urgent: dto.urgent ?? false,
        requestedDeliveryDate: dto.requestedDeliveryDate
          ? new Date(dto.requestedDeliveryDate)
          : undefined,
        lineItems: { create: lineItemsData },
      },
      include: {
        customer: { select: { id: true, businessName: true } },
        lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
      },
    });

    // If driver is creating at a stop, link order to route run and optionally confirm it
    if (dto.routeRunId || dto.routeRunStopId) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          routeRunId: dto.routeRunId ?? null,
          routeRunStopId: dto.routeRunStopId ?? null,
          status: dto.immediateDelivery ? OrderStatus.CONFIRMED : order.status,
        },
      });
      if (dto.immediateDelivery) {
        (order as any).status = OrderStatus.CONFIRMED;
      }
    }

    this.gateway.emitOrderCreated({
      orderId: order.id,
      orderNumber: order.orderNumber ?? "",
      customerId: order.customerId,
      customerName: order.customer.businessName,
      total: Number(order.total),
      urgent: order.urgent,
      createdAt: order.createdAt.toISOString(),
    });

    if (order.urgent) {
      this.gateway.emitUrgentOrder({
        orderId: order.id,
        orderNumber: order.orderNumber ?? "",
        customerId: order.customerId,
        customerName: order.customer.businessName,
        placedAt: order.createdAt.toISOString(),
      });
    }

    return order;
  }

  async changeStatus(id: string, dto: ChangeOrderStatusDto, user: JwtPayload) {
    const order = await this.findOneOrThrow(id);

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
      if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
      // Customers may only cancel their own PENDING orders
      if (dto.status !== OrderStatus.CANCELLED || order.status !== OrderStatus.PENDING) {
        throw new ForbiddenException("Customers can only cancel their own pending orders");
      }
    } else if (user.role === UserRole.DRIVER) {
      // Drivers may only confirm PENDING orders (PENDING → CONFIRMED)
      if (dto.status !== OrderStatus.CONFIRMED || order.status !== OrderStatus.PENDING) {
        throw new ForbiddenException("Drivers can only confirm pending orders");
      }
    } else if (user.role !== UserRole.OPERATOR) {
      throw new ForbiddenException("Only operators can change order status");
    }

    const allowed: Record<string, string[]> = {
      PENDING: ["CONFIRMED", "CANCELLED"],
      CONFIRMED: ["OUT_FOR_DELIVERY", "DELIVERED", "PENDING", "CANCELLED"],
      OUT_FOR_DELIVERY: ["DELIVERED", "CONFIRMED", "CANCELLED"],
      DELIVERED: ["CONFIRMED"],
    };
    if (!(allowed[order.status] ?? []).includes(dto.status)) {
      throw new BadRequestException(`Cannot transition from ${order.status} to ${dto.status}`);
    }

    // Demotions require a reason
    const isDemotion =
      (order.status === "CONFIRMED" && dto.status === "PENDING") ||
      (order.status === "OUT_FOR_DELIVERY" &&
        (dto.status === "PENDING" || dto.status === "CONFIRMED"));
    if (isDemotion && !dto.reason?.trim()) {
      throw new BadRequestException("A reason is required when demoting an order");
    }

    const noteAppend = dto.reason
      ? `\n[${new Date().toLocaleDateString()} – status changed to ${dto.status}: ${dto.reason}]`
      : undefined;

    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: dto.status,
        ...(noteAppend ? { notes: (order.notes ?? "") + noteAppend } : {}),
      },
    });

    this.gateway.emitOrderStatusChanged({
      orderId: id,
      orderNumber: order.orderNumber ?? "",
      customerId: order.customerId,
      status: dto.status,
      previousStatus: order.status,
    });

    // Auto-create invoice when operator manually marks order as delivered
    if (dto.status === OrderStatus.DELIVERED) {
      this.invoicesService.createInvoiceFromOrder(id).catch((err) => {
        this.logger.error(`Failed to auto-create invoice for order ${id}: ${err?.message ?? err}`);
      });
    }

    // Fire-and-forget push notifications for key status transitions
    const notifMap: Partial<Record<OrderStatus, { title: string; body: string }>> = {
      [OrderStatus.CONFIRMED]: {
        title: "Order Confirmed ✓",
        body: `Your order #${order.orderNumber} has been confirmed.`,
      },
      [OrderStatus.OUT_FOR_DELIVERY]: {
        title: "Out for Delivery 🚚",
        body: `Your order #${order.orderNumber} is on its way!`,
      },
      [OrderStatus.DELIVERED]: {
        title: "Order Delivered ✓",
        body: `Your order #${order.orderNumber} has been delivered.`,
      },
      [OrderStatus.CANCELLED]: {
        title: "Order Cancelled",
        body: `Your order #${order.orderNumber} has been cancelled.`,
      },
    };
    const notif = notifMap[dto.status as OrderStatus];
    if (notif) {
      this.notifications
        .sendToCustomer(order.customerId, notif.title, notif.body, { orderId: id })
        .catch(() => {});
    }

    return updated;
  }

  async reopenOrder(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { lineItems: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== OrderStatus.CANCELLED) {
      throw new BadRequestException(`Only CANCELLED orders can be reopened. Current status: ${order.status}`);
    }
    return this.prisma.$transaction(async (tx) => {
      // Revert cancelled line items back to PENDING
      await tx.orderItem.updateMany({
        where: { orderId: id, status: ItemStatus.CANCELLED },
        data: { status: ItemStatus.PENDING },
      });
      return tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.PENDING,
          notes: order.notes
            ? `${order.notes}\n[Reopened ${new Date().toLocaleDateString()}]`
            : `[Reopened ${new Date().toLocaleDateString()}]`,
        },
        include: {
          lineItems: { include: { product: true } },
          customer: { select: { id: true, businessName: true } },
        },
      });
    });
  }

  async updateOrderItems(orderId: string, dto: UpdateOrderItemsDto, user?: JwtPayload) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lineItems: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!["PENDING", "CONFIRMED"].includes(order.status)) {
      throw new BadRequestException("Items can only be edited on PENDING or CONFIRMED orders");
    }

    // Customer/Driver path: replace items by productId
    if (user?.role === UserRole.CUSTOMER || user?.role === UserRole.DRIVER) {
      if (user.role === UserRole.CUSTOMER) {
        const customer = await this.prisma.customer.findFirst({ where: { userId: user.sub } });
        if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
      }

      // Customers send items as { productId, qty } — replace all line items
      const productIds = dto.items.map((i) => i.productId).filter(Boolean) as string[];
      const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });
      const productMap = new Map(products.map((p) => [p.id, p]));

      await this.prisma.orderItem.deleteMany({ where: { orderId } });
      for (const item of dto.items) {
        if (!item.productId || !item.qty) continue;
        const product = productMap.get(item.productId);
        if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
        const unitPrice = Number(product.pricePerUnit);
        await this.prisma.orderItem.create({
          data: {
            orderId,
            productId: item.productId,
            qty: item.qty,
            unitPrice,
            subtotal: item.qty * unitPrice,
            status: "PENDING",
            notes: item.notes,
          },
        });
      }
    } else {
      // Operator path: update by line item id
      for (const item of dto.items) {
        if (item.action === "CANCEL") {
          await this.prisma.orderItem.update({
            where: { id: item.id },
            data: { status: "CANCELLED", qty: 0, subtotal: 0 },
          });
        } else if (item.substituteProductId) {
          const product = await this.prisma.product.findUniqueOrThrow({
            where: { id: item.substituteProductId },
          });
          const existingQty = order.lineItems.find((li) => li.id === item.id)?.qty ?? 1;
          const qtyVal = item.qty ?? Number(existingQty);
          const unitPrice = Number(product.pricePerUnit);
          await this.prisma.orderItem.update({
            where: { id: item.id },
            data: {
              productId: item.substituteProductId,
              unitPrice,
              qty: qtyVal,
              subtotal: qtyVal * unitPrice,
              status: "PENDING",
              notes: item.notes,
            },
          });
        } else if (item.qty !== undefined) {
          const li = order.lineItems.find((li) => li.id === item.id);
          if (!li) continue;
          const unitPrice = Number(li.unitPrice);
          await this.prisma.orderItem.update({
            where: { id: item.id },
            data: {
              qty: item.qty,
              subtotal: item.qty * unitPrice,
              ...(item.notes !== undefined ? { notes: item.notes } : {}),
            },
          });
        }
      }
    }

    // Recalculate order totals from all non-cancelled items
    const activeItems = await this.prisma.orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
    });
    const subtotal = activeItems.reduce((s, li) => s + Number(li.subtotal), 0);
    const tax = subtotal * this.taxRate;
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        subtotal,
        tax,
        total: subtotal + tax,
        ...(dto.orderNotes !== undefined ? { notes: dto.orderNotes } : {}),
      },
    });

    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true } },
        lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        transaction: true,
      },
    });
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

        const driverId =
          user.role === UserRole.DRIVER
            ? ((await tx.driver.findFirst({ where: { userId: user.sub } }))?.id ?? undefined)
            : undefined;

        await tx.deliveryMutation.create({
          data: {
            orderId: orderItem.orderId,
            orderItemId: delivery.orderItemId,
            productId: orderItem.productId,
            routeRunStopId: stopId,
            type: delivery.type,
            quantityDelivered: delivery.quantityDelivered,
            note: delivery.note,
            driverId,
          },
        });

        // Record SALE stock movement (stock can go negative — never blocked)
        let saleQty: Prisma.Decimal | null = null;
        if (delivery.type === MutationType.DELIVERED) {
          saleQty = new Prisma.Decimal(orderItem.qty.toString());
        } else if (delivery.type === MutationType.PARTIAL && delivery.quantityDelivered != null) {
          saleQty = new Prisma.Decimal(delivery.quantityDelivered.toString());
        }
        if (saleQty !== null && saleQty.gt(0)) {
          const order = stop.orders.find((o) => o.id === orderItem.orderId);
          await tx.stockMovement.create({
            data: {
              productId: orderItem.productId,
              type: MovementType.SALE,
              quantity: saleQty.neg(),
              reference: order?.orderNumber ?? null,
              performedById: user.sub,
            },
          });
          await tx.product.update({
            where: { id: orderItem.productId },
            data: { currentStock: { decrement: saleQty } },
          });
        }

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

          // Auto-create Invoice from the delivered order
          const existingInvoice = await tx.invoice.findFirst({ where: { orderId: order.id } });
          if (!existingInvoice) {
            const fullOrder = await tx.order.findUnique({
              where: { id: order.id },
              include: {
                lineItems: {
                  where: { status: { not: ItemStatus.CANCELLED } },
                  include: { product: { select: { name: true } } },
                },
              },
            });
            if (fullOrder && fullOrder.lineItems.length > 0) {
              // Generate invoice number
              const year = new Date().getFullYear();
              const invPrefix = `INV-${year}-`;
              const lastInv = await tx.invoice.findFirst({
                where: { invoiceNumber: { startsWith: invPrefix } },
                orderBy: { invoiceNumber: "desc" },
              });
              const seq = lastInv ? parseInt(lastInv.invoiceNumber.split("-")[2], 10) + 1 : 1;
              const invoiceNumber = `${invPrefix}${String(seq).padStart(4, "0")}`;

              const dueDate = new Date();
              dueDate.setDate(dueDate.getDate() + 30);

              await tx.invoice.create({
                data: {
                  invoiceNumber,
                  customerId: fullOrder.customerId,
                  orderId: fullOrder.id,
                  status: InvoiceStatus.SENT,
                  sentAt: new Date(),
                  subtotal: fullOrder.subtotal,
                  taxAmount: fullOrder.tax,
                  discount: 0,
                  shippingFee: 0,
                  total: fullOrder.total,
                  dueDate,
                  issueDate: new Date(),
                  notes: fullOrder.orderNumber ? `Order #${fullOrder.orderNumber}` : null,
                  items: {
                    create: fullOrder.lineItems.map((li: any) => ({
                      description: li.product?.name ?? "Product",
                      productId: li.productId,
                      qty: Number(li.qty),
                      unitPrice: Number(li.unitPrice),
                      discount: li.originalPrice != null ? Number(li.originalPrice) - Number(li.unitPrice) : 0,
                      originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
                      priceType: li.priceType ?? PriceType.STANDARD,
                      taxRate: 0,
                      subtotal: Number(li.subtotal),
                    })),
                  },
                },
              });
            }
          }
        }
      }

      await tx.routeRunStop.update({
        where: { id: stopId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          driverNote: dto.driverNote,
          podPhotoUrls: dto.podPhotoUrls ?? [],
          signatureUrl: dto.signatureUrl ?? null,
          safeDropEnabled: dto.safeDropEnabled ?? false,
        },
      });

      // Auto-complete the run when all stops are COMPLETED or SKIPPED
      const allStops = await tx.routeRunStop.findMany({
        where: { routeRunId: runId },
        select: { status: true },
      });
      const allDone =
        allStops.length > 0 &&
        allStops.every((s) => s.status === "COMPLETED" || s.status === "SKIPPED");
      if (allDone) {
        await tx.routeRun.update({
          where: { id: runId },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
      }
    });

    // Emit real-time updates for each affected order/customer + push notifications
    const stop = await this.prisma.routeRunStop.findFirst({
      where: { id: stopId, routeRunId: runId },
      include: {
        orders: { select: { id: true, customerId: true, orderNumber: true, status: true } },
      },
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
        if (order.status === OrderStatus.DELIVERED) {
          this.notifications
            .sendToCustomer(
              order.customerId,
              "Order Delivered ✓",
              `Your order #${order.orderNumber} has been delivered.`,
              { orderId: order.id },
            )
            .catch(() => {});
        }
      }
    }

    // Check for low stock on products that were just delivered
    const deliveredProductIds: string[] = [];
    for (const delivery of dto.deliveries) {
      if (delivery.type === MutationType.DELIVERED || delivery.type === MutationType.PARTIAL) {
        const item = await this.prisma.orderItem.findUnique({
          where: { id: delivery.orderItemId },
          select: { productId: true },
        });
        if (item) deliveredProductIds.push(item.productId);
      }
    }
    if (deliveredProductIds.length > 0) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: deliveredProductIds }, reorderPoint: { not: null } },
        select: { id: true, name: true, sku: true, currentStock: true, reorderPoint: true },
      });
      for (const p of products) {
        if (p.reorderPoint !== null && Number(p.currentStock) <= Number(p.reorderPoint)) {
          this.gateway.emitLowStock({
            productId: p.id,
            productName: p.name,
            sku: p.sku ?? "",
            stockLevel: Number(p.currentStock),
          });
        }
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

  async getOrderTracking(orderId: string, user: JwtPayload) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { deliveryWindowStart: true, deliveryWindowEnd: true } },
        routeRunStop: {
          include: {
            routeRun: {
              include: {
                driver: { select: { id: true, contactName: true } },
                route: { select: { id: true, name: true } },
                stops: { orderBy: { stopNumber: "asc" } },
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    if (!order.routeRunStop) {
      return { status: order.status, tracking: null };
    }

    const stop = order.routeRunStop;
    const run = stop.routeRun;
    const allStops = run.stops ?? [];
    const currentStopNumber = stop.stopNumber;

    // Count PENDING stops before this customer's stop
    const stopsAhead = allStops.filter(
      (s) => s.stopNumber < currentStopNumber && s.status === "PENDING",
    ).length;

    return {
      status: order.status,
      tracking: {
        runId: run.id,
        routeName: run.route?.name ?? null,
        driverName: run.driver?.contactName ?? null,
        runStatus: run.status,
        stopNumber: currentStopNumber,
        stopStatus: stop.status,
        stopsAhead,
        estimatedArrivalWindow: {
          start: order.customer?.deliveryWindowStart ?? null,
          end: order.customer?.deliveryWindowEnd ?? null,
        },
      },
    };
  }

  async deleteOrder(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { invoice: { select: { id: true } }, transaction: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");

    const deletableStatuses: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.CANCELLED];
    if (!deletableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Only PENDING or CANCELLED orders can be deleted. This order is ${order.status}.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (order.invoice) {
        await tx.invoicePayment.deleteMany({ where: { invoiceId: order.invoice!.id } });
        await tx.invoiceItem.deleteMany({ where: { invoiceId: order.invoice!.id } });
        await tx.invoice.delete({ where: { id: order.invoice!.id } });
      }
      if (order.transaction) {
        await tx.transactionItem.deleteMany({ where: { transactionId: order.transaction!.id } });
        await tx.payment.deleteMany({ where: { transactionId: order.transaction!.id } });
        await tx.transaction.delete({ where: { id: order.transaction!.id } });
      }
      await tx.deliveryMutation.deleteMany({ where: { orderId: id } });
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      await tx.order.delete({ where: { id } });
    });

    return { success: true };
  }

  async bulkDeleteOrders(ids: string[]) {
    const results = await Promise.allSettled(ids.map((id) => this.deleteOrder(id)));
    const deleted = results.filter((r) => r.status === "fulfilled").length;
    const errors = results
      .map((r, i) => (r.status === "rejected" ? `${ids[i]}: ${(r as PromiseRejectedResult).reason?.message}` : null))
      .filter(Boolean) as string[];
    return { deleted, errors };
  }

  private async findOneOrThrow(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }
}

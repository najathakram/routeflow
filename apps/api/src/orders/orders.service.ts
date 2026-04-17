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
import { getTierPrice } from "../utils/pricing";
import { NotificationsService } from "../notifications/notifications.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue("invoices") private readonly invoiceQueue: Queue,
    private readonly gateway: RouteFlowGateway,
    private readonly notifications: NotificationsService,
    private readonly invoicesService: InvoicesService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /**
   * Read the tax rate from the tenant's Settings (SystemConfig) at request time.
   * Falls back to 0 so that unconfigured tenants don't get a surprise 10% charge.
   */
  private async getTaxRate(): Promise<number> {
    const stored = await this.systemConfig.get("settings.taxRate");
    if (stored !== null && stored !== "") return parseFloat(stored);
    return 0;
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
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
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
      this.prisma.forTenant().order.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().order.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, user: JwtPayload) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            businessName: true,
            contactName: true,
            phone: true,
            mobile: true,
            email: true,
          },
        },
        lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        transaction: true,
        invoices: { select: { id: true, invoiceNumber: true, status: true, total: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }

    return order;
  }

  /**
   * Find the most recent active (DRAFT/PENDING) order for a customer.
   * Used by the buyer portal to merge new items into an existing order.
   */
  async findActiveOrder(customerId: string) {
    return this.prisma.forTenant().order.findFirst({
      where: {
        customerId,
        status: { in: [OrderStatus.DRAFT, OrderStatus.PENDING] },
      },
      include: {
        lineItems: {
          where: { status: { not: ItemStatus.CANCELLED } },
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
        customer: { select: { id: true, businessName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(dto: CreateOrderDto, user: JwtPayload) {
    // Resolve which customer this order is for
    let customerId: string;

    const isStaffRole = user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN;
    if (isStaffRole) {
      // Operator/TENANT_ADMIN creates on behalf of a customer — customerId comes from the DTO
      if (!dto.customerId) throw new BadRequestException("customerId is required");
      const customer = await this.prisma.forTenant().customer.findUnique({
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
      const customer = await this.prisma
        .forTenant()
        .customer.findUnique({ where: { id: dto.customerId } });
      if (!customer) throw new BadRequestException("Customer not found");
      customerId = customer.id;
    } else {
      // Customer creates their own order
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) throw new ForbiddenException("Customer record not found");
      customerId = customer.id;
    }

    const isDraft = dto.status === "DRAFT";
    const items = dto.items ?? [];

    // Non-draft orders require at least one item
    if (!isDraft && items.length === 0) {
      throw new BadRequestException("At least one item is required");
    }

    // Load customer's pricing tier
    const customerRecord = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId }, select: { pricingTier: true } });
    const defaultTier = customerRecord?.pricingTier ?? 1;

    const products =
      items.length > 0
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: items.map((i) => i.productId) } },
          })
        : [];

    const productMap = new Map(products.map((p) => [p.id, p]));

    // Load any per-product tier overrides for this customer
    const customerPrices =
      items.length > 0
        ? await this.prisma.forTenant().customerPrice.findMany({
            where: {
              customerId,
              productId: { in: items.map((i) => i.productId) },
            },
          })
        : [];
    const cpMap = new Map(customerPrices.map((cp) => [cp.productId, cp.pricingTier]));

    // Generate progressive, tenant-scoped order number
    const lastOrder = await this.prisma.forTenant().order.findFirst({
      where: { orderNumber: { startsWith: "ORD-" } },
      orderBy: { orderNumber: "desc" },
      select: { orderNumber: true },
    });
    const seq = lastOrder?.orderNumber
      ? parseInt(lastOrder.orderNumber.replace("ORD-", ""), 10) + 1
      : 1;
    const orderNumber = `ORD-${String(Number.isFinite(seq) ? seq : 1).padStart(5, "0")}`;

    let subtotal = 0;
    const lineItemsData = items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

      // Recompute qty from boxes/pieces when provided (backend is authoritative)
      let qty = item.qty;
      if (item.boxes != null || item.pieces != null) {
        const unitsPerBox = Number(product.unitsPerBox ?? 0);
        qty = (item.boxes ?? 0) * unitsPerBox + (item.pieces ?? 0);
      }

      // Resolve tier: per-product override > customer default tier
      const tierForProduct = cpMap.get(item.productId) ?? defaultTier;
      const tierPrice = getTierPrice(product, tierForProduct);
      const listPrice = Number(product.pricePerUnit); // tier 1 = list price
      const overridePrice = item.unitPrice;

      let unitPrice: number;
      let priceType: PriceType;
      let originalPrice: number | null = null;

      // Price priority: operator one-time override (DISCOUNTED) > tier-resolved price (SPECIAL if not tier 1) > list price (STANDARD)
      if (overridePrice != null && overridePrice < listPrice) {
        unitPrice = overridePrice;
        priceType = PriceType.DISCOUNTED;
        originalPrice = listPrice;
      } else if (tierForProduct !== 1) {
        unitPrice = tierPrice;
        priceType = PriceType.SPECIAL;
        originalPrice = listPrice;
      } else {
        unitPrice = tierPrice;
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
        tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
      };
    });

    const orderDiscount = dto.discountAmount ?? 0;
    const tax = subtotal * await this.getTaxRate();
    const total = subtotal + tax - orderDiscount;

    const order = await this.prisma.forTenant().order.create({
      data: {
        customerId,
        orderNumber,
        status: isDraft ? OrderStatus.DRAFT : OrderStatus.PENDING,
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
      await this.prisma.forTenant().order.update({
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

    // Don't emit real-time events for draft orders
    if (!isDraft) {
      this.gateway.emitOrderCreated(this.prisma.getTenantId(), {
        orderId: order.id,
        orderNumber: order.orderNumber ?? "",
        customerId: order.customerId,
        customerName: order.customer.businessName,
        total: Number(order.total),
        urgent: order.urgent,
        createdAt: order.createdAt.toISOString(),
      });

      if (order.urgent) {
        this.gateway.emitUrgentOrder(this.prisma.getTenantId(), {
          orderId: order.id,
          orderNumber: order.orderNumber ?? "",
          customerId: order.customerId,
          customerName: order.customer.businessName,
          placedAt: order.createdAt.toISOString(),
        });
      }
    }

    return order;
  }

  async changeStatus(id: string, dto: ChangeOrderStatusDto, user: JwtPayload) {
    const order = await this.findOneOrThrow(id);

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
      // Customers may only cancel their own PENDING or DRAFT orders
      if (
        dto.status !== OrderStatus.CANCELLED ||
        (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.DRAFT)
      ) {
        throw new ForbiddenException("Customers can only cancel their own pending orders");
      }
    } else if (user.role === UserRole.DRIVER) {
      // Drivers may only confirm PENDING orders (PENDING → CONFIRMED)
      if (dto.status !== OrderStatus.CONFIRMED || order.status !== OrderStatus.PENDING) {
        throw new ForbiddenException("Drivers can only confirm pending orders");
      }
    } else if (user.role !== UserRole.OPERATOR && user.role !== UserRole.TENANT_ADMIN) {
      throw new ForbiddenException("Only operators can change order status");
    }

    const allowed: Record<string, string[]> = {
      DRAFT: ["PENDING", "CANCELLED"],
      PENDING: ["CONFIRMED", "CANCELLED"],
      CONFIRMED: ["OUT_FOR_DELIVERY", "DELIVERED", "PENDING", "CANCELLED"],
      OUT_FOR_DELIVERY: ["DELIVERED", "PARTIALLY_DELIVERED", "CONFIRMED", "CANCELLED"],
      PARTIALLY_DELIVERED: ["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"],
      DELIVERED: [],
    };
    if (!(allowed[order.status] ?? []).includes(dto.status)) {
      throw new BadRequestException(`Cannot transition from ${order.status} to ${dto.status}`);
    }

    // Demotions require a reason
    const isDemotion =
      (order.status === "CONFIRMED" && dto.status === "PENDING") ||
      (order.status === "OUT_FOR_DELIVERY" &&
        (dto.status === "PENDING" || dto.status === "CONFIRMED")) ||
      (order.status === "PARTIALLY_DELIVERED" && dto.status === "OUT_FOR_DELIVERY");
    if (isDemotion && !dto.reason?.trim()) {
      throw new BadRequestException("A reason is required when demoting an order");
    }

    const noteAppend = dto.reason
      ? `\n[${new Date().toLocaleDateString()} – status changed to ${dto.status}: ${dto.reason}]`
      : undefined;

    const updated = await this.prisma.forTenant().order.update({
      where: { id },
      data: {
        status: dto.status,
        ...(noteAppend ? { notes: (order.notes ?? "") + noteAppend } : {}),
      },
    });

    this.gateway.emitOrderStatusChanged(this.prisma.getTenantId(), {
      orderId: id,
      orderNumber: order.orderNumber ?? "",
      customerId: order.customerId,
      status: dto.status,
      previousStatus: order.status,
    });

    // Auto-create invoice when operator manually marks order as delivered.
    // Capture tenantId now — the fire-and-forget promise escapes the request
    // lifecycle and AsyncLocalStorage context would be lost.
    if (dto.status === OrderStatus.DELIVERED) {
      const capturedTenantId = this.prisma.getTenantId();
      this.invoicesService.createInvoiceFromOrderWithTenant(id, capturedTenantId).catch((err) => {
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
      [OrderStatus.PARTIALLY_DELIVERED]: {
        title: "Partial Delivery 📦",
        body: `Some items from order #${order.orderNumber} have been delivered.`,
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
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id },
      include: { lineItems: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== OrderStatus.CANCELLED) {
      throw new BadRequestException(
        `Only CANCELLED orders can be reopened. Current status: ${order.status}`,
      );
    }

    // Block reopen if any PAID invoices exist for this order (avoid duplicate billing)
    const paidInvoice = await this.prisma.forTenant().invoice.findFirst({
      where: { orderId: id, status: { in: ["PAID", "PARTIAL", "WRITTEN_OFF"] } },
      select: { invoiceNumber: true, status: true },
    });
    if (paidInvoice) {
      throw new BadRequestException(
        `Cannot reopen order: invoice ${paidInvoice.invoiceNumber} is ${paidInvoice.status}. Void or credit the invoice before reopening.`,
      );
    }
    return this.prisma.tenantTransaction(async (tx) => {
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
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: { lineItems: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!["DRAFT", "PENDING", "CONFIRMED"].includes(order.status)) {
      throw new BadRequestException("Items can only be edited on DRAFT, PENDING, or CONFIRMED orders");
    }

    // Customer/Driver path: replace items by productId
    if (user?.role === UserRole.CUSTOMER || user?.role === UserRole.DRIVER) {
      if (user.role === UserRole.CUSTOMER) {
        const customer = await this.prisma
          .forTenant()
          .customer.findFirst({ where: { userId: user.sub } });
        if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
      }

      // Customers send items as { productId, qty } — replace all line items
      const productIds = dto.items.map((i) => i.productId).filter(Boolean) as string[];
      const products = await this.prisma
        .forTenant()
        .product.findMany({ where: { id: { in: productIds } } });
      const productMap = new Map(products.map((p) => [p.id, p]));

      await this.prisma.forTenant().orderItem.deleteMany({ where: { orderId } });
      for (const item of dto.items) {
        if (!item.productId || !item.qty) continue;
        const product = productMap.get(item.productId);
        if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
        const unitPrice = Number(product.pricePerUnit);
        await this.prisma.forTenant().orderItem.create({
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
      // Operator path: update by line item id, or add new item if no id
      for (const item of dto.items) {
        // New item (no id, has productId + qty)
        if (!item.id && item.productId && item.qty) {
          const product = await this.prisma
            .forTenant()
            .product.findUnique({ where: { id: item.productId } });
          if (!product) continue;
          const unitPrice = Number(product.pricePerUnit);
          await this.prisma.forTenant().orderItem.create({
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
          continue;
        }
        if (item.action === "CANCEL") {
          await this.prisma.forTenant().orderItem.update({
            where: { id: item.id },
            data: { status: "CANCELLED", qty: 0, subtotal: 0 },
          });
        } else if (item.substituteProductId) {
          const product = await this.prisma.forTenant().product.findUniqueOrThrow({
            where: { id: item.substituteProductId },
          });
          const existingQty = order.lineItems.find((li) => li.id === item.id)?.qty ?? 1;
          const qtyVal = item.qty ?? Number(existingQty);
          const unitPrice = Number(product.pricePerUnit);
          await this.prisma.forTenant().orderItem.update({
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
          await this.prisma.forTenant().orderItem.update({
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
    const activeItems = await this.prisma.forTenant().orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
    });
    const subtotal = activeItems.reduce((s, li) => s + Number(li.subtotal), 0);
    const tax = subtotal * await this.getTaxRate();
    await this.prisma.forTenant().order.update({
      where: { id: orderId },
      data: {
        subtotal,
        tax,
        total: subtotal + tax,
        ...(dto.orderNotes !== undefined ? { notes: dto.orderNotes } : {}),
      },
    });

    return this.prisma.forTenant().order.findUnique({
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
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }
    return this.prisma.forTenant().order.update({ where: { id }, data: { urgent: !order.urgent } });
  }

  async completeStop(runId: string, stopId: string, dto: CompleteStopDto, user: JwtPayload) {
    // Resolve default invoice terms BEFORE the transaction (avoids nested async DB reads inside tx)
    const { terms: invoiceTerms, dueDays: invoiceDueDays } =
      await this.invoicesService.resolveDefaultTerms();

    // Capture IDs of transactions created/updated so we can enqueue PDF jobs after commit
    const invoiceTransactionIds: string[] = [];

    await this.prisma.tenantTransaction(async (tx) => {
      const stop = await tx.routeRunStop.findFirst({
        where: { id: stopId, routeRunId: runId },
        include: { orders: { include: { lineItems: true } } },
      });
      if (!stop) throw new NotFoundException("Route run stop not found");

      // Resolve driver ID once
      const driverId =
        user.role === UserRole.DRIVER
          ? ((await tx.driver.findFirst({ where: { userId: user.sub } }))?.id ?? undefined)
          : undefined;

      // Create a DeliveryBatch grouping all mutations in this stop completion.
      // Used to link the per-delivery invoice back to this event.
      const customerId = stop.orders[0]?.customerId ?? stop.customerId;
      const batch = await tx.deliveryBatch.create({
        data: {
          customerId: customerId!,
          routeRunStopId: stopId,
          driverId,
          deliveredAt: new Date(),
        },
      });

      // Track which items were delivered in this batch, grouped by orderId
      const batchDeliveredItems = new Map<
        string,
        Array<{ orderItemId: string; productId: string; qty: number; unitPrice: number; productName: string; priceType: string; originalPrice: number | null }>
      >();

      for (const delivery of dto.deliveries) {
        const orderItem = await tx.orderItem.findUnique({
          where: { id: delivery.orderItemId },
          include: { product: { select: { name: true } } },
        });
        if (!orderItem) throw new NotFoundException(`Order item ${delivery.orderItemId} not found`);

        await tx.deliveryMutation.create({
          data: {
            orderId: orderItem.orderId,
            orderItemId: delivery.orderItemId,
            productId: orderItem.productId,
            routeRunStopId: stopId,
            deliveryBatchId: batch.id,
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
          const updatedProduct = await tx.product.update({
            where: { id: orderItem.productId },
            data: { currentStock: { decrement: saleQty } },
            select: { id: true, name: true, currentStock: true },
          });
          // Warn if stock went negative — log for operator review but don't block delivery
          if (Number(updatedProduct.currentStock) < 0) {
            this.logger.warn(
              `Stock went negative for product "${updatedProduct.name}" (${updatedProduct.id}): ` +
              `currentStock=${updatedProduct.currentStock} after delivery of ${saleQty}`,
            );
          }
        }

        // Determine new item status and update deliveredQty
        let newItemStatus: ItemStatus = ItemStatus.DELIVERED;
        let deliveredQtyIncrement = new Prisma.Decimal(0);

        if (delivery.type === MutationType.DELIVERED) {
          newItemStatus = ItemStatus.DELIVERED;
          deliveredQtyIncrement = orderItem.qty; // full delivery
        } else if (delivery.type === MutationType.PARTIAL) {
          newItemStatus = ItemStatus.PARTIAL;
          deliveredQtyIncrement = delivery.quantityDelivered != null
            ? new Prisma.Decimal(delivery.quantityDelivered.toString())
            : new Prisma.Decimal(0);
        } else if (delivery.type === MutationType.REFUSED) {
          newItemStatus = ItemStatus.CANCELLED;
        }

        await tx.orderItem.update({
          where: { id: delivery.orderItemId },
          data: {
            status: newItemStatus,
            deliveredQty: { increment: deliveredQtyIncrement },
          },
        });

        // Track delivered items for per-batch invoice generation
        if (delivery.type === MutationType.DELIVERED || delivery.type === MutationType.PARTIAL) {
          const deliveredQty =
            delivery.type === MutationType.DELIVERED
              ? Number(orderItem.qty)
              : Number(delivery.quantityDelivered ?? 0);
          if (deliveredQty > 0) {
            const items = batchDeliveredItems.get(orderItem.orderId) ?? [];
            items.push({
              orderItemId: orderItem.id,
              productId: orderItem.productId,
              qty: deliveredQty,
              unitPrice: Number(orderItem.unitPrice),
              productName: (orderItem as any).product?.name ?? "Product",
              priceType: orderItem.priceType ?? PriceType.STANDARD,
              originalPrice: orderItem.originalPrice != null ? Number(orderItem.originalPrice) : null,
            });
            batchDeliveredItems.set(orderItem.orderId, items);
          }
        }
      }

      // Determine order status and create per-batch invoices
      for (const order of stop.orders) {
        const updatedItems = await tx.orderItem.findMany({ where: { orderId: order.id } });

        // Check if ALL items are fully delivered (deliveredQty >= qty)
        const allFullyDelivered = updatedItems.every(
          (i) =>
            i.status === ItemStatus.DELIVERED ||
            i.status === ItemStatus.CANCELLED ||
            i.deliveredQty.gte(i.qty),
        );
        const anyDelivered = updatedItems.some(
          (i) =>
            i.status === ItemStatus.DELIVERED ||
            i.status === ItemStatus.PARTIAL ||
            i.deliveredQty.gt(0),
        );
        const allCancelledOrRefused = updatedItems.every(
          (i) => i.status === ItemStatus.CANCELLED,
        );

        let newOrderStatus: OrderStatus;
        if (allCancelledOrRefused) {
          newOrderStatus = OrderStatus.CANCELLED;
        } else if (allFullyDelivered) {
          newOrderStatus = OrderStatus.DELIVERED;
        } else if (anyDelivered) {
          newOrderStatus = OrderStatus.PARTIALLY_DELIVERED;
        } else {
          newOrderStatus = order.status; // no change
        }

        await tx.order.update({
          where: { id: order.id },
          data: {
            status: newOrderStatus,
            ...(newOrderStatus === OrderStatus.DELIVERED ? { deliveredAt: new Date() } : {}),
          },
        });

        // Create Transaction only when order is fully DELIVERED
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

        // Create per-batch invoice for items delivered in THIS batch
        const deliveredInBatch = batchDeliveredItems.get(order.id);
        if (deliveredInBatch && deliveredInBatch.length > 0) {
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
          dueDate.setDate(dueDate.getDate() + invoiceDueDays);

          // Compute totals from delivered items only
          const invoiceSubtotal = deliveredInBatch.reduce(
            (sum, li) => sum + li.qty * li.unitPrice,
            0,
          );

          await tx.invoice.create({
            data: {
              invoiceNumber,
              customerId: order.customerId,
              orderId: order.id,
              deliveryBatchId: batch.id,
              status: InvoiceStatus.SENT,
              sentAt: new Date(),
              subtotal: invoiceSubtotal,
              taxAmount: 0,
              discount: 0,
              shippingFee: 0,
              total: invoiceSubtotal,
              dueDate,
              terms: invoiceTerms,
              issueDate: new Date(),
              notes: order.orderNumber
                ? `Order #${order.orderNumber} — delivery batch`
                : "Delivery batch invoice",
              items: {
                create: deliveredInBatch.map((li) => ({
                  description: li.productName,
                  productId: li.productId,
                  qty: li.qty,
                  unitPrice: li.unitPrice,
                  discount:
                    li.originalPrice != null ? li.originalPrice - li.unitPrice : 0,
                  originalPrice: li.originalPrice,
                  priceType: li.priceType as any,
                  taxRate: 0,
                  subtotal: li.qty * li.unitPrice,
                })),
              },
            },
          });
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
    const stop = await this.prisma.forTenant().routeRunStop.findFirst({
      where: { id: stopId, routeRunId: runId },
      include: {
        orders: { select: { id: true, customerId: true, orderNumber: true, status: true } },
      },
    });
    if (stop) {
      for (const order of stop.orders) {
        this.gateway.emitStopCompleted(this.prisma.getTenantId(), {
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
        } else if (order.status === OrderStatus.PARTIALLY_DELIVERED) {
          this.notifications
            .sendToCustomer(
              order.customerId,
              "Partial Delivery 📦",
              `Some items from order #${order.orderNumber} have been delivered. Remaining items will follow.`,
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
        const item = await this.prisma.forTenant().orderItem.findUnique({
          where: { id: delivery.orderItemId },
          select: { productId: true },
        });
        if (item) deliveredProductIds.push(item.productId);
      }
    }
    if (deliveredProductIds.length > 0) {
      const products = await this.prisma.forTenant().product.findMany({
        where: { id: { in: deliveredProductIds }, reorderPoint: { not: null } },
        select: { id: true, name: true, sku: true, currentStock: true, reorderPoint: true },
      });
      for (const p of products) {
        if (p.reorderPoint !== null && Number(p.currentStock) <= Number(p.reorderPoint)) {
          this.gateway.emitLowStock(this.prisma.getTenantId(), {
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
    const order = await this.prisma.forTenant().order.findUnique({
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
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id },
      include: { invoices: { select: { id: true } }, transaction: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");

    const deletableStatuses: OrderStatus[] = [OrderStatus.DRAFT, OrderStatus.PENDING, OrderStatus.CANCELLED];
    if (!deletableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Only DRAFT, PENDING, or CANCELLED orders can be deleted. This order is ${order.status}.`,
      );
    }

    await this.prisma.tenantTransaction(async (tx) => {
      // Delete all invoices associated with this order
      for (const inv of order.invoices) {
        await tx.invoicePayment.deleteMany({ where: { invoiceId: inv.id } });
        await tx.invoiceItem.deleteMany({ where: { invoiceId: inv.id } });
        await tx.invoice.delete({ where: { id: inv.id } });
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
      .map((r, i) =>
        r.status === "rejected"
          ? `${ids[i]}: ${(r as PromiseRejectedResult).reason?.message}`
          : null,
      )
      .filter(Boolean) as string[];
    return { deleted, errors };
  }

  private async findOneOrThrow(id: string) {
    const order = await this.prisma.forTenant().order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }
}

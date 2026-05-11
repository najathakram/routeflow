import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { computeLineSubtotal } from "../common/pricing";
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
export class OrdersService implements OnApplicationBootstrap {
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
        // Include `unitsPerBox` + `pricePerUnit` so the mobile/web edit UIs
        // can render the boxes/pieces split for boxed products and recompute
        // line subtotals locally without a second roundtrip.
        lineItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                unit: true,
                unitsPerBox: true,
                pricePerUnit: true,
              },
            },
          },
        },
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
    // Orders flagged skipAutoMerge are intentionally kept separate by an operator —
    // do NOT propose them as a merge target. The next operator-initiated create for
    // the same customer should still see no "active" order to merge into.
    return this.prisma.forTenant().order.findFirst({
      where: {
        customerId,
        status: { in: [OrderStatus.DRAFT, OrderStatus.PENDING] },
        skipAutoMerge: false,
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

  /**
   * Consolidate every unassigned PENDING order for a customer into a single
   * "winner" order. The most-recent order is the winner so its unitPrices are
   * the latest. Older orders' line items are folded in (qtys summed when the
   * productId already exists on the winner; new productIds copied over with
   * the most-recent older order's price/metadata). Older orders are then
   * deleted.
   *
   * Skips orders already attached to a route run, with invoices, transactions,
   * or returns — those are already part of an in-flight delivery flow and
   * must not be silently consolidated.
   *
   * Idempotent: when there is 0 or 1 mergeable order, returns it (or null)
   * without writing.
   */
  async mergeAllPendingForCustomer(customerId: string) {
    const pendingOrders = await this.prisma.forTenant().order.findMany({
      where: {
        customerId,
        status: OrderStatus.PENDING,
        routeRunId: null,
        routeRunStopId: null,
        transaction: { is: null },
        invoices: { none: {} },
        returns: { none: {} },
        skipAutoMerge: false,
      },
      include: {
        lineItems: {
          where: { status: { not: ItemStatus.CANCELLED } },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    if (pendingOrders.length <= 1) {
      return pendingOrders[0] ?? null;
    }

    const [winner, ...losers] = pendingOrders;
    const winnerProductIds = new Set(winner.lineItems.map((li) => li.productId));

    // Sum extra qty to apply to winner items that share a productId with losers.
    const qtyAdditions = new Map<string, number>();
    // Collect new items to create on the winner (productIds only on losers).
    // Iteration is updatedAt DESC so the first occurrence wins on price/metadata.
    const newItemsByProductId = new Map<
      string,
      {
        qty: number;
        unitPrice: number;
        priceType: PriceType;
        originalPrice: number | null;
        overrideReason: string | null;
        overriddenBy: string | null;
        notes: string | null;
      }
    >();

    for (const loser of losers) {
      for (const li of loser.lineItems) {
        if (winnerProductIds.has(li.productId)) {
          qtyAdditions.set(li.productId, (qtyAdditions.get(li.productId) ?? 0) + Number(li.qty));
        } else {
          const existing = newItemsByProductId.get(li.productId);
          if (existing) {
            existing.qty += Number(li.qty);
          } else {
            newItemsByProductId.set(li.productId, {
              qty: Number(li.qty),
              unitPrice: Number(li.unitPrice),
              priceType: li.priceType,
              originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
              overrideReason: li.overrideReason,
              overriddenBy: li.overriddenBy,
              notes: li.notes,
            });
          }
        }
      }
    }

    const taxRate = await this.getTaxRate();

    await this.prisma.tenantTransaction(async (tx) => {
      // 1. Bump qty on winner items that overlap with losers.
      for (const li of winner.lineItems) {
        const addQty = qtyAdditions.get(li.productId) ?? 0;
        if (addQty <= 0) continue;
        const newQty = Number(li.qty) + addQty;
        const newSubtotal = newQty * Number(li.unitPrice);
        await tx.orderItem.update({
          where: { id: li.id },
          data: { qty: newQty, subtotal: newSubtotal },
        });
      }

      // 2. Create winner items for productIds that were only on losers.
      for (const [productId, data] of newItemsByProductId.entries()) {
        await tx.orderItem.create({
          data: {
            orderId: winner.id,
            productId,
            qty: data.qty,
            unitPrice: data.unitPrice,
            subtotal: data.qty * data.unitPrice,
            status: ItemStatus.PENDING,
            priceType: data.priceType,
            originalPrice: data.originalPrice,
            overrideReason: data.overrideReason,
            overriddenBy: data.overriddenBy,
            notes: data.notes,
          },
        });
      }

      // 3. Drop loser orders and their items.
      for (const loser of losers) {
        await tx.orderItem.deleteMany({ where: { orderId: loser.id } });
        await tx.order.delete({ where: { id: loser.id } });
      }

      // 4. Recompute winner totals.
      const activeItems = await tx.orderItem.findMany({
        where: { orderId: winner.id, status: { not: ItemStatus.CANCELLED } },
      });
      const subtotal = activeItems.reduce((s: number, li: any) => s + Number(li.subtotal), 0);
      const tax = subtotal * taxRate;
      await tx.order.update({
        where: { id: winner.id },
        data: { subtotal, tax, total: subtotal + tax },
      });
    });

    this.logger.log(
      `Merged ${losers.length} PENDING order(s) into ${winner.id} for customer ${customerId}`,
    );

    return this.prisma.forTenant().order.findUnique({
      where: { id: winner.id },
      include: {
        customer: { select: { id: true, businessName: true } },
        lineItems: {
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
      },
    });
  }

  async forceConsolidateCustomer(customerId: string) {
    const orders = await this.prisma.forTenant().order.findMany({
      where: { customerId, status: OrderStatus.PENDING },
      include: { lineItems: { where: { status: { not: ItemStatus.CANCELLED } } } },
      orderBy: { updatedAt: "desc" },
    });
    if (orders.length <= 1) return orders[0] ?? null;

    const [winner, ...losers] = orders;

    // If winner has no route assignment but losers do, promote the first loser's assignment.
    const routeAssignment =
      winner.routeRunId == null ? (losers.find((o) => o.routeRunId != null) ?? null) : null;

    const winnerProductIds = new Set(winner.lineItems.map((li) => li.productId));
    const qtyAdditions = new Map<string, number>();
    const newItemsByProductId = new Map<
      string,
      {
        qty: number;
        unitPrice: number;
        priceType: PriceType;
        originalPrice: number | null;
        overrideReason: string | null;
        overriddenBy: string | null;
        notes: string | null;
      }
    >();

    for (const loser of losers) {
      for (const li of loser.lineItems) {
        if (winnerProductIds.has(li.productId)) {
          qtyAdditions.set(li.productId, (qtyAdditions.get(li.productId) ?? 0) + Number(li.qty));
        } else {
          const existing = newItemsByProductId.get(li.productId);
          if (existing) {
            existing.qty += Number(li.qty);
          } else {
            newItemsByProductId.set(li.productId, {
              qty: Number(li.qty),
              unitPrice: Number(li.unitPrice),
              priceType: li.priceType,
              originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
              overrideReason: li.overrideReason,
              overriddenBy: li.overriddenBy,
              notes: li.notes,
            });
          }
        }
      }
    }

    const taxRate = await this.getTaxRate();

    await this.prisma.tenantTransaction(async (tx) => {
      for (const li of winner.lineItems) {
        const addQty = qtyAdditions.get(li.productId) ?? 0;
        if (addQty <= 0) continue;
        const newQty = Number(li.qty) + addQty;
        await tx.orderItem.update({
          where: { id: li.id },
          data: { qty: newQty, subtotal: newQty * Number(li.unitPrice) },
        });
      }
      for (const [productId, data] of newItemsByProductId.entries()) {
        await tx.orderItem.create({
          data: {
            orderId: winner.id,
            productId,
            qty: data.qty,
            unitPrice: data.unitPrice,
            subtotal: data.qty * data.unitPrice,
            status: ItemStatus.PENDING,
            priceType: data.priceType,
            originalPrice: data.originalPrice,
            overrideReason: data.overrideReason,
            overriddenBy: data.overriddenBy,
            notes: data.notes,
          },
        });
      }
      for (const loser of losers) {
        await tx.orderItem.deleteMany({ where: { orderId: loser.id } });
        await tx.order.delete({ where: { id: loser.id } });
      }
      const activeItems = await tx.orderItem.findMany({
        where: { orderId: winner.id, status: { not: ItemStatus.CANCELLED } },
      });
      const subtotal = activeItems.reduce((s: number, li: any) => s + Number(li.subtotal), 0);
      const tax = subtotal * taxRate;
      const routeUpdate = routeAssignment
        ? { routeRunId: routeAssignment.routeRunId, routeRunStopId: routeAssignment.routeRunStopId }
        : {};
      await tx.order.update({
        where: { id: winner.id },
        data: { subtotal, tax, total: subtotal + tax, ...routeUpdate },
      });
    });

    this.logger.log(
      `forceConsolidateCustomer: merged ${losers.length} order(s) into ${winner.id} for customer ${customerId}`,
    );
    return this.prisma.forTenant().order.findUnique({
      where: { id: winner.id },
      include: {
        customer: { select: { id: true, businessName: true } },
        lineItems: {
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
      },
    });
  }

  async sweepAllPendingOrders(): Promise<{ customers: number; merged: number }> {
    const groups = await this.prisma.forTenant().order.groupBy({
      by: ["customerId"],
      where: {
        status: OrderStatus.PENDING,
        routeRunId: null,
        routeRunStopId: null,
        transaction: { is: null },
        invoices: { none: {} },
        returns: { none: {} },
        skipAutoMerge: false,
      },
      _count: { _all: true },
      having: { customerId: { _count: { gt: 1 } } },
    });

    let merged = 0;
    for (const g of groups) {
      const winner = await this.mergeAllPendingForCustomer(g.customerId);
      if (winner) merged++;
    }
    this.logger.log(
      `sweepAllPendingOrders: swept ${groups.length} customer(s), merged into ${merged} winner(s)`,
    );
    return { customers: groups.length, merged };
  }

  onApplicationBootstrap() {
    // Fire-and-forget: don't block HTTP server startup while sweeping.
    this.sweepAllPendingOrders()
      .then((result) => {
        if (result.customers > 0) {
          this.logger.log(
            `Startup sweep: merged duplicate PENDING orders for ${result.customers} customer(s)`,
          );
        }
      })
      .catch((err) => {
        this.logger.error("Startup sweep failed", err instanceof Error ? err.stack : String(err));
      });
  }

  @Cron("0 * * * *")
  async cronSweepPendingOrders() {
    try {
      await this.sweepAllPendingOrders();
    } catch (err) {
      this.logger.error("Hourly sweep failed", err instanceof Error ? err.stack : String(err));
    }
  }

  async create(dto: CreateOrderDto, user: JwtPayload, options: { skipAutoMerge?: boolean } = {}) {
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

    // RF-198: price-race check — buyer cart may have been built with a stale price.
    // Re-fetch (already done above) and compare against the cart unitPrice for each item.
    // Only applies when the CUSTOMER role sends unitPrice values (buyer portal checkout).
    if (user.role === UserRole.CUSTOMER && items.some((i) => i.unitPrice != null)) {
      const changedItems: Array<{
        productId: string;
        name: string;
        cartPrice: number;
        currentPrice: number;
      }> = [];
      for (const item of items) {
        if (item.unitPrice == null) continue;
        const product = productMap.get(item.productId);
        if (!product) continue; // missing product caught in lineItemsData.map below
        const tierForProduct = cpMap.get(item.productId) ?? defaultTier;
        const currentPrice = Number(getTierPrice(product, tierForProduct));
        if (Math.abs(currentPrice - item.unitPrice) > 0.01) {
          changedItems.push({
            productId: item.productId,
            name: product.name,
            cartPrice: item.unitPrice,
            currentPrice,
          });
        }
      }
      if (changedItems.length > 0) {
        throw new ConflictException({
          message: "Prices have been updated. Please review your cart.",
          changedItems,
        });
      }
    }

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

      // For boxed products `unitPrice` is the BOX price; loose pieces are
      // prorated. See apps/api/src/common/pricing.ts for the full reasoning.
      const itemSubtotal = computeLineSubtotal({
        unitPrice,
        qty,
        boxes: item.boxes ?? null,
        pieces: item.pieces ?? null,
        unitsPerBox: product.unitsPerBox,
      });
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
    const tax = subtotal * (await this.getTaxRate());
    const total = subtotal + tax - orderDiscount;

    // RF-017 + RF-014: create the order inside a transaction so we can
    // (a) hold a pessimistic lock on product rows while checking/decrementing
    //     stock, preventing concurrent oversell, and
    // (b) retry on P2002 if two requests race to the same order number.
    const MAX_RETRIES = 3;
    let order: any;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        order = await this.prisma.tenantTransaction(async (tx) => {
          // RF-017: stock validation — only for non-draft orders that have items.
          // Lock product rows first so concurrent requests serialise here.
          // Operators (and TENANT_ADMINs) are explicitly allowed to oversell — they may
          // be backordering or knowingly placing an order that will be fulfilled when
          // restocked. The customer / driver paths still hard-block on insufficient stock.
          if (!isDraft && lineItemsData.length > 0) {
            const productIds = lineItemsData.map((li) => li.productId);
            // SELECT … FOR UPDATE acquires row-level locks in the current transaction.
            await tx.$executeRaw`
              SELECT id FROM "Product"
              WHERE id IN (${Prisma.join(productIds)})
              FOR UPDATE
            `;

            const lockedProducts = await tx.product.findMany({
              where: { id: { in: productIds } },
              select: { id: true, name: true, currentStock: true },
            });

            const oosItems: string[] = [];
            for (const li of lineItemsData) {
              const p = lockedProducts.find((lp) => lp.id === li.productId);
              if (p && Number(p.currentStock) < li.qty) {
                oosItems.push(
                  `${productMap.get(li.productId)?.name ?? li.productId}` +
                    ` (available: ${Number(p.currentStock)}, requested: ${li.qty})`,
                );
              }
            }
            if (oosItems.length > 0) {
              if (isStaffRole) {
                this.logger.warn(
                  `Operator-initiated order will go below stock: ${oosItems.join("; ")}`,
                );
              } else {
                throw new ConflictException(`Insufficient stock: ${oosItems.join("; ")}`);
              }
            }

            // Decrement stock atomically while the lock is held. For operator-initiated
            // overselling, this lets currentStock go negative — the inventory page can
            // surface that and the operator can reconcile after restock.
            for (const li of lineItemsData) {
              await tx.product.update({
                where: { id: li.productId },
                data: { currentStock: { decrement: li.qty } },
              });
            }
          }

          // RF-014: generate order number inside the transaction so a P2002 on
          // the @@unique([tenantId, orderNumber]) constraint can be caught and
          // retried with a fresh sequence value.
          const lastOrder = await tx.order.findFirst({
            where: { orderNumber: { startsWith: "ORD-" } },
            orderBy: { orderNumber: "desc" },
            select: { orderNumber: true },
          });
          const seq = lastOrder?.orderNumber
            ? parseInt(lastOrder.orderNumber.replace("ORD-", ""), 10) + 1
            : 1;
          const orderNumber = `ORD-${String(Number.isFinite(seq) ? seq : 1).padStart(5, "0")}`;

          return tx.order.create({
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
              skipAutoMerge: options.skipAutoMerge ?? false,
              requestedDeliveryDate: dto.requestedDeliveryDate
                ? new Date(dto.requestedDeliveryDate)
                : undefined,
              lineItems: { create: lineItemsData },
            },
            include: {
              customer: { select: { id: true, businessName: true } },
              lineItems: {
                include: { product: { select: { id: true, name: true, unit: true } } },
              },
            },
          });
        });
        break; // transaction succeeded
      } catch (e: any) {
        // Retry only on orderNumber unique-constraint violations (RF-014);
        // propagate all other errors immediately (including ConflictException
        // for OOS items from RF-017).
        if (e?.code === "P2002" && attempt < MAX_RETRIES - 1) continue;
        throw e;
      }
    }

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
        order.status = OrderStatus.CONFIRMED;
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
    const notif = notifMap[dto.status];
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
      throw new BadRequestException(
        "Items can only be edited on DRAFT, PENDING, or CONFIRMED orders",
      );
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
      // Operator/admin path
      const allNewItems = dto.items.every((i) => !i.id);

      if (allNewItems) {
        // Mobile "replace-all" pattern: client sends full item list without IDs.
        // Delete existing items then re-create, honoring any per-line price override
        // and any boxes/pieces split (boxed products use BOX-price proration).
        const productIds = dto.items.map((i) => i.productId).filter(Boolean) as string[];
        const products = await this.prisma
          .forTenant()
          .product.findMany({ where: { id: { in: productIds } } });
        const productMap = new Map(products.map((p) => [p.id, p]));

        await this.prisma.forTenant().orderItem.deleteMany({ where: { orderId } });
        for (const item of dto.items) {
          if (!item.productId) continue;
          const product = productMap.get(item.productId);
          if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

          // Recompute qty from boxes/pieces when the operator split a boxed
          // product (matches createOrder's authority). Falls back to plain qty.
          let qty = item.qty ?? 0;
          if (item.boxes != null || item.pieces != null) {
            const upb = Number(product.unitsPerBox ?? 0);
            qty = (item.boxes ?? 0) * upb + (item.pieces ?? 0);
          }
          if (qty <= 0) continue;

          const catalogPrice = Number(product.pricePerUnit);
          const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
          const isManualOverride = overridePrice !== null && overridePrice !== catalogPrice;
          const unitPrice = isManualOverride ? overridePrice : catalogPrice;
          const subtotal = computeLineSubtotal({
            unitPrice,
            qty,
            boxes: item.boxes ?? null,
            pieces: item.pieces ?? null,
            unitsPerBox: product.unitsPerBox,
          });
          await this.prisma.forTenant().orderItem.create({
            data: {
              orderId,
              productId: item.productId,
              qty,
              boxes: item.boxes ?? null,
              pieces: item.pieces ?? null,
              unitPrice,
              subtotal,
              status: "PENDING",
              notes: item.notes,
              priceType: isManualOverride ? PriceType.MANUAL : PriceType.STANDARD,
              originalPrice: isManualOverride ? catalogPrice : null,
              overrideReason: isManualOverride ? (item.overrideReason ?? null) : null,
              overriddenBy: isManualOverride ? (user?.sub ?? null) : null,
            },
          });
        }
      } else {
        // Individual item updates (dispatcher workflow with explicit item IDs)
        for (const item of dto.items) {
          // New item (no id, has productId; qty OR boxes/pieces)
          const newQtyHint = item.boxes != null || item.pieces != null ? 1 : (item.qty ?? 0);
          if (!item.id && item.productId && newQtyHint > 0) {
            const product = await this.prisma
              .forTenant()
              .product.findUnique({ where: { id: item.productId } });
            if (!product) continue;
            // Recompute qty from boxes/pieces when present.
            let qty = item.qty ?? 0;
            if (item.boxes != null || item.pieces != null) {
              const upb = Number(product.unitsPerBox ?? 0);
              qty = (item.boxes ?? 0) * upb + (item.pieces ?? 0);
            }
            if (qty <= 0) continue;
            const catalogPrice = Number(product.pricePerUnit);
            const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
            const isManualOverride = overridePrice !== null && overridePrice !== catalogPrice;
            const unitPrice = isManualOverride ? overridePrice : catalogPrice;
            const subtotal = computeLineSubtotal({
              unitPrice,
              qty,
              boxes: item.boxes ?? null,
              pieces: item.pieces ?? null,
              unitsPerBox: product.unitsPerBox,
            });
            await this.prisma.forTenant().orderItem.create({
              data: {
                orderId,
                productId: item.productId,
                qty,
                boxes: item.boxes ?? null,
                pieces: item.pieces ?? null,
                unitPrice,
                subtotal,
                status: "PENDING",
                notes: item.notes,
                priceType: isManualOverride ? PriceType.MANUAL : PriceType.STANDARD,
                originalPrice: isManualOverride ? catalogPrice : null,
                overrideReason: isManualOverride ? (item.overrideReason ?? null) : null,
                overriddenBy: isManualOverride ? (user?.sub ?? null) : null,
              },
            });
            continue;
          }
          if (item.action === "CANCEL") {
            await this.prisma.forTenant().orderItem.update({
              where: { id: item.id },
              data: { status: "CANCELLED", qty: 0, subtotal: 0, boxes: null, pieces: null },
            });
          } else if (item.substituteProductId) {
            const product = await this.prisma.forTenant().product.findUniqueOrThrow({
              where: { id: item.substituteProductId },
            });
            const existingQty = order.lineItems.find((li) => li.id === item.id)?.qty ?? 1;
            // Substitution may also carry a box/piece split when the substitute
            // is itself a boxed product. Honor it the same way as a fresh add.
            let qtyVal = item.qty ?? Number(existingQty);
            if (item.boxes != null || item.pieces != null) {
              const upb = Number(product.unitsPerBox ?? 0);
              qtyVal = (item.boxes ?? 0) * upb + (item.pieces ?? 0);
            }
            const unitPrice = Number(product.pricePerUnit);
            const subtotal = computeLineSubtotal({
              unitPrice,
              qty: qtyVal,
              boxes: item.boxes ?? null,
              pieces: item.pieces ?? null,
              unitsPerBox: product.unitsPerBox,
            });
            await this.prisma.forTenant().orderItem.update({
              where: { id: item.id },
              data: {
                productId: item.substituteProductId,
                unitPrice,
                qty: qtyVal,
                boxes: item.boxes ?? null,
                pieces: item.pieces ?? null,
                subtotal,
                status: "PENDING",
                notes: item.notes,
                priceType: PriceType.STANDARD,
                originalPrice: null,
                overrideReason: null,
                overriddenBy: null,
              },
            });
          } else if (item.qty !== undefined || item.boxes != null || item.pieces != null) {
            const li = order.lineItems.find((li) => li.id === item.id);
            if (!li) continue;
            // For qty math we need the product's unitsPerBox even if it's not
            // changing — the caller may have edited boxes/pieces only.
            let unitsPerBox: number | null = null;
            if (item.boxes != null || item.pieces != null) {
              const product = await this.prisma.forTenant().product.findUnique({
                where: { id: li.productId },
                select: { unitsPerBox: true },
              });
              unitsPerBox = product?.unitsPerBox ?? null;
            }
            let qty = item.qty ?? Number(li.qty);
            if (item.boxes != null || item.pieces != null) {
              qty = (item.boxes ?? 0) * Number(unitsPerBox ?? 0) + (item.pieces ?? 0);
            }
            if (qty <= 0) continue;
            const existingUnitPrice = Number(li.unitPrice);
            const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
            const isManualOverride = overridePrice !== null && overridePrice !== existingUnitPrice;
            const unitPrice = isManualOverride ? overridePrice : existingUnitPrice;
            const subtotal = computeLineSubtotal({
              unitPrice,
              qty,
              boxes: item.boxes ?? null,
              pieces: item.pieces ?? null,
              unitsPerBox,
            });
            await this.prisma.forTenant().orderItem.update({
              where: { id: item.id },
              data: {
                qty,
                ...(item.boxes != null ? { boxes: item.boxes } : {}),
                ...(item.pieces != null ? { pieces: item.pieces } : {}),
                unitPrice,
                subtotal,
                ...(item.notes !== undefined ? { notes: item.notes } : {}),
                ...(isManualOverride
                  ? {
                      priceType: PriceType.MANUAL,
                      originalPrice: existingUnitPrice,
                      overrideReason: item.overrideReason ?? null,
                      overriddenBy: user?.sub ?? null,
                    }
                  : {}),
              },
            });
          }
        }
      }
    }

    // Recalculate order totals from all non-cancelled items
    const activeItems = await this.prisma.forTenant().orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
    });
    const subtotal = activeItems.reduce((s, li) => s + Number(li.subtotal), 0);
    const tax = subtotal * (await this.getTaxRate());

    // Revert CONFIRMED (or later) orders back to PENDING when items are edited
    // so the operator must re-confirm the updated pick list before dispatch.
    const shouldRevert =
      !["DRAFT", "PENDING"].includes(order.status) &&
      user?.role !== UserRole.CUSTOMER &&
      user?.role !== UserRole.DRIVER;
    const revertNote = shouldRevert
      ? `\n[${new Date().toLocaleDateString()} – items edited, reverted to PENDING]`
      : undefined;

    await this.prisma.forTenant().order.update({
      where: { id: orderId },
      data: {
        subtotal,
        tax,
        total: subtotal + tax,
        ...(shouldRevert ? { status: "PENDING" } : {}),
        ...(dto.orderNotes !== undefined
          ? { notes: (order.notes ?? "") + (revertNote ?? "") + "\n" + dto.orderNotes }
          : revertNote
            ? { notes: (order.notes ?? "") + revertNote }
            : {}),
      },
    });

    if (shouldRevert) {
      this.gateway.emitOrderStatusChanged(this.prisma.getTenantId(), {
        orderId,
        orderNumber: order.orderNumber ?? "",
        status: "PENDING",
        previousStatus: order.status,
        customerId: order.customerId,
      });
    }

    return this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true } },
        lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        transaction: true,
      },
    });
  }

  async toggleUrgent(id: string, user: JwtPayload, urgent?: boolean) {
    const order = await this.findOneOrThrow(id);
    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }
    // If caller provides an explicit value, SET it; otherwise toggle (legacy web clients)
    const newValue = urgent !== undefined ? urgent : !order.urgent;
    return this.prisma.forTenant().order.update({ where: { id }, data: { urgent: newValue } });
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
        Array<{
          orderItemId: string;
          productId: string;
          qty: number;
          unitPrice: number;
          productName: string;
          priceType: string;
          originalPrice: number | null;
        }>
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
                `currentStock=${String(updatedProduct.currentStock)} after delivery of ${String(saleQty)}`,
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
          deliveredQtyIncrement =
            delivery.quantityDelivered != null
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
              productName: orderItem.product?.name ?? "Product",
              priceType: orderItem.priceType ?? PriceType.STANDARD,
              originalPrice:
                orderItem.originalPrice != null ? Number(orderItem.originalPrice) : null,
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
        const allCancelledOrRefused = updatedItems.every((i) => i.status === ItemStatus.CANCELLED);

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
                  discount: li.originalPrice != null ? li.originalPrice - li.unitPrice : 0,
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

    const deletableStatuses: OrderStatus[] = [
      OrderStatus.DRAFT,
      OrderStatus.PENDING,
      OrderStatus.CANCELLED,
    ];
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
        await tx.transactionItem.deleteMany({ where: { transactionId: order.transaction.id } });
        await tx.payment.deleteMany({ where: { transactionId: order.transaction.id } });
        await tx.transaction.delete({ where: { id: order.transaction.id } });
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
      .map((r, i) => (r.status === "rejected" ? `${ids[i]}: ${r.reason?.message}` : null))
      .filter(Boolean) as string[];
    return { deleted, errors };
  }

  private async findOneOrThrow(id: string) {
    const order = await this.prisma.forTenant().order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }
}

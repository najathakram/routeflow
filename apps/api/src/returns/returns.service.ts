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
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly ledger: RegulatedLedgerService,
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
        invoices: { select: { id: true } },
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

    // Query existing returns for this order to prevent cumulative over-return
    const existingReturns = await this.prisma.forTenant().return.findMany({
      where: { orderId: dto.orderId, status: { not: "REJECTED" } },
      include: { items: { select: { productId: true, qty: true } } },
    });

    // Build a map of already-returned quantities per product
    const alreadyReturned: Record<string, number> = {};
    for (const ret of existingReturns) {
      for (const ri of ret.items) {
        alreadyReturned[ri.productId] = (alreadyReturned[ri.productId] ?? 0) + Number(ri.qty);
      }
    }

    // Validate return qty does not exceed ordered qty per item (cumulative)
    for (const item of dto.items) {
      if (!item.qty || item.qty <= 0)
        throw new BadRequestException("Return item quantity must be greater than zero");
      const orderLine = (order as any).lineItems?.find(
        (li: any) => li.productId === item.productId,
      );
      if (!orderLine)
        throw new BadRequestException(`Product ${item.productId} was not in the original order`);
      const orderedQty = Number(orderLine.qty);
      const previouslyReturned = alreadyReturned[item.productId] ?? 0;
      const remaining = orderedQty - previouslyReturned;
      if (item.qty > remaining)
        throw new BadRequestException(
          `Return qty (${item.qty}) exceeds remaining returnable qty (${remaining}) for product ${item.productId}. Already returned: ${previouslyReturned} of ${orderedQty}.`,
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
            tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
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
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
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
    const ret = await this.prisma
      .forTenant()
      .return.findUnique({ where: { id }, include: { items: true } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status !== "IN_TRANSIT")
      throw new BadRequestException("Only IN_TRANSIT returns can be received");

    return this.prisma.tenantTransaction(async (tx) => {
      // Concurrency guard: atomically CLAIM the IN_TRANSIT→RECEIVED transition
      // before any restock or ledger reversal. A racing receive() (double-click,
      // retry, or two operators) matches 0 rows here and aborts, so the goods
      // can't be double-restocked or double-reversed. Under READ COMMITTED the
      // second writer re-checks the WHERE after the row lock, so exactly one wins.
      const claimed = await tx.return.updateMany({
        where: { id, status: "IN_TRANSIT" },
        data: { status: "RECEIVED" },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("Only IN_TRANSIT returns can be received");
      }

      for (const item of ret.items) {
        if (item.restock) {
          // Restock at the current average — leaves the average unchanged but
          // records the cost so COGS/valuation reporting stays complete
          const product = await tx.product.findUnique({
            where: { id: item.productId },
            select: { currentStock: true, averageCost: true },
          });
          const qty = new Prisma.Decimal(item.qty);
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              type: "RETURN",
              quantity: qty,
              unitCost: product?.averageCost ?? null,
              avgCostAfter: product?.averageCost ?? null,
              stockAfter: (product?.currentStock ?? new Prisma.Decimal(0)).add(qty),
              performedById: userId,
              reference: `RET-${ret.id.slice(0, 8)}`,
            },
          });
          await tx.product.update({
            where: { id: item.productId },
            data: { currentStock: { increment: qty } },
          });
        }
      }
      // W5c: reverse the regulated sales ledger for the returned goods (pro-rated,
      // idempotent per return). Independent of `restock` — a returned regulated
      // sale must reverse for tax even if the goods aren't put back in stock.
      const returnedByProduct = new Map<string, number>();
      for (const item of ret.items) {
        returnedByProduct.set(
          item.productId,
          (returnedByProduct.get(item.productId) ?? 0) + Number(item.qty),
        );
      }
      await this.ledger.reverseReturnEntries({
        returnId: ret.id,
        orderId: ret.orderId,
        returnedByProduct,
        db: tx,
      });
      // Status already flipped to RECEIVED by the claim above; return the record.
      return tx.return.findUnique({ where: { id } });
    });
  }

  async processRefund(id: string) {
    const ret = await this.prisma.forTenant().return.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status !== "RECEIVED")
      throw new BadRequestException("Only RECEIVED returns can be refunded");
    return this.prisma.forTenant().return.update({ where: { id }, data: { status: "REFUNDED" } });
  }

  async cancel(id: string, user: JwtPayload) {
    const ret = await this.prisma.forTenant().return.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!ret) throw new NotFoundException("Return not found");
    // SECURITY (F2-001): a CUSTOMER may only cancel their OWN return. Without this
    // check any customer could cancel a tenant-mate's return and reverse stock.
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || ret.customerId !== customer.id) {
        throw new ForbiddenException("You can only cancel your own returns");
      }
    }
    if (ret.status === "CANCELLED") throw new BadRequestException("Return is already cancelled");
    if (ret.status === "REFUNDED")
      throw new BadRequestException("Refunded returns cannot be cancelled");

    return this.prisma.tenantTransaction(async (tx) => {
      // Concurrency guard: claim the →CANCELLED transition atomically so two
      // concurrent cancels can't both run the stock/ledger undo (double-decrement).
      // The loser matches 0 rows and aborts. The RECEIVED/PROCESSED undo below is
      // idempotent-safe under RECEIVED↔PROCESSED staleness (both branches undo).
      const claimed = await tx.return.updateMany({
        where: { id, status: { notIn: ["CANCELLED", "REFUNDED"] } },
        data: { status: "CANCELLED" },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("Return can no longer be cancelled");
      }
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
        // W5c: undo the regulated ledger reversal written at receive() (symmetric
        // to deleting the stock movements above). cancel() blocks REFUNDED returns,
        // so a finalized reversal is never touched.
        await this.ledger.unreverseReturnEntries({ returnId: ret.id, db: tx });
      }
      return tx.return.findUnique({ where: { id } });
    });
  }

  /** RF-081: Fetches a return by ID with ownership enforcement for CUSTOMER role. */
  async findOneForUser(id: string, user: JwtPayload) {
    const ret = await this.findOne(id);
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || ret.customerId !== customer.id) {
        throw new ForbiddenException("You can only view your own returns");
      }
    }
    return ret;
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

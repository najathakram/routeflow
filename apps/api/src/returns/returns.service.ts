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
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { roundMoney } from "@routeflow/pricing";
import type { ProcessRefundDto } from "./dto/process-refund.dto";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly ledger: RegulatedLedgerService,
    private readonly creditNotes: CreditNotesService,
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
    // POST /returns binds `@Body() dto: any`, so nothing validates the payload
    // shape — without this a body with no `items` reached the validation loop
    // below and surfaced as a 500 ("dto.items is not iterable") instead of a 400.
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException("At least one return item is required");
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

    // Cumulative-qty validation and the create must share one transaction: two
    // concurrent requests previously read the same snapshot, both passed the
    // remaining-qty check, and both committed — over-returning the order and
    // (once each was refunded) paying the customer twice for the same goods.
    const ret = await this.prisma.tenantTransaction(async (tx) => {
      // The transaction ALONE does not close the race: tenantTransaction runs at
      // Postgres' default READ COMMITTED, so two concurrent creates would each
      // take a snapshot without the other's uncommitted insert, both pass the
      // remaining-qty check, and both commit. Lock the order row first so they
      // serialize here — mirrors the FOR UPDATE idiom in invoices.service.ts
      // recordPayment() and routes.service.ts dispatch.
      await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${dto.orderId} FOR UPDATE`;

      // Query existing returns for this order to prevent cumulative over-return
      const existingReturns = await tx.return.findMany({
        where: { orderId: dto.orderId, status: { not: "REJECTED" } },
        include: { items: { select: { productId: true, qty: true } } },
      });

      // Build a map of already-returned quantities per product
      const alreadyReturned: Record<string, number> = {};
      for (const r of existingReturns) {
        for (const ri of r.items) {
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
        // Count this line against the running total too: a single payload that
        // lists the same productId twice previously validated every line against
        // the same pre-request snapshot, so 2 × qty 10 against 10 ordered both
        // passed and over-returned with no concurrency involved at all.
        alreadyReturned[item.productId] = previouslyReturned + Number(item.qty);
      }

      return tx.return.create({
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

  async receive(id: string, userId: string, opts?: { restock?: boolean }) {
    const ret = await this.prisma
      .forTenant()
      .return.findUnique({ where: { id }, include: { items: true } });
    if (!ret) throw new NotFoundException("Return not found");
    if (!["APPROVED", "IN_TRANSIT"].includes(ret.status))
      throw new BadRequestException("Only APPROVED or IN_TRANSIT returns can be received");

    return this.prisma.tenantTransaction(async (tx) => {
      // Concurrency guard: atomically CLAIM the APPROVED/IN_TRANSIT→RECEIVED transition
      // before any restock or ledger reversal. A racing receive() (double-click,
      // retry, or two operators) matches 0 rows here and aborts, so the goods
      // can't be double-restocked or double-reversed. Under READ COMMITTED the
      // second writer re-checks the WHERE after the row lock, so exactly one wins.
      const claimed = await tx.return.updateMany({
        where: { id, status: { in: ["APPROVED", "IN_TRANSIT"] } },
        data: { status: "RECEIVED" },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("Only APPROVED or IN_TRANSIT returns can be received");
      }

      if (opts?.restock === false) {
        // "We are not keeping these goods": skip restocking entirely, and persist
        // restock=false on every item so a later cancel() — which decrements stock
        // for every item whose restock flag is true — stays symmetric with what was
        // actually put back on the shelf (nothing).
        await tx.returnItem.updateMany({ where: { returnId: id }, data: { restock: false } });
      } else {
        for (const item of ret.items) {
          if (item.restock) {
            // Restock at the current average — leaves the average unchanged but
            // records the cost so COGS/valuation reporting stays complete
            const product = await tx.product.findFirst({
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

  async processRefund(id: string, dto?: ProcessRefundDto) {
    const method = dto?.method ?? "CREDIT_NOTE";

    const ret = await this.prisma.forTenant().return.findUnique({
      where: { id },
      include: {
        items: true,
        order: {
          select: {
            orderNumber: true,
            // Live sources only (F09 A2): an unfiltered select let a VOID/WRITTEN_OFF
            // sole invoice reach create()'s CREDIT_SOURCE_EXCLUDED guard, which threw
            // AFTER the RECEIVED->REFUNDED claim below had already committed — losing
            // the refund with no recovery path. Zero live invoices now falls into the
            // same "2+ invoices" ternary branch below and mints the credit UNSOURCED.
            invoices: {
              where: { status: { notIn: CREDIT_SOURCE_EXCLUDED } },
              select: { id: true },
            },
            lineItems: { select: { productId: true, qty: true, unitPrice: true, subtotal: true } },
          },
        },
      },
    });
    if (!ret) throw new NotFoundException("Return not found");
    if (ret.status !== "RECEIVED")
      throw new BadRequestException("Only RECEIVED returns can be refunded");

    // Refund value = Σ returned qty × the order line's EFFECTIVE per-unit price
    // (subtotal ÷ qty — robust to box-priced lines where unitPrice is per box while
    // qty is pieces). Items not on the order contribute 0.
    let refundAmount = 0;
    for (const item of ret.items ?? []) {
      const line = ret.order?.lineItems?.find((li) => li.productId === item.productId);
      if (!line) continue;
      const lineQty = Number(line.qty);
      const perUnit = lineQty > 0 ? Number(line.subtotal) / lineQty : Number(line.unitPrice);
      refundAmount += Number(item.qty) * perUnit;
    }
    refundAmount = roundMoney(refundAmount);

    // Concurrency guard: atomically CLAIM the RECEIVED→REFUNDED transition — and persist
    // the resolution snapshot (method/amount/timestamp) in that SAME write — before
    // minting any store credit. A racing processRefund (double-click, client retry, or
    // two operators) matches 0 rows here and aborts, so a single return can never mint
    // two credits or record two resolutions. Mirrors receive()'s claim above — under READ
    // COMMITTED the second writer re-checks the WHERE after the row lock, so exactly one wins.
    const claimed = await this.prisma.forTenant().return.updateMany({
      where: { id, status: "RECEIVED" },
      data: {
        status: "REFUNDED",
        refundMethod: method,
        refundAmount,
        refundedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Only RECEIVED returns can be refunded");
    }
    const updated = await this.prisma.forTenant().return.findUnique({ where: { id } });

    // EXTERNAL_REFUND: the money was returned outside RouteFlow. Record it, mint nothing.
    if (method === "EXTERNAL_REFUND") return updated;

    if (refundAmount <= 0.001) return updated;

    // Sequential, NOT nested: create() opens its own Serializable tx and books NO
    // regulated reversal for a lump-sum credit (no items) — the returned regulated
    // goods were already reversed at receive(). Single source invoice engages the cap.
    const invoices = ret.order?.invoices ?? [];
    const cn = await this.creditNotes.create({
      customerId: ret.customerId,
      invoiceId: invoices.length === 1 ? invoices[0].id : undefined,
      amount: refundAmount,
      reason: `Refund for return ${ret.returnNumber ?? ret.id.slice(0, 8)}`,
    });
    await this.prisma.forTenant().return.update({ where: { id }, data: { creditNoteId: cn.id } });

    return { ...updated, creditNoteId: cn.id };
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
            lineItems: { select: { productId: true, qty: true, unitPrice: true, subtotal: true } },
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

    // Surface the resolution: Return.creditNoteId is populated by processRefund but never
    // reached a client before. There is no Prisma relation here (legacy rows may point at a
    // deleted credit note — see WP0's schema note), so the lookup is manual and tolerant of a miss.
    let creditNote: any = null;
    if (ret.creditNoteId) {
      creditNote = await this.prisma.forTenant().creditNote.findFirst({
        where: { id: ret.creditNoteId },
        select: { id: true, creditNoteNumber: true, amount: true, status: true },
      });
    }

    // The same Σ qty × (subtotal/qty) figure processRefund computes, so a client can show
    // the amount BEFORE resolving without re-deriving box-priced money itself.
    let refundEstimate = 0;
    for (const item of ret.items) {
      const line = ret.order?.lineItems?.find((li) => li.productId === item.productId);
      if (!line) continue;
      const lineQty = Number(line.qty);
      const perUnit = lineQty > 0 ? Number(line.subtotal) / lineQty : Number(line.unitPrice);
      refundEstimate += Number(item.qty) * perUnit;
    }
    refundEstimate = roundMoney(refundEstimate);

    return { ...ret, items: enrichedItems, creditNote, refundEstimate };
  }
}

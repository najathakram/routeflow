import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { FulfillPath } from "@prisma/client";
import { roundMoney, remainingCapacity } from "@routeflow/pricing";
import type { CounterSaleResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoicesService } from "../../invoices/invoices.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { OrdersService } from "../orders.service";
import type { CounterSaleDto } from "./counter-sale.dto";
import { counterSaleGate } from "./capability-shape";
import { resolveLineUnits, type LineUnitsProduct } from "../../products/line-units";
import { saleChangedConflict, saleVoidedConflict, storedSaleState } from "../sale-replay-guard";
import { toCounterOrderItem } from "./counter-sale-lines";
import { canEditPrices } from "./can-edit-prices";
import { resolveTierPrices } from "./counter-sale-tier-price";
import { assertReplaySamePrices } from "./counter-sale-replay-price";
import { AuditService } from "../../audit/audit.service";
import {
  buildCounterSaleResponse,
  isCounterTenderCashRow,
  isTender,
  type InvoiceRow,
} from "./counter-sale-readback";
import {
  FULFILMENT_CAPABILITY_READER,
  type FulfilmentCapabilityReader,
} from "./fulfilment-capability-reader";
import {
  allocateOldestFirst,
  assertPaymentShape,
  assertWalkInTenderCoversTotal,
  type CounterPaymentMethod,
  planCounterPayment,
  toPrismaMethod,
} from "./counter-sale-payment";
import {
  autoApplyCandidateWhere,
  creditAutoApplyOnSend,
  hasOpenCreditBalance,
} from "../../credit-notes/auto-apply-candidates";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../../common/db-locks";
import { WalkInCustomerService } from "./walk-in-customer";

// A customer id no row holds: lets the tenant-wide steps of the replay lookup answer by key alone.
const NO_CUSTOMER = "00000000-0000-0000-0000-000000000000";

/**
 * POST /orders/counter-sale (SA-655): ONE staff call that rings an over-the-counter sale as a
 * PICKUP order, invoices it, and records the tender.
 *
 * It composes services that each own their own transaction, so the unit is NOT atomic, and is built
 * so every failure leaves something honest:
 *  - everything judged from the request alone is refused BEFORE anything is written;
 *  - `OrdersService.createSale` (create -> DELIVERED -> invoice -> send) writes the sale. A refusal from
 *    create() (credit limit, license, selling restriction) is atomic inside create(): nothing written.
 *    A failure after create leaves a DELIVERED order that a retry with the SAME Idempotency-Key finishes;
 *  - the payment runs after the sale commits against the invoice's server-computed POST-send balance.
 *    If it cannot be recorded the sale stays an open invoice on account and the 201 says so
 *    (`paymentRecorded: false` + `paymentErrorCode`); it is never rolled back;
 *  - `recordPayment` has no key of its own, so a replay records only the SHORTFALL between the planned
 *    allocation and the tender already stored per invoice (a partial first attempt is resumed, never
 *    repeated), and `paymentRecorded` always comes from what is STORED.
 *
 * No line/tax/total math lives here (create() + @routeflow/pricing own it) and no stock call: the one
 * decrement is create()'s. Staff oversell is allowed by policy (oversell-policy.ts), so there is no
 * stock refusal to map. No lock is added: skipAutoMerge bypasses every merge path.
 *
 * Known gap: two truly concurrent first submits of one key can both resume the invoice step (createSale
 * has no order-keyed lock); the key makes a sequential retry safe, and the invoice row lock keeps the
 * payment single.
 */
@Injectable()
export class CounterSaleService {
  private readonly logger = new Logger(CounterSaleService.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly invoices: InvoicesService,
    private readonly walkIns: WalkInCustomerService,
    private readonly prisma: PrismaService,
    @Inject(FULFILMENT_CAPABILITY_READER)
    private readonly capability: FulfilmentCapabilityReader,
    private readonly audit: AuditService,
  ) {}

  async ring(
    dto: CounterSaleDto,
    user: JwtPayload,
    idempotencyKey?: string,
  ): Promise<CounterSaleResponse> {
    // 1. Gate: the tenant's capability must offer a counter.
    const cap = await this.capability.get(this.prisma.getTenantId());
    if (!counterSaleGate(cap)) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.COUNTER_SALES_DISABLED,
        message: "Counter sales are not turned on for this business.",
      });
    }

    // 2. Request-only validation: nothing is written until all of it passes.
    if (dto.walkIn && dto.customerId) {
      throw new BadRequestException({
        code: API_ERROR_CODES.WALK_IN_WITH_CUSTOMER,
        message: "Choose a customer or a walk-in, not both",
      });
    }
    if (!dto.walkIn && !dto.customerId) {
      throw new BadRequestException("Choose a customer or mark the sale as a walk-in");
    }
    const walkIn = !!dto.walkIn;
    assertPaymentShape(dto.payment, walkIn);

    // 3. Tenant-scoped existence checks (another tenant's ids are simply not found).
    const packs = await this.assertProductsExist(dto.items.map((i) => i.productId));
    let customerId: string;
    if (walkIn) {
      customerId = await this.walkIns.getOrCreateWalkIn();
      // send() auto-applies the customer's oldest open credits: a walk-in has no business holding
      // any, and the tender below would then be judged against a balance the clerk never saw.
      await this.assertNoOpenCredit(customerId);
    } else {
      const customer = await this.prisma.forTenant().customer.findFirst({
        where: { id: dto.customerId, deletedAt: null },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException("Customer not found");
      customerId = customer.id;
    }

    // 4. The sale. create()'s own refusals propagate untouched.
    let replayed = false;
    const primary = await this.orders.createSale(
      {
        customerId,
        items: dto.items.map((i) => toCounterOrderItem(i, packs.get(i.productId) ?? null)),
        notes: dto.notes,
        deliveredNow: true,
        idempotencyKey,
      } as never,
      user,
      {
        fulfillPath: FulfillPath.PICKUP,
        counterSale: true,
        // POS-5: create() refuses a real price change from a caller who may not make one (403
        // PRICE_EDIT_NOT_PERMITTED), against its own server-resolved price and before any write.
        priceEditAllowed: canEditPrices(user),
        // B1209: a walk-in's tender is judged against the SERVER total inside create(), before anything is written.
        beforeWrite: walkIn
          ? ({ total }) => assertWalkInTenderCoversTotal(dto.payment, total)
          : undefined,
        // The walk-in has no mailbox: no INVOICE_SENT message (never sendEmail for them either).
        suppressInvoiceNotify: walkIn || undefined,
        onReplay: (existing) => {
          // The replay lookup does not filter on counterSale (keys are client UUIDs per tenant), so a
          // key that belongs to an ordinary staff/buyer order lands here. Refuse BEFORE any write.
          if (existing.counterSale !== true) {
            throw new ConflictException({
              code: API_ERROR_CODES.COUNTER_SALE_KEY_CONFLICT,
              message:
                "This Idempotency-Key already belongs to another order, not a counter sale. Start a new sale.",
            });
          }
          // POS-5: a price that differs from the stored sale's is a changed cart, like any other.
          assertReplaySamePrices(existing, dto.items);
          replayed = true;
        },
      },
    );
    const orderId: string = primary.orderId;
    const order = await this.prisma.forTenant().order.findFirst({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        // POS-5: only the lines a staff price change produced (read back from storage for the audit row).
        lineItems: {
          where: { overriddenBy: { not: null } },
          select: {
            productId: true,
            unitPrice: true,
            originalPrice: true,
            priceType: true,
            overrideReason: true,
          },
          orderBy: { position: "asc" },
        },
      },
    });
    if (!replayed) await this.auditPriceEdits(user, order, customerId);

    // 5. The tender, against what is STORED now. The re-read -> "no tender yet" -> record window runs
    // under the shared advisory lock keyed on the order, so two concurrent same-key submits cannot
    // both pass the test (recordPayment has no key of its own). ON_ACCOUNT takes no money: no lock.
    const method = dto.payment.method;
    let invoices: InvoiceRow[];
    let planError: string | undefined;
    if (method === "ON_ACCOUNT") {
      invoices = await this.readInvoices(orderId);
    } else {
      try {
        const locked = await withAdvisoryLock(
          { family: "counter-tender", key: orderId, mode: "wait" },
          () => this.tender(dto, orderId),
        );
        if (!locked.acquired) throw new LockTimeoutError("counter-tender", orderId, 0);
        ({ invoices, planError } = locked.value);
      } catch (e) {
        // The sale is already committed: a contended or unavailable lock must not turn into a 500 over a
        // finished sale. It reads as an unrecorded payment (the invoice stays open; the same key retried
        // finishes it). Errors from inside the locked section are not lock errors and still propagate.
        if (!(e instanceof LockTimeoutError || e instanceof LockUnavailableError)) throw e;
        this.logger.warn(`counter sale ${orderId}: tender lock not taken (${e.message})`);
        planError = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
        invoices = await this.readInvoices(orderId);
      }
    }

    // SA-764: the stored tendered as the tender left it (the pre-tender read above may hold a stale figure).
    // Any non-ON_ACCOUNT request, so a CARD replay on a sale first tendered in CASH serves what by-key serves.
    const tendered =
      method !== "ON_ACCOUNT"
        ? await this.prisma
            .forTenant()
            .order.findFirst({ where: { id: orderId }, select: { counterCashTendered: true } })
        : null;
    return buildCounterSaleResponse({
      payment: dto.payment,
      order: order && { ...order, counterCashTendered: tendered?.counterCashTendered },
      invoices,
      replayed,
      planError,
    });
  }

  /**
   * POS-5: ONE `counter-sale.price-edited` audit row per NEW sale that carries a price change, written from the
   * STORED lines (never the request). No row when nothing was edited or on a replay (known gap: if the first attempt
   * died after the sale committed, its retry is a replay and writes none; the line's own `overriddenBy` +
   * `overrideReason` remain the durable record). The sale is already committed: a failure here is logged, never thrown.
   */
  private async auditPriceEdits(
    user: JwtPayload,
    order: {
      id: string;
      orderNumber?: string | null;
      lineItems?: Array<{
        productId?: string | null;
        unitPrice: unknown;
        originalPrice?: unknown;
        priceType?: string | null;
        overrideReason?: string | null;
      }> | null;
    } | null,
    customerId: string,
  ): Promise<void> {
    const edited = order?.lineItems ?? [];
    if (!order || edited.length === 0) return;
    try {
      // The TIER price each edit started from (originalPrice is the LIST price): server-resolved, read-only.
      const tierPrices = await resolveTierPrices(
        this.prisma.forTenant(),
        customerId,
        edited.flatMap((l) => (l.productId ? [l.productId] : [])),
      );
      await this.audit.log({
        tenantId: this.prisma.getTenantId() ?? null,
        userId: user.sub,
        impersonatedBy: user.impersonatedBy ?? null,
        action: "counter-sale.price-edited",
        entityType: "Order",
        entityId: order.id,
        meta: {
          orderNumber: order.orderNumber,
          lines: edited.map((l) => ({
            productId: l.productId ?? null,
            originalPrice: l.originalPrice == null ? null : Number(l.originalPrice),
            tierPrice: (l.productId ? tierPrices.get(l.productId) : undefined) ?? null,
            unitPrice: Number(l.unitPrice),
            priceType: l.priceType ?? null,
            reason: l.overrideReason ?? null,
          })),
        },
      });
    } catch (e) {
      this.logger.warn(
        `counter sale ${order.id}: price-edit audit not written (${(e as Error)?.message ?? e})`,
      );
    }
  }

  /**
   * The locked half of the tender. Replay-safe by comparing what is STORED per invoice with the planned
   * allocation and recording only the shortfall. That comparison is sound here because a counter sale's
   * invoices are born in the same request as the tender, so any stored tender is this sale's own earlier
   * attempt (pickup-complete's invoice pre-exists, so it must key on the request instead).
   */
  private async tender(
    dto: CounterSaleDto,
    orderId: string,
  ): Promise<{ invoices: InvoiceRow[]; planError?: string }> {
    let invoices = await this.readInvoices(orderId);
    let planError: string | undefined;
    const method = dto.payment.method;
    // The plan is made against each invoice's balance BEFORE any tender of this sale (its total less the
    // wallet credit applied), so a replay computes the SAME allocation the first call did; what is already
    // stored per invoice is then subtracted and only the SHORTFALL is recorded. "A tender exists" is not
    // "recorded": a first call that paid sibling 1 and failed on sibling 2 is resumed, never repeated.
    const balances = invoices.map((i) => ({
      id: i.id,
      balance: remainingCapacity(
        Number(i.total),
        (i.payments ?? []).filter((p) => !isTender(p)),
      ),
    }));
    const plan = planCounterPayment({
      method,
      amount: dto.payment.amount,
      balance: roundMoney(balances.reduce((sum, b) => sum + b.balance, 0)),
    });
    if (plan.kind === "refuse") {
      // A refusal only stands when nothing was taken yet: a stored tender means a payment already went in.
      if (!invoices.some((i) => (i.payments ?? []).some(isTender))) planError = plan.code;
    } else if (plan.kind === "pay") {
      // SA-764: the CASH handed over is stored BEFORE any money moves, so a paid sale can never lack its tender.
      // Until a CASH tender row anchors it the amount is overwritten (a failed first attempt's stale figure must
      // not survive a retry); once one exists it is frozen (only a NULL is filled). Same lock, no transaction.
      if (method === "CASH") {
        const anchored = invoices.some((i) => (i.payments ?? []).some(isCounterTenderCashRow));
        try {
          await this.prisma.forTenant().order.updateMany({
            where: anchored ? { id: orderId, counterCashTendered: null } : { id: orderId },
            data: { counterCashTendered: roundMoney(plan.tendered) },
          });
        } catch (e) {
          this.logger.warn(
            `counter sale ${orderId}: cash tendered not stored (${(e as Error)?.message ?? e})`,
          );
          planError = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
        }
      }
      // A tender that could not be stored takes NO money: the payment loop is skipped entirely.
      if (!planError) {
        try {
          for (const part of allocateOldestFirst(balances, plan.amount)) {
            const row = invoices.find((i) => i.id === part.invoiceId)!;
            const stored = roundMoney(
              (row.payments ?? [])
                .filter((p) => isTender(p))
                .reduce((sum, p) => sum + Number(p.amount), 0),
            );
            const due = roundMoney(
              Math.min(part.amount - stored, remainingCapacity(Number(row.total), row.payments)),
            );
            if (due <= 0) continue;
            await this.invoices.recordPayment(part.invoiceId, {
              amount: due,
              method: toPrismaMethod(method)!,
              reference: dto.payment.reference,
            } as never);
          }
        } catch (e) {
          this.logger.warn(
            `counter sale ${orderId}: payment not recorded (${(e as Error)?.message ?? e})`,
          );
          planError = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
        }
      }
      invoices = await this.readInvoices(orderId);
    }
    return { invoices, planError };
  }

  /**
   * GET /orders/counter-sale/by-key/:key. The sale this key rang, from STORAGE: the same replay lookup
   * create() uses (`findReplayCandidateByKey`: key table first, then the Order column; tenant-scoped), then
   * the same read-back `ring` ends with, `replayed: true`. No writes, no payment, no capability gate.
   * Without the request's payment the body carries no `change`, and `paymentRecorded` is read from what is
   * stored: an ON_ACCOUNT sale (no tender, nothing asked of the till) reads `paymentRecorded:true`, a stored
   * tender that leaves balance owing reads `false`. With the till's own `method` POST's rule applies to it
   * (a tender that failed completely reads `false`). A half-written sale (no invoice rows at all) is a coded 409
   * COUNTER_SALE_INCOMPLETE (re-POST finishes it); a voided or cancelled one is COUNTER_SALE_VOIDED (start a
   * new sale); a moved order with no invoice is COUNTER_SALE_CHANGED (check with the office, do not re-ring); nothing stored for the key, or an order whose Order.counterSale marker is not true (a staff/buyer order that shares the key store), is a definitive 404.
   */
  async byKey(key: string, method?: CounterPaymentMethod): Promise<CounterSaleResponse> {
    // The replay lookup rides forTenant(), which is UNSCOPED without a tenant: refuse, like create().
    if (!this.prisma.getTenantId()) {
      throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
    }
    // A customer id no row can hold: only the tenant-wide steps of the lookup can match (the key is the
    // identity here, not the customer).
    const order = await this.orders.findReplayCandidateByKey(key, NO_CUSTOMER);
    if (!order || order.counterSale !== true) {
      throw new NotFoundException({
        code: API_ERROR_CODES.COUNTER_SALE_NOT_FOUND,
        message: "No sale exists for this key",
      });
    }
    // The ONE stored-sale rule (shared with createSale's replay guard): voided / cancelled is definitive,
    // an order with no invoice rows at all is half-written, anything else is a live sale.
    const all = await this.prisma
      .forTenant()
      .invoice.findMany({ where: { orderId: order.id }, select: { status: true } });
    const state = storedSaleState(
      order.status,
      all.map((r: { status: string }) => r.status),
    );
    if (state === "voided") throw saleVoidedConflict();
    if (state === "changed") throw saleChangedConflict();
    if (state === "incomplete") {
      throw new ConflictException({
        code: API_ERROR_CODES.COUNTER_SALE_INCOMPLETE,
        message: "This sale was not finished: re-POST with the same key to finish it",
      });
    }
    const invoices = await this.readInvoices(order.id);
    // With the till's own method the SAME rule POST applies decides paymentRecorded (one function, no copy).
    return buildCounterSaleResponse({
      payment: method ? { method } : undefined,
      order,
      invoices,
      replayed: true,
    });
  }

  /** Every product must exist for this tenant; answers each one's pack size (the writer's `unitsPerBox`). */
  private async assertProductsExist(productIds: string[]): Promise<Map<string, number | null>> {
    const unique = [...new Set(productIds)];
    const found: Array<LineUnitsProduct & { id: string }> = await this.prisma
      .forTenant()
      .product.findMany({
        where: { id: { in: unique } },
        select: { id: true, unit: true, unitsPerBox: true },
      });
    if (found.length !== unique.length) throw new NotFoundException("Product not found");
    // The pack factor of a plain, label-less counter line, read the ONE sanctioned way (resolveLineUnits,
    // units_v1), never off the product.
    return new Map(found.map((row) => [row.id, resolveLineUnits(row, [], null).unitsPerBox]));
  }

  private async assertNoOpenCredit(customerId: string): Promise<void> {
    // When the tenant's send-time sweep is OFF (the default) send() applies nothing, so nothing can leak.
    if (!(await creditAutoApplyOnSend(this.prisma.forTenant(), this.prisma.getTenantId()))) return;
    // The SAME selection markSent's auto-apply uses (credit-notes/auto-apply-candidates), not just ISSUED.
    const notes = await this.prisma.forTenant().creditNote.findMany({
      where: autoApplyCandidateWhere({ customerId, now: new Date() }),
      select: { amount: true, amountUsed: true },
    });
    if (notes.some((n: any) => hasOpenCreditBalance(n))) {
      throw new ConflictException({
        code: API_ERROR_CODES.WALK_IN_OPEN_CREDIT,
        message:
          "The walk-in customer holds open credit, which would be applied to this sale. Resolve it first.",
      });
    }
  }

  private async readInvoices(orderId: string): Promise<InvoiceRow[]> {
    return this.prisma.forTenant().invoice.findMany({
      // A VOID / WRITTEN_OFF invoice is not part of the sale (recordPayment refuses both): reading it
      // back would put its id, total and balance into the response and the tender plan.
      where: { orderId, status: { notIn: ["VOID", "WRITTEN_OFF"] } },
      include: { payments: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    });
  }
}

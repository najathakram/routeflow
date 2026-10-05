import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { FulfillPath } from "@prisma/client";
import { roundMoney, sumConfirmed, remainingCapacity } from "@routeflow/pricing";
import type { CounterSaleResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoicesService } from "../../invoices/invoices.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { OrdersService } from "../orders.service";
import type { OrderItemDto } from "../dto/create-order.dto";
import type { CounterSaleDto } from "./counter-sale.dto";
import { counterSaleGate } from "./capability-shape";
import {
  FULFILMENT_CAPABILITY_READER,
  type FulfilmentCapabilityReader,
} from "./fulfilment-capability-reader";
import {
  allocateOldestFirst,
  assertPaymentShape,
  planCounterPayment,
  toPrismaMethod,
} from "./counter-sale-payment";
import {
  autoApplyCandidateWhere,
  hasOpenCreditBalance,
} from "../../credit-notes/auto-apply-candidates";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../../common/db-locks";
import { WalkInCustomerService } from "./walk-in-customer";

type InvoiceRow = {
  id: string;
  invoiceNumber?: string;
  total: unknown;
  payments?: Array<{ id: string; amount: unknown; method?: string; status?: string }>;
};

/**
 * A payment the counter itself took (cash / card / check): not a credit-note or advance application.
 * scan-ok: draft-payment-not-void — a replay asks "was a tender already recorded?", and a VOIDED one
 * does not count; the counter never writes a DRAFT payment (recordPayment's default status is PAID).
 */
const isTender = (p: { method?: string; status?: string }) =>
  p.status !== "VOID" && p.method !== "CREDIT_NOTE" && p.method !== "ADVANCE";

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
 *  - `recordPayment` has no key of its own, so a replay records a payment ONLY if the sale's invoices
 *    hold no tender yet, and `paymentRecorded` always comes from what is STORED.
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
    await this.assertProductsExist(dto.items.map((i) => i.productId));
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
        items: dto.items.map(toOrderItem),
        notes: dto.notes,
        deliveredNow: true,
        idempotencyKey,
      } as never,
      user,
      {
        fulfillPath: FulfillPath.PICKUP,
        // The walk-in has no mailbox: no INVOICE_SENT message (never sendEmail for them either).
        suppressInvoiceNotify: walkIn || undefined,
        onReplay: () => {
          replayed = true;
        },
      },
    );
    const orderId: string = primary.orderId;
    const order = await this.prisma.forTenant().order.findFirst({
      where: { id: orderId },
      select: { id: true, orderNumber: true },
    });

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

    return this.respond(dto, order, invoices, replayed, planError);
  }

  /**
   * The locked half of the tender. A replay's rule "no non-VOID tender exists on the sale's invoices" is
   * sound HERE only because a counter sale's invoice is born in the same request as its tender, so
   * any stored tender can only be this sale's own earlier attempt (pickup-complete cannot use it).
   */
  private async tender(
    dto: CounterSaleDto,
    orderId: string,
  ): Promise<{ invoices: InvoiceRow[]; planError?: string }> {
    let invoices = await this.readInvoices(orderId);
    let planError: string | undefined;
    const method = dto.payment.method;
    if (!invoices.some((i) => (i.payments ?? []).some(isTender))) {
      const balances = invoices.map((i) => ({
        id: i.id,
        balance: remainingCapacity(Number(i.total), i.payments),
      }));
      const plan = planCounterPayment({
        method,
        amount: dto.payment.amount,
        balance: roundMoney(balances.reduce((s, b) => s + b.balance, 0)),
      });
      if (plan.kind === "refuse") {
        planError = plan.code;
      } else if (plan.kind === "pay") {
        try {
          for (const part of allocateOldestFirst(balances, plan.amount)) {
            await this.invoices.recordPayment(part.invoiceId, {
              amount: part.amount,
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
        invoices = await this.readInvoices(orderId);
      }
    }
    return { invoices, planError };
  }

  private async assertProductsExist(productIds: string[]): Promise<void> {
    const unique = [...new Set(productIds)];
    const found = await this.prisma.forTenant().product.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) throw new NotFoundException("Product not found");
  }

  private async assertNoOpenCredit(customerId: string): Promise<void> {
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
      include: { payments: true },
      orderBy: { createdAt: "asc" },
    });
  }

  /** Every figure comes from the stored invoices/payments; `change` is display-only (no money row). */
  private respond(
    dto: CounterSaleDto,
    order: { id: string; orderNumber: string | null } | null,
    invoices: InvoiceRow[],
    replayed: boolean,
    planError: string | undefined,
  ): CounterSaleResponse {
    const first = invoices[0];
    if (!order || !first) {
      throw new InternalServerErrorException(
        "The sale was created but its invoice could not be found. Open the order from the orders list.",
      );
    }
    const payments = invoices.flatMap((i) => i.payments ?? []);
    const total = roundMoney(invoices.reduce((s, i) => s + Number(i.total), 0));
    const paid = roundMoney(sumConfirmed(payments));
    const balanceDue = Math.max(0, roundMoney(total - paid));
    const method = dto.payment.method;
    const firstTender = payments.find(isTender);
    // Recorded = nothing was asked of the till (on account / nothing owing) or a tender is STORED (a partial
    // included: its balanceDue stays open on purpose).
    // A throw part-way (a sibling invoice's allocation) can leave an EARLIER invoice's tender stored while
    // balance remains: that must never read as recorded, so a planError beats "a tender exists" (paid and
    // balanceDue still come from storage). A balance that storage shows fully covered is recorded regardless
    // (the loser of a race whose own recordPayment the invoice row lock refused).
    const settled = method === "ON_ACCOUNT" || balanceDue <= 0 || (!planError && !!firstTender);
    // sumConfirmed counts PAID rows only, so a voided cash payment is already out.
    const cashPaid = roundMoney(sumConfirmed(payments.filter((p) => p.method === "CASH")));
    const tendered = dto.payment.amount;
    const owed = tendered != null ? roundMoney(tendered - cashPaid) : 0;
    const change = method === "CASH" && settled && owed > 0 ? owed : undefined;

    return {
      orderId: order.id,
      orderNumber: order.orderNumber ?? "",
      invoiceId: first.id,
      invoiceNumber: first.invoiceNumber ?? "",
      total,
      paid,
      balanceDue,
      ...(change != null ? { change } : {}),
      ...(firstTender ? { paymentId: firstTender.id } : {}),
      paymentRecorded: settled,
      ...(!settled
        ? { paymentErrorCode: planError ?? API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED }
        : {}),
      ...(replayed ? { replayed: true } : {}),
    };
  }
}

function toOrderItem(i: CounterSaleDto["items"][number]): OrderItemDto {
  return {
    productId: i.productId,
    ...(i.qty != null ? { qty: i.qty } : {}),
    ...(i.boxes != null ? { boxes: i.boxes } : {}),
    ...(i.pieces != null ? { pieces: i.pieces } : {}),
    ...(i.unitPrice != null ? { unitPrice: i.unitPrice } : {}),
    ...(i.priceReason ? { overrideReason: i.priceReason } : {}),
  } as OrderItemDto;
}

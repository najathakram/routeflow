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
import { centsToDollars, dollarsToCents, roundMoney } from "@routeflow/pricing";
import type { CounterSaleResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { configuredTaxRatePercent } from "../../common/tax-rate";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { TILL_LOCK_HELD } from "../../invoices/counter-payment-guard";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { OrdersService } from "../orders.service";
import type { CounterSaleDto } from "./counter-sale.dto";
import { assertCounterSalesEnabled } from "./counter-sale-gate";
import { resolveLineUnits, type LineUnitsProduct } from "../../products/line-units";
import { saleChangedConflict, saleVoidedConflict, storedSaleState } from "../sale-replay-guard";
import { toCounterOrderItem } from "./counter-sale-lines";
import { resolveTierPrices } from "./counter-sale-tier-price";
import { assertReplaySamePrices } from "./counter-sale-replay-price";
import { AuditService } from "../../audit/audit.service";
import { staffMay } from "../../auth/permissions/staff-capabilities";
import { buildCounterSaleResponse } from "./counter-sale-readback";
import {
  assertNonCashShortfallsFit,
  assertStoredTenderMatches,
  invoiceRoomCents,
  planSaleTender,
  readStoredTender,
  type InvoiceRow,
} from "./counter-sale-tender";
import { counterTenderCashRows, legGroupId, legGroupIds } from "./counter-tender-row";
import {
  assertLegsAgainstTotal,
  assertLegsShape,
  resolveLegs,
  type CounterLeg,
} from "./counter-sale-legs";
import {
  FULFILMENT_CAPABILITY_READER,
  type FulfilmentCapabilityReader,
} from "./fulfilment-capability-reader";
import { type CounterPaymentMethod, toPrismaMethod } from "./counter-sale-payment";
import {
  autoApplyCandidateWhere,
  creditAutoApplyOnSend,
  hasOpenCreditBalance,
} from "../../credit-notes/auto-apply-candidates";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../../common/db-locks";
import { WalkInCustomerService } from "./walk-in-customer";
import { counterCloseShared, counterTenderPaidAt } from "./counter-tender-window";

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
    await assertCounterSalesEnabled(this.capability, this.prisma.getTenantId());

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
    const legs = resolveLegs(dto);
    assertLegsShape(legs, walkIn);

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
        priceEditAllowed: staffMay(user.role, "EDIT_LINE_PRICE"),
        // B1209: the tender is judged against the SERVER total inside create(), before anything is written
        // (a walk-in must cover it; no customer may over-cover it with non-cash).
        beforeWrite: ({ total }) => assertLegsAgainstTotal(legs, total, walkIn),
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
        registerKey: true, // SA-750r3: the till this sale is counted on
        tax: true,
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
    let invoices: InvoiceRow[];
    let planError: string | undefined;
    if (legs.length === 1 && legs[0].method === "ON_ACCOUNT") {
      invoices = await this.readInvoices(orderId);
    } else {
      try {
        // SA-750r3: the SHARED end-of-day close lock rides this pinned connection (lock order: counter-tender -> counter-close
        // -> Invoice FOR UPDATE), so a close waits for a tender in flight and the tender never lands behind its cutoff.
        const till = { counterSale: true, registerKey: order?.registerKey };
        const locked = await withAdvisoryLock(
          {
            family: "counter-tender",
            key: orderId,
            mode: "wait",
            sharedAlso: counterCloseShared(this.prisma.getTenantId(), till),
          },
          () => this.tender(legs, orderId, till, replayed),
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

    // SA-764: the stored tendered as the tender left it (the pre-tender read above may hold a stale figure), for every
    // request method. A replay whose tender differs from the stored one never gets here (409 COUNTER_TENDER_CHANGED from
    // the tender step); an ON_ACCOUNT replay of a CASH sale does, and serves what by-key serves. A new ON_ACCOUNT sale
    // stores no tendered (null): nothing is served, nothing is written.
    const tendered = await this.prisma.forTenant().order.findFirst({
      where: { id: orderId },
      select: { counterCashTendered: true, tax: true },
    });
    return buildCounterSaleResponse({
      legs,
      evidence: await this.readTenderEvidence(orderId),
      order: order && {
        ...order,
        counterCashTendered: tendered?.counterCashTendered,
        // the tax as the tender left it (the invoice back-sync can move it)
        tax: tendered?.tax ?? order.tax,
      },
      configuredTaxPercent: await configuredTaxRatePercent(this.prisma),
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
   * The locked half of the tender. Replay-safe: what is STORED per (leg, invoice) is compared with the planned
   * placement, only a pair with no row yet is recorded (a resume), and ANY difference between the replay and the
   * stored tender is 409 COUNTER_TENDER_CHANGED with nothing written (`assertStoredTenderMatches`: the fingerprint is
   * derived from the stored rows and `Order.counterCashTendered`, no column). That comparison is sound here because a
   * counter sale's invoices are born in the same request as the tender, so a stored tender row is this sale's own earlier
   * attempt (pickup-complete's invoice pre-exists, so it must key on the request instead). Each leg's rows
   * carry the server-built group id written in the payment's own create, so a replay knows which leg a row is.
   */
  private async tender(
    legs: readonly CounterLeg[],
    orderId: string,
    till: { counterSale: boolean; registerKey?: string | null },
    /** this call is a replay of an earlier one (same key, same order): the only way a figure can already be stored */
    replayed = false,
  ): Promise<{ invoices: InvoiceRow[]; planError?: string }> {
    let invoices = await this.readInvoices(orderId);
    let planError: string | undefined;
    // The plan is made against each invoice's balance BEFORE any tender of this sale (its total less the
    // wallet credit applied), so a replay computes the SAME placement the first call did; what is already
    // stored per (leg, invoice) is then subtracted and only the SHORTFALL is recorded. "A tender exists" is
    // not "recorded": a first call that paid sibling 1 and failed on sibling 2 is resumed, never repeated.
    const plan = planSaleTender(invoices, legs);
    // the order's leg rows on voided sibling invoices: they only decide whether the sale is grouped (the ONE set)
    const evidence = await this.readTenderEvidence(orderId);
    const stored = readStoredTender(orderId, invoices, evidence);
    // the handed-over amount as the first call stored it (written BEFORE any money moves): half of the replay fingerprint
    // (read for a replay too: an attempt that died after the write has a figure and no tender row, SA-773 N6 below)
    const storedRow =
      stored.byLeg.size || replayed
        ? await this.prisma
            .forTenant()
            .order.findFirst({ where: { id: orderId }, select: { counterCashTendered: true } })
        : null;
    const storedTendered = storedRow?.counterCashTendered;
    assertStoredTenderMatches(
      stored,
      legs,
      plan.placements,
      storedTendered == null ? null : dollarsToCents(roundMoney(Number(storedTendered))),
      plan.cashTenderedCents,
    );
    if (!plan.refusal) assertNonCashShortfallsFit(invoices, stored, legs, plan.placements);
    // SA-773 split N6: the handed-over figure is written BEFORE the payments, so an attempt that died after that write
    // (no tender row stored) leaves a figure no money backs. A retry that takes no cash (a card / check retry under the same
    // key, one the plan refuses, one with nothing owing, or a cash leg with no room left to record) never writes a new
    // figure, and the stale one would be served as `cashTendered` on a sale that took none (the response, Today's row, the
    // receipt). With NOTHING stored, the figure must be this request's own: when this request records no cash it is cleared
    // HERE, under the same lock, before any money moves. A cash retry that records overwrites it below; once any tender row
    // exists the fingerprint above has already decided (unchanged), and the NULL-only fill below keeps a figure that a
    // replay with nothing left to record must not move.
    const clearStaleTendered = async () => {
      if (stored.byLeg.size > 0 || storedTendered == null) return;
      try {
        await this.prisma
          .forTenant()
          .order.updateMany({ where: { id: orderId }, data: { counterCashTendered: null } });
      } catch (e) {
        this.logger.warn(
          `counter sale ${orderId}: stale cash tendered not cleared (${(e as Error)?.message ?? e})`,
        );
        planError = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
      }
    };
    // no placement is recorded below (a refusal, or nothing owing): no money moves and no closed-day check applies
    if (plan.refusal || plan.placements.length === 0) await clearStaleTendered();
    if (plan.refusal) {
      // A refusal only stands when nothing was taken yet: a stored tender means a payment already went in.
      if (stored.byLeg.size === 0 && !planError) planError = plan.refusal;
    } else if (plan.placements.length > 0) {
      // The allocation is pure, so it is made first: the closed-day check below must run before ANY write. What each
      // placement still owes is its planned amount less what is stored for that (leg, invoice), capped by the room the
      // invoice has left after the placements before it (the same arithmetic the payment loop always used).
      const takenNow = new Map<string, number>();
      const writes: Array<{ invoiceId: string; legIndex: number; dueCents: number }> = [];
      for (const part of plan.placements) {
        const row = invoices.find((i) => i.id === part.invoiceId)!;
        const have = (stored.byLeg.get(part.legIndex) ?? [])
          .filter((r) => r.invoiceId === part.invoiceId)
          .reduce((sum, r) => sum + r.amountCents, 0);
        const room = invoiceRoomCents(row) - (takenNow.get(row.id) ?? 0);
        const dueCents = Math.min(part.amountCents - have, room);
        if (dueCents <= 0) continue;
        takenNow.set(row.id, (takenNow.get(row.id) ?? 0) + dueCents);
        writes.push({ invoiceId: part.invoiceId, legIndex: part.legIndex, dueCents });
      }
      // SA-750r3: with the shared close lock held, the instant the payment is dated (the DATABASE clock) must not sit in a
      // closed window: 409 COUNTER_SALE_DAY_CLOSED, nothing written. It runs BEFORE the SA-764 cash-tendered write below, so a
      // closed-day refusal leaves nothing stored, and outside the try so it is not mapped to "not recorded". A replay with
      // nothing left to record writes nothing and is never refused.
      const paidAt = writes.length
        ? await counterTenderPaidAt(this.prisma, this.prisma.getTenantId(), till)
        : undefined;
      // N6, after the closed-day check: a retry that records no cash (a card / check retry, or a cash leg with no room
      // left) over a sale with nothing stored clears the stale figure instead of serving it.
      const recordsCash = plan.cashTenderedCents != null && writes.length > 0;
      if (!recordsCash) await clearStaleTendered();
      // SA-764 + SA-749r2: the CASH handed over (the cash LEG's requested amount, whichever leg index it is; null
      // when the sale has no cash leg) is stored BEFORE any money moves, so a paid sale can never lack its tender.
      // Until a CASH tender row anchors it the amount is overwritten (a failed first attempt's stale figure must
      // not survive a retry); once one exists it is frozen (only a NULL is filled). A replay with NOTHING left to record
      // (`writes` empty) over a sale that has a stored tender is frozen too, anchored or not: it only fills a NULL.
      // With nothing stored and nothing to record there is no money behind a figure, so none is written. Same lock,
      // no transaction.
      if (plan.cashTenderedCents != null && (recordsCash || stored.byLeg.size > 0)) {
        const anchored =
          counterTenderCashRows(
            orderId,
            invoices.flatMap((i) => i.payments ?? []),
            evidence,
          ).length > 0;
        const fillNullOnly = anchored || writes.length === 0;
        try {
          await this.prisma.forTenant().order.updateMany({
            where: fillNullOnly ? { id: orderId, counterCashTendered: null } : { id: orderId },
            data: { counterCashTendered: centsToDollars(plan.cashTenderedCents) },
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
          for (const { invoiceId, legIndex, dueCents } of writes) {
            const leg = legs[legIndex];
            await this.invoices.recordPayment(
              invoiceId,
              {
                amount: centsToDollars(dueCents),
                method: toPrismaMethod(leg.method)!,
                reference: leg.reference,
                ...(paidAt ? { paidAt } : {}),
              } as never,
              {
                // SA-750r3: the shared close lock is already held on the pinned connection (tillLockHeld)
                tillLockHeld: TILL_LOCK_HELD,
                // A pre-split attempt's rows are ungrouped: finishing it with a grouped row would make the replay rule
                // (once any grouped row exists, ungrouped rows are not the tender) drop the rows already taken.
                ...(stored.legacy ? {} : { paymentGroupId: legGroupId(orderId, legIndex) }),
              },
            );
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
      legs: method ? [{ method }] : undefined,
      evidence: await this.readTenderEvidence(order.id),
      order,
      invoices,
      replayed: true,
      configuredTaxPercent: await configuredTaxRatePercent(this.prisma),
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

  /**
   * The order's leg rows on its VOID / WRITTEN_OFF invoices (any payment status): group-id evidence only. The sale's set
   * is every payment row of the order, the same one the void, the day close and the closed-day guard read, so a leg row
   * that sits on a voided sibling still makes the sale "grouped" here too.
   */
  private async readTenderEvidence(
    orderId: string,
  ): Promise<Array<{ paymentGroupId: string | null; status: string }>> {
    const rows = await this.prisma.forTenant().invoicePayment.findMany({
      where: {
        paymentGroupId: { in: legGroupIds(orderId) },
        invoice: { orderId, status: { in: ["VOID", "WRITTEN_OFF"] } },
      },
      select: { paymentGroupId: true, status: true },
    });
    return rows ?? [];
  }

  private async readInvoices(orderId: string): Promise<InvoiceRow[]> {
    return this.prisma.forTenant().invoice.findMany({
      // A VOID / WRITTEN_OFF invoice is not part of the sale (recordPayment refuses both): reading it
      // back would put its id, total and balance into the response and the tender plan.
      where: { orderId, status: { notIn: ["VOID", "WRITTEN_OFF"] } },
      include: {
        payments: { orderBy: { createdAt: "asc" } },
        // the stored lines: the rate the sale's tax rate is read from, and the price facts a receipt strikes a list price from
        items: {
          select: {
            id: true,
            createdAt: true,
            // the order line's scan position: the read-back sorts by it (lines of one transaction share createdAt)
            orderItem: { select: { position: true } },
            taxRate: true,
            productId: true,
            unitPrice: true,
            originalPrice: true,
            priceType: true,
          },
          // a deterministic base order (row 322a); the read-back then sorts by scan position (inScanOrder)
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
      // Oldest first, with the id as the tie-break: two invoices of one order can share a createdAt, and the
      // tender is placed (and replayed) oldest-first, so the order must be total.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }
}

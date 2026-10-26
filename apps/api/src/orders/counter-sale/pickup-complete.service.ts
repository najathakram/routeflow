import {
  BadRequestException,
  ServiceUnavailableException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createHash } from "crypto";
import { mayCompleteAtCounter, roundMoney, confirmedRemaining } from "@routeflow/pricing";
import type { PickupCompleteResponse } from "@routeflow/types";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../../common/db-locks";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { TILL_LOCK_HELD } from "../../invoices/counter-payment-guard";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { OrdersService } from "../orders.service";
import { settleOrderInvoice } from "../order-status-invoicing";
import { releaseStaleRunLink } from "../order-lifecycle";
import { assertStopDoneForOfficeDelivered } from "../office-delivered-route-stop";
import {
  autoApplyCandidateWhere,
  creditAutoApplyOnSend,
  hasOpenCreditBalance,
} from "../../credit-notes/auto-apply-candidates";
import {
  allocateOldestFirst,
  assertCheckNotPostdatedForTenant,
  counterCreditPaidNow,
  assertPaymentShape,
  planCounterPayment,
  toPrismaMethod,
  type CounterPaymentInput,
} from "./counter-sale-payment";
import { isHandOverTender, tenderFigures, type InvoiceRow } from "./pickup-tender";
import { pickupTenderGroupId } from "./pickup-tender-group";
import type { DuplicatePaymentRefExisting } from "@routeflow/types";
import { duplicateOf, tenderRefDedupe } from "./counter-duplicate-ref";
import type { PickupCompleteDto } from "./pickup-complete.dto";
import { counterCloseShared, counterTenderPaidAt, pickupRegisterOf } from "./counter-tender-window";
import {
  FULFILMENT_CAPABILITY_READER,
  type FulfilmentCapabilityReader,
} from "./fulfilment-capability-reader";
import { tenantTodayDay } from "../../common/calendar-date";
import { tenantTimeZone } from "../../common/tenant-time-zone";
import { creditAfterTender } from "../credit-limit-guard";
import {
  activeRunLink,
  completeAtCounterRunRefusal,
  takeOrderOffRun,
  type RunOrder,
} from "./complete-at-counter-run";
import { retryOnTxConflict } from "../../common/tx-retry";
import { RouteRealtime } from "../../routes/route-realtime";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import {
  completionAlreadyRecorded,
  finishCompletionEmail,
  completionAtOf,
  mergeClaimMeta,
  stampCompletion,
  releaseCompletionEmail,
  reserveCompletionEmail,
} from "./pickup-complete-claim";

/** I-120 (SA-861 rule 3): the statuses "Complete at counter" finishes; DELIVERED is the replay. */
const COMPLETABLE = new Set(["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"]);

type OrderRow = {
  id: string;
  orderNumber: string | null;
  status: string;
  fulfillPath: string;
  deliveredAt: Date | null;
  customerId: string | null;
  customer: { isWalkIn: boolean | null } | null;
  counterSale?: boolean | null; // SA-750r3: a COUNTER order's tender is a till event (the day-close lock + window)
  registerKey?: string | null;
  total?: unknown; // SA-849: what the B585 gate netted this hand-over's tender against
};

/**
 * POST /orders/:id/pickup-complete: staff hand a PICKUP order over at the till. Order ahead, pick up: the
 * buyer's order was created PENDING (stock taken once, at create), staff confirmed it and marked it "Ready
 * for pickup" (OUT_FOR_DELIVERY); this call is "Picked up".
 *
 * Sequenced like the counter sale, no new transaction (each service owns its own):
 *  1. the order is read under the tenant scope (another tenant's id is simply not found) and judged from
 *     the row alone: not PICKUP -> 400 PICKUP_ONLY; DRAFT / PENDING / PARTIALLY_DELIVERED / CANCELLED ->
 *     409 PICKUP_NOT_READY; the payment shape is judged from the request alone. All of it BEFORE a write;
 *  2. `OrdersService.changeStatus(DELIVERED)` is the EXISTING transition: it moves NO stock (pinned in
 *     orders.pickup-complete-status.spec.ts) and takes exactly one invoice path, so no second invoice;
 *  3. every DRAFT invoice is sent (no INVOICE_SENT message for the walk-in);
 *  4. the tender runs under the shared `counter-tender` advisory lock keyed on the order, through the SAME
 *     payment helpers the counter sale uses (planner, oldest-first allocation, shortfall resume, cents).
 *
 * REPLAY = TRANSITION OWNER. The invoice pre-exists (deposits, portal payments), so "a tender is stored"
 * cannot mean "this request already paid". Only a tender row of the order's hand-over group created at or after THIS
 * completion's `completionAt` (SA-919: the claim's stamp; never `deliveredAt`, which a backdated order sets to its order
 * date) is this request's; a deposit is
 * never counted. A call that finds the order already DELIVERED therefore records only the SHORTFALL between
 * this hand-over's planned tender and what is stored for it, never a second full tender, and answers the
 * stored outcome with `alreadyPickedUp`. The balance the plan is judged against is the invoice total less
 * everything that is NOT this hand-over's tender, so a replay computes the SAME plan the first call did.
 * The Idempotency-Key is required of the caller (a keyless client could not retry safely) and normalised at
 * the edge; replay safety comes from the order's own state and the stored payments, not from the key.
 * A payment that cannot be recorded (a lock not taken included) leaves the order DELIVERED with an open
 * invoice and answers 200 `paymentRecorded: false`; the retry finishes it.
 */
@Injectable()
export class PickupCompleteService {
  private readonly logger = new Logger(PickupCompleteService.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly invoices: InvoicesService,
    private readonly prisma: PrismaService,
    @Inject(FULFILMENT_CAPABILITY_READER) private readonly capability: FulfilmentCapabilityReader,
    // SA-913 (b): the office skip's post-commit run update after a take-off empties a stop
    @Optional() private readonly gateway?: RouteFlowGateway,
  ) {}

  async complete(
    id: string,
    dto: PickupCompleteDto,
    user: JwtPayload,
    _idempotencyKey: string,
  ): Promise<PickupCompleteResponse> {
    // 1. The order, tenant-scoped, and everything judged from the row and the request alone.
    let order = await this.readOrder(id);
    if (!order) throw new NotFoundException("Order not found");
    // I-120 (SA-861 rule 2): a business that hands over at the store. The till permission half of the ONE predicate is
    // the route's TillPermissionGuard (a principal without it is a 403 before this runs).
    const cap = await this.capability.get(this.prisma.getTenantId() ?? null);
    if (!mayCompleteAtCounter({ mayUseTill: true, methods: cap.methods, counter: cap.counter })) {
      throw new ConflictException({
        code: API_ERROR_CODES.COUNTER_COMPLETE_UNAVAILABLE,
        message: "This business does not hand orders over at the store.",
      });
    }
    // I-120 (SA-861 rule 3): any not-yet-delivered order, any path (rule 4 switches it to Store pickup first). PICKUP_ONLY
    // is no longer thrown (it stays in the codes list).
    let alreadyPickedUp = order.status === "DELIVERED";
    // SA-849 on the hand-over (SA-872 cond. 2): set only when THIS call's B585 gate netted the till tender.
    let gateNetted: ((total: number) => number) | undefined;
    if (!alreadyPickedUp && !COMPLETABLE.has(order.status)) {
      throw new ConflictException({
        code: API_ERROR_CODES.PICKUP_NOT_READY,
        message: "This order is not ready for pickup yet, or it was cancelled",
      });
    }
    // I-120 R8/R9 (owner 7a, SA-913): a shipped order, an order on a driver's run, a started stop: judged now. `takeOffRun`
    // is not part of the claim's body hash, so the confirm re-sends under the same key.
    if (!alreadyPickedUp) {
      const refused = completeAtCounterRunRefusal(order as RunOrder, dto.takeOffRun === true);
      if (refused) throw refused;
    }
    const walkIn = !!order.customer?.isWalkIn;
    // The request's real payment: never overwritten. Absent + nothing owed (same invoice set and capacity
    // rule as the tender below) = EXCUSED: no shape check, no row. Absent + owing = on account (a walk-in
    // has none: 400 before any write). Re-judged on the invoices FINAL after the hand-over (step 3).
    const sent = dto.payment;
    const preRows = await this.readInvoices(id);
    const preOwed = this.owedBalance(
      preRows,
      alreadyPickedUp ? isHandOverTender(id, await this.claimCompletionAt(id)) : undefined,
    );
    const excused = !sent && preRows.length > 0 && preOwed <= 0;
    if (sent) {
      assertPaymentShape(sent, walkIn);
      // Interim till guard: a check dated after the TENANT's day is never tendered, before any write (as the counter sale).
      await assertCheckNotPostdatedForTenant(this.prisma, sent);
    } else if (!excused) assertPaymentShape({ method: "ON_ACCOUNT" }, walkIn);
    if (walkIn) {
      // A walk-in leaves no partial on account and takes no credit: the counter sale's two guards.
      if (
        sent &&
        sent.method !== "ON_ACCOUNT" &&
        sent.amount != null &&
        preRows.length > 0 &&
        roundMoney(sent.amount) < preOwed
      ) {
        throw new BadRequestException({
          code: API_ERROR_CODES.COUNTER_TENDER_SHORT,
          message: "A walk-in customer must pay the full balance",
        });
      }
      await this.assertNoOpenCredit(order.customerId);
    }
    // SA-905 MUST 1: the delivery credit gate the DELIVERED step runs (B585, netted), judged NOW through the same ONE entry,
    // read-only, so a refusal writes nothing (no claim, no switch, no silent CONFIRMED). The DELIVERED step's own gate stays
    // the authority. Residual (documented): a limit or exposure moving between here and DELIVERED leaves a switched order
    // that is not yet confirmed to the customer. OUT_FOR_DELIVERY was gated on its way out (changeStatus' alreadyOut).
    if (!alreadyPickedUp && (order.status === "PENDING" || order.status === "CONFIRMED")) {
      const creditPaidNow = await this.tenderCreditPaidNow(sent);
      if (order.customerId) {
        const at = { id: order.id, customerId: order.customerId, total: order.total };
        await this.orders.assertDeliveryCreditGate(at, user, { creditPaidNow });
      }
    }
    // SA-909 item 1: a tender this call would record is refused for a CLOSED day before the first write (the same
    // window check the tender runs under its lock, read-only, on the same register and the database clock), so a closed day
    // leaves the order as it was. The in-lock check stays the authority (the day closing in between: today's 409 after).
    // #3678 Opus NIT: nothing owed (the same excuse rule as above) records no tender, so a closed day does not refuse it
    const nothingOwed = preRows.length > 0 && preOwed <= 0;
    if (!alreadyPickedUp && sent && sent.method !== "ON_ACCOUNT" && !nothingOwed) {
      await counterTenderPaidAt(
        this.prisma,
        this.prisma.getTenantId(),
        order,
        pickupRegisterOf(order, dto.registerKey),
      );
    }
    // Row 590 (SA-1000 §2): a PICKUP order still linked to a FINISHED run (activeRunLink is null for it, and updateFulfillPath
    // skips an order already on PICKUP) is released here, then the office-DELIVERED stop check runs read-only, BOTH before the
    // claim, so a refusal leaves no claim behind and a stale link no longer dead-ends every retry.
    if (!alreadyPickedUp && order.fulfillPath === "PICKUP") {
      if (await releaseStaleRunLink(this.prisma, id)) order = (await this.readOrder(id)) ?? order;
      if (!activeRunLink(order as RunOrder)) {
        await assertStopDoneForOfficeDelivered(
          this.prisma,
          order as RunOrder,
          OrderStatus.DELIVERED,
        );
      }
    }
    // SA-919: THIS completion's `completionAt`, the claim's stamp (never `deliveredAt`): its tender and its email key
    let handedOverAt: Date | null;
    try {
      handedOverAt = await this.claimHandOver(id, _idempotencyKey, sent, user);
    } catch (e) {
      // A lock timeout or outage before any write is a coded, retryable 503 (never a 500).
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        throw this.claimUnavailable();
      }
      throw e;
    }

    // 2. The hand-over: the existing status change (invoice + no stock). Its own refusals propagate,
    // except the race loser's: a concurrent call that delivered it first makes this one the replay.
    if (!alreadyPickedUp) {
      // I-120 (SA-861 rules 4, 5, 9). Each step is skipped when the row already shows it done, so a crash between steps
      // resumes. 4: the path becomes Store pickup first, through the ONE switch (it re-judges selling restrictions at the
      // store's state and releases a finished run's link; its refusals propagate with nothing else written).
      // SA-913 R8: off the driver's run first, its own locked tx (Orders → stop → run; refused with nothing written when
      // the stop started or the link moved; a deadlock is retried in a fresh tx). A resume with no run link skips it.
      const link = activeRunLink(order as RunOrder);
      if (link) {
        const actor = { tenantId: user.tenantId as string, userId: user.sub };
        const { stopSkipped } = await retryOnTxConflict("pickup-complete.take-off-run", () =>
          this.prisma.tenantTransaction((tx) =>
            takeOrderOffRun(tx, { orderId: id, ...link }, actor),
          ),
        );
        // SA-913 (b): the same post-commit update the office skip sends, so the driver's run shows the stop skipped
        if (stopSkipped && this.gateway)
          await new RouteRealtime(this.prisma, this.gateway, this.logger).runProgress(link.runId);
        order = (await this.readOrder(id)) ?? order;
      }
      if (order.fulfillPath !== "PICKUP") {
        // SA-913 (c): the ONE caller-pinned option lets an OUT_FOR_DELIVERY order with no run link switch (no demotion);
        // its DELIVERED step then runs alreadyOut, ungated.
        await this.orders.updateFulfillPath(id, { fulfillPath: "PICKUP" } as never, user, {
          fromOutForDelivery: true,
        });
        order = (await this.readOrder(id)) ?? order;
      }
      // 5: PENDING cannot go straight to DELIVERED; both transitions are silent (the ONE completion email follows).
      if (order.status === "PENDING") {
        await this.orders.changeStatus(id, { status: "CONFIRMED" } as never, user, {
          silent: true,
        });
        order = (await this.readOrder(id)) ?? order;
      }
      const creditPaidNow = await this.tenderCreditPaidNow(sent);
      // the B585 delivery gate runs on this step only for goods not already out (changeStatus' alreadyOut)
      const gated = order.status !== "OUT_FOR_DELIVERY" && order.status !== "PARTIALLY_DELIVERED";
      try {
        await this.orders.changeStatus(id, { status: "DELIVERED" } as never, user, {
          silent: true,
          creditPaidNow,
        });
        // THIS call's gate counted the tender (a lost race, or goods already out, netted nothing of ours)
        if (gated) gateNetted = creditPaidNow;
      } catch (e) {
        const now = await this.readOrder(id);
        if (now?.status !== "DELIVERED") throw e;
        alreadyPickedUp = true;
      }
      order = (await this.readOrder(id)) ?? order;
    }

    // 3. Issue every draft invoice.
    let invoices = await this.readInvoices(id);
    if (invoices.length === 0) {
      // Delivered with no invoice (the settle failed at the hand-over): create it through the SAME settle
      // changeStatus(DELIVERED) uses, so a retry never strands the order.
      const failure = await settleOrderInvoice(this.orders, id, this.logger, "delivered");
      if (failure) this.logger.warn(`pickup complete ${id}: invoice repair failed`);
      invoices = await this.readInvoices(id);
      if (invoices.length === 0) {
        throw new ConflictException({
          code: API_ERROR_CODES.PICKUP_INVOICE_MISSING,
          message:
            "The order is picked up but has no invoice yet. Retry, or use Generate Invoice on the order page.",
        });
      }
    }
    // I-120 (SA-861 rule 5): no INVOICE_SENT on this path for anyone; a named customer gets the ONE completion email.
    const sendOpts = [{ suppressNotify: true }];
    let issued = false;
    for (const inv of invoices) {
      if (inv.status !== "DRAFT") continue;
      try {
        await this.invoices.send(inv.id, ...sendOpts);
        issued = true;
      } catch (e) {
        // A concurrent call may have issued it first: only a still-DRAFT invoice is a real failure.
        const fresh = (await this.readInvoices(id)).find((i) => i.id === inv.id);
        if (!fresh || fresh.status === "DRAFT") throw e;
        issued = true;
      }
    }
    if (issued) invoices = await this.readInvoices(id);

    // 4. The tender, against what is STORED now. ON_ACCOUNT takes no money: no lock. Owed is re-judged on
    // the final invoices (a remainder / rebuild at DELIVERED can differ from before the hand-over).
    const owedNow =
      this.owedBalance(invoices, alreadyPickedUp ? isHandOverTender(id, handedOverAt) : undefined) >
      0;
    let planError: string | undefined;
    let duplicate: DuplicatePaymentRefExisting | undefined;
    let shown: { method: string; amount?: number } = sent ?? { method: "ON_ACCOUNT" };
    if (!sent && excused) {
      // Excused before the hand-over; never report a forced ON_ACCOUNT as settled when money is owed now.
      shown = { method: "NONE" };
      if (owedNow) planError = API_ERROR_CODES.PICKUP_PAYMENT_REQUIRED;
    } else if (sent && sent.method !== "ON_ACCOUNT" && owedNow) {
      try {
        // SA-750r3: EVERY hand-over tender (counter or POS-mode PICKUP) takes the SHARED end-of-day close lock on this pinned
        // connection, for the order's stamped register, else the request's, else 'main'.
        const register = pickupRegisterOf(order, dto.registerKey);
        const locked = await withAdvisoryLock(
          {
            family: "counter-tender",
            key: id,
            mode: "wait",
            sharedAlso: counterCloseShared(this.prisma.getTenantId(), order, register),
          },
          () => this.tender(id, sent, handedOverAt, walkIn, order, register, user),
        );
        if (!locked.acquired) throw new LockTimeoutError("counter-tender", id, 0);
        ({ invoices, planError, duplicate } = locked.value);
      } catch (e) {
        // The hand-over is already committed: a contended or unavailable lock must not turn into a 500
        // over a finished hand-over. It reads as an unrecorded payment (the retry finishes it). Errors
        // from inside the locked section are not lock errors and still propagate.
        if (!(e instanceof LockTimeoutError || e instanceof LockUnavailableError)) {
          // SA-849 path (d): a closed day's 409 after the hand-over committed gets the re-check's log + audit; the 409 is
          // unchanged (SA-876: never replaced by a re-check that fails).
          const code = (e as { getResponse?: () => { code?: string } })?.getResponse?.()?.code;
          if (code === API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED)
            await this.creditRecheck(order, gateNetted, code, user).catch(() => undefined);
          throw e;
        }
        this.logger.warn(`pickup complete ${id}: tender lock not taken (${e.message})`);
        planError = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
        invoices = await this.readInvoices(id);
      }
    }

    // The cashier is stamped AFTER the tender section: a hand-over refused for a closed day (a thrown 409) stamps nothing,
    // neither the register nor the cashier, so a closed day's rows never gain a writer.
    await this.stampSoldBy(id, user);

    // SA-849: the gate counted this tender and it did not fully record -> the ONE post-tender re-check (never blocks).
    const creditOverLimit =
      planError && planError !== API_ERROR_CODES.PICKUP_PAYMENT_REQUIRED
        ? await this.creditRecheck(order, gateNetted, planError, user).catch(() => null)
        : null;

    const emailed = await this.completionEmail(id, invoices, walkIn, planError, user, handedOverAt);
    return {
      ...this.respond(order, invoices, shown, handedOverAt, planError, alreadyPickedUp, duplicate),
      ...(emailed ? { emailed: true } : {}),
      ...(creditOverLimit ? { creditOverLimit } : {}),
    };
  }

  /**
   * SA-849 (S1 S-1) on the hand-over: what THIS call's gate netted (`creditPaidNow` over the stored total) and, when it
   * was anything, `creditAfterTender` (DARK warns; ENFORCED warns + audits once per order + answers the figures). A call
   * whose gate did not run (already picked up, a lost race) netted nothing: no re-check.
   */
  private async creditRecheck(
    order: OrderRow,
    gateNetted: ((total: number) => number) | undefined,
    planError: string,
    user: JwtPayload,
  ) {
    if (!gateNetted) return null;
    const total = Number(order.total ?? 0);
    return creditAfterTender(
      { prisma: this.prisma, entitlements: this.orders.entitlements, logger: this.logger },
      {
        tenantId: this.prisma.getTenantId(),
        customerId: order.customerId,
        orderId: order.id,
        total,
        netted: gateNetted(total),
        planError,
        action: "delivery", // SA-849 rule 1: the hand-over is netted at the DELIVERED gate (enforce_delivery)
        actor: user.sub ?? null,
        impersonatedBy: user.impersonatedBy ?? null,
      },
    );
  }

  /**
   * I-120 (SA-861 rule 6): what the till takes NOW, for the B585 delivery gate (the S1 netting): cash / card / a check
   * dated today or earlier count, a post-dated check and on account count 0 (`counterCreditPaidNow`).
   */
  private async tenderCreditPaidNow(
    sent: CounterPaymentInput | undefined,
  ): Promise<((total: number) => number) | undefined> {
    if (!sent || sent.method === "ON_ACCOUNT") return undefined;
    let today: string | undefined;
    if (sent.method === "CHECK" && sent.checkDate) {
      today = tenantTodayDay(await tenantTimeZone(this.prisma), new Date());
    }
    return (total: number) => counterCreditPaidNow(sent, total, today);
  }

  /**
   * I-120 (SA-861 rule 8): the ONE customer email of a completion, the invoice email of every invoice of the order with
   * the COUNTER_COMPLETE wording. Only a named customer (a walk-in gets nothing), only once the tender outcome is final
   * (recorded, or on account by choice: no `planError`). SA-909: exactly once PER COMPLETION (keyed on its `completionAt`, SA-919),
   * reserved by one conditional update on the claim row and sent with NO lock held (pickup-complete-claim.ts); the #2088 send
   * record is the delivery fact if the flag never got written. The hand-over is committed: a failed send is logged, never
   * thrown; the reservation is released so the same-key retry sends it.
   */
  private async completionEmail(
    orderId: string,
    invoices: InvoiceRow[],
    walkIn: boolean,
    planError: string | undefined,
    user: JwtPayload,
    handedOverAt: Date | null,
  ): Promise<boolean> {
    if (walkIn || planError || invoices.length === 0 || !handedOverAt || !user.tenantId)
      return false;
    const tenantId = user.tenantId;
    const claim = await this.prisma.forTenant().auditLog.findFirst({
      where: { tenantId, entityType: "Order", entityId: orderId, action: "PICKUP_COMPLETE_CLAIM" },
      orderBy: { createdAt: "asc" },
      select: { id: true, meta: true },
    });
    if (!claim) return false;
    const completionFor = handedOverAt.toISOString();
    if (
      (claim.meta as { completionEmailedFor?: string } | null)?.completionEmailedFor ===
      completionFor
    )
      return false;
    // SA-909 item 4: the email went but the flag was never written (markSent threw): record it, send nothing.
    if (await completionAlreadyRecorded(this.prisma, tenantId, invoices[0].id, handedOverAt)) {
      await finishCompletionEmail(this.prisma, tenantId, claim.id, completionFor);
      return false;
    }
    const at = await reserveCompletionEmail(this.prisma, tenantId, claim.id, completionFor);
    if (!at) return false; // emailed already, or another call holds a live reservation
    try {
      const sent = await this.invoices.sendCompletionEmail(
        orderId,
        invoices.map((i) => i.id),
        user.sub ?? null,
      );
      if (!sent?.delivered) {
        await releaseCompletionEmail(this.prisma, tenantId, claim.id, completionFor, at);
        return false;
      }
      await finishCompletionEmail(this.prisma, tenantId, claim.id, completionFor);
      return true;
    } catch (e) {
      this.logger.warn(
        `pickup complete ${orderId}: completion email not sent (${(e as Error)?.message ?? e})`,
      );
      await releaseCompletionEmail(this.prisma, tenantId, claim.id, completionFor, at).catch(
        () => undefined,
      );
      return false;
    }
  }

  /**
   * The hand-over key, persisted as an AuditLog row (action is free text: no schema change). Its OWN short
   * section under the per-order `counter-tender` lock (released before the tender takes it again): read the
   * claim; none -> write it BEFORE changeStatus (a crash after the commit keeps it); same key + same body
   * (an earlier no-payment claim may be completed by a retry that sends one) -> proceed as the replay; any
   * other key, or the same key with a different payment -> 409 PICKUP_KEY_CONFLICT before any write.
   */
  private async claimHandOver(
    orderId: string,
    key: string,
    payment: CounterPaymentInput | undefined,
    user: JwtPayload,
  ): Promise<Date | null> {
    const bodyHash = payment
      ? createHash("sha256")
          .update(
            JSON.stringify([payment.method, payment.amount ?? null, payment.reference ?? null]),
          )
          .digest("hex")
      : null;
    const tenantId = user.tenantId;
    if (!tenantId) throw new ForbiddenException("A tenant-scoped session is required"); // the claim is per tenant
    const db = this.prisma.forTenant();
    const locked = await withAdvisoryLock(
      { family: "counter-tender", key: orderId, mode: "wait" },
      async () => {
        const row = await db.auditLog.findFirst({
          where: {
            tenantId: user.tenantId,
            entityType: "Order",
            entityId: orderId,
            action: "PICKUP_COMPLETE_CLAIM",
          },
          orderBy: { createdAt: "asc" },
        });
        if (!row) {
          const created = await db.auditLog.create({
            data: {
              tenantId: user.tenantId,
              userId: user.sub,
              action: "PICKUP_COMPLETE_CLAIM",
              entityType: "Order",
              entityId: orderId,
              meta: { idempotencyKey: key, bodyHash },
            },
          });
          return this.completionMoment(orderId, tenantId, created.id, null, false);
        }
        const meta = (row.meta ?? {}) as { idempotencyKey?: string; bodyHash?: string | null };
        if (meta.idempotencyKey !== key || (meta.bodyHash && meta.bodyHash !== bodyHash)) {
          // Unified claim rule (SA-710a + lead): a different key or body REPLACES the claim while no tender for
          // this hand-over is stored (a refused hand-over, or a walk-in short / planner refusal found after
          // it, must never lock the order out); recordings stay capped by confirmedRemaining. Only a STORED
          // hand-over tender makes a different request a conflict.
          const now = await db.order.findFirst({
            where: { id: orderId },
            select: { status: true },
          });
          const tendered =
            now?.status === "DELIVERED" &&
            (await this.readInvoices(orderId)).some((i) =>
              (i.payments ?? []).some(isHandOverTender(orderId, completionAtOf(row.meta))),
            );
          if (tendered) {
            throw new ConflictException({
              code: API_ERROR_CODES.PICKUP_KEY_CONFLICT,
              message: "Already picked up. Record any payment on the invoice.",
            });
          }
          // SA-905 MUST 2 (a) / SA-909: the replacement merges ONLY its own keys, atomically, so the completion's email
          // fields (and a live reservation) always survive it: never a second email.
          await mergeClaimMeta(this.prisma, tenantId, row.id, { idempotencyKey: key, bodyHash });
          return this.completionMoment(orderId, tenantId, row.id, row.meta, false);
        }
        // A same-key retry that ADDS the payment the first call lacked (PICKUP_PAYMENT_REQUIRED) is adopted
        // on the claim, so a later, different payment under this key is a conflict, not a second tender.
        if (!meta.bodyHash && bodyHash) {
          await mergeClaimMeta(this.prisma, tenantId, row.id, { bodyHash }); // SA-909: an atomic merge
        }
        return this.completionMoment(orderId, tenantId, row.id, row.meta, true);
      },
    );
    if (!locked.acquired) throw this.claimUnavailable();
    return locked.value;
  }

  /**
   * SA-919 rule 1, under the claim's counter-tender lock: a NEW completion (the order not yet delivered: the first claim, a
   * different key, or after a reopen) stamps `completionAt`; a same-key replay with a stamp, or ANY request while the order
   * is DELIVERED, keeps the stored one (null on a legacy claim: every row of the group is this hand-over's).
   */
  private async completionMoment(
    orderId: string,
    tenantId: string,
    claimId: string,
    meta: unknown,
    sameKey: boolean,
  ): Promise<Date | null> {
    const stored = completionAtOf(meta);
    const now = await this.prisma
      .forTenant()
      .order.findFirst({ where: { id: orderId }, select: { status: true } });
    if (now?.status === "DELIVERED" || (sameKey && stored)) return stored;
    return stampCompletion(this.prisma, tenantId, claimId);
  }

  /** The `completionAt` on this order's claim row (a replay judged before its claim), or null. */
  private async claimCompletionAt(orderId: string): Promise<Date | null> {
    const claim = await this.prisma.forTenant().auditLog.findFirst({
      where: { entityType: "Order", entityId: orderId, action: "PICKUP_COMPLETE_CLAIM" },
      orderBy: { createdAt: "asc" },
      select: { meta: true },
    });
    return completionAtOf(claim?.meta);
  }

  /**
   * Owner ruling (B): the hand-over names who handed it over (`Order.soldById`), by the counter sale's replay rule: only an
   * order with no cashier yet is stamped, so the first cashier stays and a replay by another cashier never overwrites it. The
   * hand-over is already committed: a failure here is logged, never thrown.
   */
  private async stampSoldBy(orderId: string, user: JwtPayload): Promise<void> {
    try {
      await this.prisma
        .forTenant()
        .order.updateMany({ where: { id: orderId, soldById: null }, data: { soldById: user.sub } });
    } catch (e) {
      this.logger.warn(
        `pickup complete ${orderId}: cashier not stamped (${(e as Error)?.message ?? e})`,
      );
    }
  }

  /** The claim section could not take its per-order lock: a coded, retryable 503 (nothing was written). */
  private claimUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: API_ERROR_CODES.LOCK_UNAVAILABLE,
      message: "The hand-over is busy. Try again in a moment.",
    });
  }

  /** The counter sale's guard: a walk-in must not receive an open credit that send() would auto-apply. */
  private async assertNoOpenCredit(customerId: string | null): Promise<void> {
    if (!customerId) return;
    if (!(await creditAutoApplyOnSend(this.prisma.forTenant(), this.prisma.getTenantId()))) return;
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
   * The locked half of the tender. The plan is made against each invoice's balance BEFORE this hand-over's
   * tender (its total less every payment that is not this hand-over's), so a replay computes the SAME
   * allocation the first call did; what is already stored for this hand-over per invoice is then subtracted
   * and only the SHORTFALL is recorded (a first call that paid sibling 1 and failed on sibling 2 is resumed,
   * never repeated). Each recording is also capped at the invoice's live remaining capacity: never over-collects.
   */
  private async tender(
    orderId: string,
    payment: CounterPaymentInput,
    handedOverAt: Date | null,
    walkIn: boolean,
    till: OrderRow,
    register: string,
    user: JwtPayload,
  ): Promise<{
    invoices: InvoiceRow[];
    planError?: string;
    duplicate?: DuplicatePaymentRefExisting;
  }> {
    let invoices = await this.readInvoices(orderId);
    let planError: string | undefined;
    let duplicate: DuplicatePaymentRefExisting | undefined;
    const mine = isHandOverTender(orderId, handedOverAt);
    const balances = invoices.map((i) => ({
      id: i.id,
      balance: confirmedRemaining(
        Number(i.total),
        (i.payments ?? []).filter((p) => !mine(p)),
      ),
    }));
    const plan = planCounterPayment({
      method: payment.method,
      amount: payment.amount,
      balance: roundMoney(balances.reduce((sum, b) => sum + b.balance, 0)),
    });
    if (
      plan.kind === "pay" &&
      walkIn &&
      plan.amount < roundMoney(balances.reduce((t, b) => t + b.balance, 0))
    ) {
      // A walk-in cannot leave a partial on account (the final balance can differ from the pre-check's).
      if (!invoices.some((i) => (i.payments ?? []).some(mine))) {
        planError = API_ERROR_CODES.COUNTER_TENDER_SHORT;
      }
    } else if (plan.kind === "refuse") {
      // A refusal only stands when this hand-over took nothing yet: a stored tender means a payment went in.
      if (!invoices.some((i) => (i.payments ?? []).some(mine))) planError = plan.code;
    } else if (plan.kind === "pay") {
      const writes = allocateOldestFirst(balances, plan.amount)
        .map((part) => {
          const row = invoices.find((i) => i.id === part.invoiceId)!;
          const stored = roundMoney(
            (row.payments ?? []).filter(mine).reduce((sum, p) => sum + Number(p.amount), 0),
          );
          const due = roundMoney(
            Math.min(part.amount - stored, confirmedRemaining(Number(row.total), row.payments)),
          );
          return { invoiceId: part.invoiceId, due };
        })
        .filter((w) => w.due > 0);
      // SA-750r3: the payment is dated from the DATABASE clock read with the shared close lock held, and a closed window of
      // the tender's register refuses it (409 COUNTER_SALE_DAY_CLOSED, nothing stamped or recorded). Outside the try below
      // so it is not mapped to "not recorded"; a replay with nothing left to record writes nothing and is never refused.
      let paidAt: string | undefined;
      if (writes.length) {
        paidAt = await counterTenderPaidAt(this.prisma, this.prisma.getTenantId(), till, register);
        // Stamp the register on a POS-mode (non-counter) order that has none, tenant-scoped, only after the window check and
        // before the payment; a stamp that is already set is never overwritten (the tender counts toward it).
        if (till.counterSale !== true && !till.registerKey) {
          let stamped: { count?: number } | undefined;
          try {
            stamped = await this.prisma.forTenant().order.updateMany({
              where: { id: orderId, tenantId: this.prisma.getTenantId(), registerKey: null },
              data: { registerKey: register },
            });
          } catch (e) {
            // The hand-over is already committed: a failed stamp must not become a 500. Nothing was recorded; the retry
            // finishes it (an unrecorded payment, never a mis-counted one).
            this.logger.warn(
              `pickup complete ${orderId}: register not stamped (${(e as Error)?.message ?? e})`,
            );
            return { invoices, planError: API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED };
          }
          if (stamped?.count === 0) {
            // A concurrent hand-over stamped another register first: the lock held is the wrong one. Record nothing; the
            // retry reads the stamp and locks the right register.
            const now = await this.readOrder(orderId);
            if (now?.registerKey && now.registerKey !== register) {
              return { invoices, planError: API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED };
            }
          }
        }
      }
      try {
        for (const { invoiceId, due } of writes) {
          // SA-763r R7: the tender's group id is written IN the create, so Today's sales finds it. SA-750r3: the shared close
          // lock is already held on the pinned connection (tillLockHeld).
          await this.invoices.recordPayment(
            invoiceId,
            {
              amount: due,
              method: toPrismaMethod(payment.method)!,
              reference: payment.reference,
              ...(paidAt ? { paidAt } : {}),
            } as never,
            {
              paymentGroupId: pickupTenderGroupId(orderId),
              tillLockHeld: TILL_LOCK_HELD,
              refDedupe: tenderRefDedupe(user, payment),
            },
          );
        }
      } catch (e) {
        this.logger.warn(
          `pickup complete ${orderId}: payment not recorded (${(e as Error)?.message ?? e})`,
        );
        planError = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
        duplicate = duplicateOf(e) ?? undefined; // WHY, for the dialog's "Record anyway" (SA-837b)
      }
      invoices = await this.readInvoices(orderId);
    }
    return { invoices, planError, duplicate };
  }

  /**
   * What the non-void invoices still leave to collect (cents). Before the hand-over every stored payment is
   * pre-existing; on a replay `mine` leaves this hand-over's own tender out, so the answer is the one the
   * first call saw.
   */
  private owedBalance(rows: InvoiceRow[], mine: (p: any) => boolean = () => false): number {
    return roundMoney(
      rows.reduce(
        (sum, i) =>
          sum +
          confirmedRemaining(
            Number(i.total),
            (i.payments ?? []).filter((p) => !mine(p)),
          ),
        0,
      ),
    );
  }

  private async readOrder(id: string): Promise<OrderRow | null> {
    return this.prisma.forTenant().order.findFirst({
      where: { id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        fulfillPath: true,
        deliveredAt: true,
        customerId: true,
        customer: { select: { isWalkIn: true } },
        counterSale: true,
        registerKey: true,
        total: true,
        // I-120 R8/R9: the run (through its stop, or a bare routeRunId), the stop's state, the carrier shipment
        shippedAt: true,
        routeRunId: true,
        routeRunStopId: true,
        routeRun: { select: { status: true, driver: { select: { contactName: true } } } },
        routeRunStop: {
          select: {
            status: true,
            routeRun: { select: { status: true, driver: { select: { contactName: true } } } },
          },
        },
      },
    });
  }

  private async readInvoices(orderId: string): Promise<InvoiceRow[]> {
    return this.prisma.forTenant().invoice.findMany({
      // A VOID / WRITTEN_OFF invoice is not part of the sale (recordPayment refuses both): reading it back
      // would put its id, total and balance into the response and the tender plan.
      where: { orderId, status: { notIn: ["VOID", "WRITTEN_OFF"] } },
      include: { payments: true },
      orderBy: { createdAt: "asc" },
    });
  }

  private respond(
    order: { id: string; orderNumber: string | null },
    invoices: InvoiceRow[],
    payment: { method: string; amount?: number },
    handedOverAt: Date | null,
    planError: string | undefined,
    alreadyPickedUp: boolean,
    duplicate?: DuplicatePaymentRefExisting,
  ): PickupCompleteResponse {
    const first = invoices[0];
    if (!first) {
      throw new ConflictException({
        code: API_ERROR_CODES.PICKUP_INVOICE_MISSING,
        message:
          "The order was handed over but its invoice could not be found. Retry, or open the order from the orders list.",
      });
    }
    return {
      orderId: order.id,
      orderNumber: order.orderNumber ?? "",
      invoiceId: first.id,
      invoiceNumber: first.invoiceNumber ?? "",
      ...tenderFigures(
        invoices,
        payment,
        isHandOverTender(order.id, handedOverAt),
        planError,
        duplicate,
      ),
      ...(alreadyPickedUp ? { alreadyPickedUp: true } : {}),
    };
  }
}

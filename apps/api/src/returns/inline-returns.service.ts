/**
 * Returns Inside Order Creation — PR-1c: capture / issue / approve / reject / cancel.
 *
 * Stacked directly on PR-1b's quote engine (`InlineReturnsQuoteService`) — `capture()` reuses
 * the SAME pricing pipeline (`priceInlineReturn`) so a captured return's figures never drift
 * from what the tray quoted. The order-tx/`updateOrderItems` "pending row" hook (N-3) and the
 * capture/alert sweeps are PR-1d — `capture()` here is a direct, synchronous entry point
 * against an EXISTING carrying order (design.md §7's mobile "at-stop/operator edit-items 'Add
 * return'" surface), not yet wired into `POST /orders`.
 *
 * Lock order (design.md §5): customer-scoped advisory lock (shared with the STANDARD path's
 * `ReturnsService.create()` — the two must serialize against each other) → carrying `Order FOR
 * UPDATE` → pricing (reads the matching set/prior-returned snapshot under that lock) → `Product`
 * rows (written by the shared `restockReturnItems`). Per-SOURCE-order locking is intentionally
 * NOT taken here: the customer-scoped lock already serializes every return-creating
 * transaction for this customer (the specific race those source-order locks close for
 * STANDARD's single-order case), and a source order's INVOICE lines — the only thing capture
 * reads from it — are immutable once issued on every path capture can reach. Documented rather
 * than silently assumed.
 *
 * Opus review (BLOCK) fix round, same PR: HIGH-1/2/4 restructure the capture→issue relationship
 * (see `issueCreditInTx`'s doc comment and `sumInlineReturnCredit`'s), HIGH-3 moves approve's
 * body onto a validated DTO, MED-5/6/7 are documented at their own call sites below.
 */
import {
  INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
  assertReplayItems,
  inlineReturnItemsFingerprint,
} from "./inline-return-fingerprint";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { AddonService } from "../billing/addon.service";
import { NO_RESTOCK_REASONS } from "./returns.service";
import { restockReturnItems } from "./returns-restock.util";
import { sumInlineReturnCredit } from "./inline-return-credit.util";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { creditOverrideAuditItems } from "./inline-returns-pricing";
import type { CaptureInlineReturnDto, InlineReturnLinesDto } from "./dto/capture-inline-return.dto";
import type { ApproveInlineReturnDto } from "./dto/approve-inline-return.dto";
import { selectEditRevertedInvoices } from "../invoices/order-edit-revert-set";

/** design.md §8 — the ONE gate every money-writing method here re-checks itself,
 * regardless of the registry's rollout state (the `AddonGuard` on the controller courtesy-
 * allows a `dark` key; a service-level money write never does). */
const INLINE_RETURNS_ADDON_KEY = "orders_inline_returns";

/**
 * The capture service's own refusal codes (SA-204). The mobile capture classifier
 * (apps/mobile/lib/inline-return-submit-key.ts) settles a 4xx ONLY when the body carries one of
 * these — a post-lookup business refusal is terminal, everything else (401/403/408/429, a code-
 * less 400 from the validation pipe, 5xx, no response) keeps the nonce. Pinned set-equal to the
 * mobile copy by inline-returns.service.spec.ts.
 */
export const INLINE_RETURN_ERROR_CODES = {
  ORDER_NOT_FOUND: "INLINE_RETURN_ORDER_NOT_FOUND",
  ORDER_CUSTOMER_MISMATCH: "INLINE_RETURN_ORDER_CUSTOMER_MISMATCH",
  ORDER_CANCELLED: "INLINE_RETURN_ORDER_CANCELLED",
  RETURN_KEY_CONFLICT: "INLINE_RETURN_KEY_CONFLICT",
  // #2424: the same key, the same customer/order, but DIFFERENT items: not a replay. The client
  // treats it as a definite refusal (settles its nonce), so its next capture mints a new key.
  RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS: INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
} as const;

/** The 409 code of a returnKey already held (create's preflight: a replay, or a real collision). */
export const INLINE_RETURN_KEY_TAKEN = "INLINE_RETURN_KEY_TAKEN";

@Injectable()
export class InlineReturnsService {
  private readonly logger = new Logger(InlineReturnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly ledger: RegulatedLedgerService,
    private readonly creditNotes: CreditNotesService,
    private readonly numbering: NumberingService,
    private readonly addonService: AddonService,
    private readonly quoteService: InlineReturnsQuoteService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** design.md §8: fail-closed regardless of the registry's dark/enforced state. A
   * SUPER_ADMIN context (`tenantId === null`) is never addon-gated — mirrors `AddonGuard`. */
  private async assertGranted(tenantId: string | null): Promise<void> {
    if (!tenantId) return;
    if (!(await this.addonService.hasAddon(tenantId, INLINE_RETURNS_ADDON_KEY))) {
      throw new ForbiddenException(
        `This feature requires the "${INLINE_RETURNS_ADDON_KEY}" add-on.`,
      );
    }
  }

  private restockDefault(reason: string | undefined): boolean {
    return !NO_RESTOCK_REASONS.has(reason ?? "");
  }

  /** MED-7: true only for a P2002 whose violated constraint is `returnKey`'s own unique
   * index — permissive on an empty/unreported target (mirrors credit-notes.service.ts's
   * `create()` P2002 handling), but never true for an unrelated unique violation. */
  /** #2424: a same-pair replay must carry the same items as the stored capture, else 409. */
  private assertReplaySameItems(
    existing: { id: string; returnNumber?: string | null; capturePayload?: unknown },
    dto: { items: any[]; reason?: string | null },
  ) {
    assertReplayItems(existing, dto, this.logger);
  }

  private isReturnKeyConflict(err: any): boolean {
    if (err?.code !== "P2002") return false;
    const target = Array.isArray(err?.meta?.target)
      ? err.meta.target.join(",")
      : String(err?.meta?.target ?? "");
    return target === "" || target.includes("returnKey");
  }

  private async reverseLedgerForReturn(tx: any, ret: { id: string; items: any[] }): Promise<void> {
    // Regulated ledger reversal, grouped per SOURCE order — an inline return's goods can come
    // from MULTIPLE source orders, unlike a STANDARD return.
    const bySource = new Map<string, Map<string, number>>();
    for (const item of ret.items as any[]) {
      if (!item.sourceOrderId) continue;
      const m = bySource.get(item.sourceOrderId) ?? new Map<string, number>();
      m.set(item.productId, (m.get(item.productId) ?? 0) + Number(item.qty));
      bySource.set(item.sourceOrderId, m);
    }
    for (const [sourceOrderId, returnedByProduct] of bySource) {
      await this.ledger.reverseReturnEntries({
        returnId: ret.id,
        orderId: sourceOrderId,
        returnedByProduct,
        // capture()'s ReturnItem.qty comes from priced.chunks[].pieces — genuinely
        // piece-denominated, unlike the standard path's ReturnItem.qty.
        returnedUnit: "PIECES",
        db: tx,
      });
    }
  }

  /** MED-5: a DRIVER may only capture against an order that's actually on their own current
   * route run (§7's "at-stop 'Add return'" surface — a driver has no business touching an
   * arbitrary tenant order). `routeRunStopId` is already required for a DRIVER by
   * `priceInlineReturn`'s own M8 check (stop ownership + run IN_PROGRESS, run BEFORE this);
   * this adds the piece M8 doesn't cover — that the CAPTURED order itself is on that same
   * run, not just that the stop/run belong to the driver. */
  private async assertDriverOwnsOrder(
    tx: any,
    dto: CaptureInlineReturnDto,
    order: { routeRunId: string | null },
  ): Promise<void> {
    if (!dto.routeRunStopId) {
      throw new ForbiddenException("routeRunStopId is required for a driver capture");
    }
    const stop = await tx.routeRunStop.findFirst({
      where: { id: dto.routeRunStopId },
      select: { routeRunId: true },
    });
    if (!stop || !order.routeRunId || stop.routeRunId !== order.routeRunId) {
      throw new ForbiddenException("This order is not on your current route run");
    }
  }

  /**
   * #2094 (SA-194): the gate every in-order caller runs FIRST, before any read: a buyer never
   * captures a return at order entry, and the add-on is re-checked by the service regardless of
   * the registry's rollout state.
   */
  async assertInlineReturnAllowed(user: JwtPayload): Promise<void> {
    if (user.role === UserRole.CUSTOMER) {
      throw new ForbiddenException("Buyers cannot capture returns at order entry");
    }
    await this.assertGranted(this.prisma.getTenantId());
  }

  /**
   * The customer-scoped advisory lock (transaction-scoped, on the caller's own tx connection): the
   * ONE definition, shared by the standalone capture and the order create/edit paths. It must be
   * the tx's FIRST statement, before any row lock: house order advisory -> Return -> Order ->
   * Invoice -> rows (SA-214). Inline and STANDARD return creation for one customer serialize on it.
   */
  async lockCustomerInTx(tx: any, customerId: string): Promise<void> {
    await this.idempotency.acquireLock(
      this.idempotency.hashFor(customerId, this.prisma.getTenantId(), "returns.customer"),
      tx,
    );
  }

  /**
   * #2094 (SA-221): an order create reserves the credit-note number ONCE, before its P2002 retry
   * loop, and reuses it across attempts (a final failure burns it, as a burned order number does
   * today). Own short transaction, never inside a caller's tx that holds rows.
   */
  reserveCreditNoteNumber(): Promise<string> {
    const tenantId = this.prisma.getTenantId();
    return this.numbering.reserveNext("CREDIT_NOTE", {
      year: new Date().getFullYear(),
      tenantId: tenantId ?? undefined,
    });
  }

  /**
   * #2094 (Opus N1): validate a NEW order's return BEFORE its credit-note number is reserved, so a
   * refused request burns none. Unlocked and read-only: any existing INLINE returnKey is a 409 (a true
   * replay of this order returned earlier, in create()'s idempotency pre-check), then a DRY-RUN of the
   * pricing engine (a stale quote or an unmatchable line refuses here). Returns the dry-run total so
   * the caller can skip the reservation for a $0 return. The in-tx checks stay as the backstop.
   */
  async preflightNewOrderReturn(
    lines: InlineReturnLinesDto,
    customerId: string,
    user: JwtPayload,
  ): Promise<number> {
    const db = this.prisma.forTenant();
    if (lines.returnKey) {
      const pre = await db.return.findFirst({
        where: { returnKey: lines.returnKey, kind: "INLINE" },
        select: { id: true },
      });
      if (pre) {
        throw new ConflictException({
          code: INLINE_RETURN_KEY_TAKEN,
          message: "A different return already used this capture key",
        });
      }
    }
    const priced = await this.quoteService.priceInlineReturn(
      { customerId, items: lines.items, routeRunStopId: lines.routeRunStopId },
      user,
      db,
    );
    return priced.total;
  }

  /** Post-commit only, like every credit-note event here. */
  emitCreditIssued(tenantId: string | null, minted: any): void {
    this.emitCreditNoteCreated(tenantId, minted);
  }

  /**
   * capture()'s transaction body, VERBATIM, minus the customer advisory lock: the CALLER holds it
   * (`standalone capture` takes it first thing in its own tx; the order create/edit paths take it as
   * their first statement, before any row lock: house order advisory -> Return -> Order -> Invoice ->
   * rows, SA-214). Never opens a transaction, never takes a lock of its own on the customer, and
   * never calls anything that does (source-pinned in inline-returns-source-pins.spec.ts).
   *
   * `opts.orderRouteRunId`: a NEW order links its run after its own transaction, so a DRIVER's
   * ownership check would otherwise see `routeRunId: null`; the create path passes the run it
   * already validated.
   */
  async captureInTx(
    tx: any,
    dto: CaptureInlineReturnDto,
    user: JwtPayload,
    opts: { orderRouteRunId?: string | null } = {},
  ): Promise<{ replayed: boolean; ret: any; overCap: boolean }> {
    const tenantId = this.prisma.getTenantId();
    await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${dto.orderId} FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id: dto.orderId },
      select: { id: true, customerId: true, total: true, status: true, routeRunId: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: INLINE_RETURN_ERROR_CODES.ORDER_NOT_FOUND,
        message: "Order not found",
      });
    }
    if (order.customerId !== dto.customerId) {
      throw new BadRequestException({
        code: INLINE_RETURN_ERROR_CODES.ORDER_CUSTOMER_MISMATCH,
        message: "Order does not belong to this customer",
      });
    }
    if (order.status === "CANCELLED") {
      throw new BadRequestException({
        code: INLINE_RETURN_ERROR_CODES.ORDER_CANCELLED,
        message: "Cannot capture a return against a cancelled order",
      });
    }
    if (user.role === UserRole.DRIVER) {
      await this.assertDriverOwnsOrder(tx, dto, {
        routeRunId: order.routeRunId ?? opts.orderRouteRunId ?? null,
      });
    }

    // Re-check the replay key INSIDE the lock — a racer that lost the acquire above may
    // have committed a matching row while this call waited for it. MED-7 (re-review):
    // only trusted as a replay when it matches THIS (customerId, orderId) — the same
    // rule the pre-tx check and the post-catch P2002 recovery both apply. A returnKey
    // collision against a DIFFERENT customer/order here is a genuine conflict, never a
    // silent replay of someone else's return.
    if (dto.returnKey) {
      const raced = await tx.return.findFirst({
        where: { returnKey: dto.returnKey, kind: "INLINE" },
        include: { items: true },
      });
      if (raced) {
        if (raced.customerId !== dto.customerId || raced.orderId !== dto.orderId) {
          throw new ConflictException({
            code: INLINE_RETURN_ERROR_CODES.RETURN_KEY_CONFLICT,
            message: "A different return already used this capture key",
          });
        }
        this.assertReplaySameItems(raced, dto); // #2424
        return {
          replayed: true as const,
          ret: raced,
          overCap: raced.holdReason === "DRIVER_CAP",
        };
      }
    }

    // Same pricing engine the quote endpoint uses, run on THIS transaction's client so
    // it reads the matching-set/prior-returned snapshot under the lock just taken.
    const priced = await this.quoteService.priceInlineReturn(
      { customerId: dto.customerId, items: dto.items, routeRunStopId: dto.routeRunStopId },
      user,
      tx,
    );

    // §4 N-5: Σ (committed credit of non-cancelled inline returns already on this
    // order), read under the carrying-order lock just taken — the driver cap compares
    // Σ+this return's total against the order's gross (config driverCreditCap = 0 =
    // gross, PR-1..3's fixed default; no config reader yet).
    const priorCredit = await sumInlineReturnCredit(tx, dto.orderId);
    const cap = roundMoney(Number(order.total ?? 0));
    const wouldBe = roundMoney(priorCredit + priced.total);
    const isDriver = user.role === UserRole.DRIVER;
    // Re-review LOW-MED: a zero-total return has nothing to hold — a $0.00 "credit
    // awaiting approval" is never a real DRIVER_CAP case, so it's excluded even when
    // Σ is already at/over the order's gross.
    const overCap = isDriver && priced.total > 0.001 && wouldBe > cap + 0.001;

    const year = new Date().getFullYear();
    const returnNumber = await this.numbering.reserveNext("RETURN", {
      year,
      tenantId: tenantId ?? undefined,
      tx,
    });

    const itemsData = priced.chunks.map((c) => {
      const dtoItem = dto.items.find((i) => i.productId === c.productId);
      const reason = dtoItem?.reason ?? dto.reason ?? "EXCESS_ORDER";
      return {
        productId: c.productId,
        qty: c.pieces,
        reason,
        condition: dtoItem?.condition,
        restock: dtoItem?.restock ?? this.restockDefault(reason),
        sourceOrderId: c.sourceOrderId,
        sourceInvoiceItemId: c.sourceInvoiceItemId,
        sourceOrderItemId: c.sourceOrderItemId,
        unitPrice: c.unitPrice,
        subtotal: c.subtotal,
        taxAmount: c.taxAmount,
        categoryTax: c.categoryTax,
        priceSource: c.priceSource,
        originalPrice: c.originalPrice ?? null,
        overrideReason: c.overrideReason ?? null,
        overriddenBy: c.overriddenBy ?? null,
        tenantId, // nested creates bypass the tx proxy's auto-injection
      };
    });

    // MED-7: NO try/catch around this insert — a P2002 here aborts the transaction
    // (25P02); any further query on `tx` would itself fail on the aborted connection.
    // Let it propagate to the OUTER catch below, which re-checks on a fresh connection.
    const created = await tx.return.create({
      data: {
        returnNumber,
        orderId: dto.orderId,
        customerId: dto.customerId,
        reason: dto.reason ?? "EXCESS_ORDER",
        notes: dto.notes,
        photoUrls: dto.photoUrls ?? [],
        status: "RECEIVED",
        kind: "INLINE",
        returnKey: dto.returnKey,
        capturePayload: inlineReturnItemsFingerprint(dto.items, dto.reason), // #2424: what a replay must match
        capturedById: user.sub,
        capturedRole: user.role,
        routeRunStopId: dto.routeRunStopId,
        creditSubtotal: priced.subtotal,
        creditTax: priced.taxAmount,
        creditCategoryTax: priced.categoryTax,
        ...(overCap ? { holdReason: "DRIVER_CAP", heldAmount: priced.total } : {}),
        items: { create: itemsData },
      },
      include: { items: true },
    });

    // #2695 (SA-557): ONE in-tx audit row naming every lowered credit — the default it replaced,
    // the price typed, and why. A held (DRIVER_CAP) return cannot carry one: overrides are staff-only.
    const overridden = priced.chunks.filter((c) => c.priceSource === "MANUAL");
    if (overridden.length > 0) {
      await tx.auditLog.create({
        data: {
          userId: user.sub,
          action: "inline_return.price_override",
          entityType: "Return",
          entityId: created.id,
          meta: {
            orderId: dto.orderId,
            customerId: dto.customerId,
            items: creditOverrideAuditItems(overridden),
          },
        },
      });
    }

    if (!overCap) {
      // HIGH-4: restock/ledger reversal happens NOW only for a return that is NOT
      // held — a DRIVER_CAP hold defers both to approve() (design §5), so goods aren't
      // released from inventory until an operator actually approves the credit.
      await restockReturnItems(tx, created, user.sub);
      await this.reverseLedgerForReturn(tx, created);
    } else {
      // §4: in-tx audit row — the socket/push alert + tenant-grouped alert sweep
      // (`RETURN_QTY_MISMATCH`) are PR-1d; this row is what 1d's sweep will read.
      await tx.auditLog.create({
        data: {
          userId: user.sub,
          action: "inline_return.driver_cap_hold",
          entityType: "Return",
          entityId: created.id,
          meta: {
            orderId: dto.orderId,
            customerId: dto.customerId,
            capturedById: user.sub,
            capturedRole: user.role,
            heldAmount: priced.total,
            priorCredit,
            orderGross: cap,
            reason: "DRIVER_CAP",
          },
        },
      });
    }

    return { replayed: false as const, ret: created, overCap };
  }

  /**
   * #2094 (Opus R1, B215 class): validate a return BEFORE the caller does anything that commits on its
   * own connection (updateOrderItems' un-tx'd revertLinkedInvoicesForOrderEdit flips a SENT invoice to
   * DRAFT). Every refusal captureInTx would throw later, inside the tx, would otherwise roll back the
   * edit but leave that invoice reverted for good. Unlocked and read-only: an unlocked returnKey read
   * like capture()'s (a key on ANOTHER customer/order is a 409; the same pair is a replay, nothing to
   * price), the driver's stop/run checks, and a DRY-RUN of the pricing engine (a stale quote or an
   * unmatchable line refuses here). The in-tx checks stay as the backstop under the locks.
   *
   * The returned total is ONLY a gate (and a replay signal: null). The in-tx price, read under the
   * locks, is authoritative and may differ (a stale price race), so the caller never uses this figure
   * to decide whether an in-tx counter reservation is needed: it reserves ahead regardless (SA-292).
   *
   * #2178 (closes the L1 residual, SA-321): on an UNDELIVERED order edit the caller passes
   * `revertOrderId`, and the dry run prices against the matching set as it will be AFTER
   * `revertLinkedInvoicesForOrderEdit` — the invoices that revert turns into DRAFTs of an undelivered
   * order are left out (the ONE selection, invoices/order-edit-revert-set.ts). So a boxed return whose
   * only pack evidence is this order's own SENT invoice now refuses INLINE_RETURN_PACK_UNKNOWN HERE,
   * before the revert commits, instead of in the tx after it (the B215 class).
   */
  async preflightCapture(
    dto: CaptureInlineReturnDto,
    user: JwtPayload,
    order: { routeRunId: string | null },
    // #2178: set on an UNDELIVERED order edit, whose linked-invoice revert runs next: price against
    // the matching set as it will be AFTER that revert (the reverted invoices left out), so a return
    // whose only pack evidence is this order's own SENT invoice refuses HERE, before the revert.
    opts: { revertOrderId?: string } = {},
  ): Promise<number | null> {
    const db = this.prisma.forTenant();
    if (dto.returnKey) {
      const pre = await db.return.findFirst({
        where: { returnKey: dto.returnKey, kind: "INLINE" },
        select: {
          id: true,
          returnNumber: true,
          customerId: true,
          orderId: true,
          capturePayload: true,
        },
      });
      if (pre) {
        if (pre.customerId !== dto.customerId || pre.orderId !== dto.orderId) {
          throw new ConflictException("A different return already used this capture key");
        }
        this.assertReplaySameItems(pre, dto); // #2424
        return null; // a replay of THIS return: nothing to price or reserve; the in-tx check returns the row
      }
    }
    if (user.role === UserRole.DRIVER) await this.assertDriverOwnsOrder(db, dto, order);
    const excludeInvoiceIds = opts.revertOrderId
      ? (await selectEditRevertedInvoices(db, opts.revertOrderId)).map((inv) => inv.id)
      : [];
    const priced = await this.quoteService.priceInlineReturn(
      { customerId: dto.customerId, items: dto.items, routeRunStopId: dto.routeRunStopId },
      user,
      db,
      { excludeInvoiceIds },
    );
    return priced.total; // the dry-run total: a gate only; the edit path reserves ahead regardless (SA-292)
  }

  /**
   * captureInTx + the credit issue in the SAME transaction (#2094, SA-194/SA-221): mint the credit
   * note (at `opts.creditNoteNumber` when the caller reserved one before its retry loop, else a
   * number reserved on this tx), link it, record the system-owned orderCreditNote intent capped at
   * the order's remaining balance under the Order lock the caller holds, and settle. A replay (the
   * credit already exists) and a DRIVER_CAP hold issue nothing. `minted` is null in those cases and
   * for a zero-total return; the caller emits the CN event after ITS commit.
   */
  async captureAndIssueInTx(
    tx: any,
    dto: CaptureInlineReturnDto,
    user: JwtPayload,
    opts: { creditNoteNumber?: string; orderRouteRunId?: string | null } = {},
  ): Promise<{ replayed: boolean; ret: any; overCap: boolean; minted: any }> {
    const captured = await this.captureInTx(tx, dto, user, {
      orderRouteRunId: opts.orderRouteRunId,
    });
    if (captured.replayed || captured.overCap) return { ...captured, minted: null };
    const ret = captured.ret;
    const amount = roundMoney(
      Number(ret.creditSubtotal ?? 0) +
        Number(ret.creditTax ?? 0) +
        Number(ret.creditCategoryTax ?? 0),
    );
    const minted = await this.issueCreditInTx(tx, ret, amount, this.prisma.getTenantId(), {
      creditNoteNumber: opts.creditNoteNumber,
      capIntentToOrderBalance: true,
    });
    return { ...captured, minted };
  }

  /**
   * B735: attaches the return's own unresolved `RegulatedLedgerParkedReversal` rows to a
   * response about to leave `capture()`/`approve()` — a FRESH read, never a value threaded up
   * from the reversal call itself. `reverseLedgerForReturn` is `void` all the way down
   * (`reverseReturnEntries`'s B681/SA-067 park branch only writes the row + warns), and
   * `capture()` has replay/idempotency exits that never call it at all — a threaded value would
   * show a parked capture as clean on a retry or double-tap. Reading fresh by `returnId` catches
   * every exit uniformly, needs no signature change to the ledger service (whose OTHER caller,
   * standard returns, can never park), and stays correct after `cancel()` (which deletes
   * unresolved parked rows). `tenantId` is included in the `where` explicitly —
   * belt-and-suspenders regardless of whether `forTenant()` already scopes this model.
   */
  private async withParkedReversals<T extends { id: string }>(
    ret: T,
  ): Promise<T & { parkedReversals?: { count: number; pieces: number } | null }> {
    // `parkedReversals` semantics: null = CHECKED and clean; ABSENT = not checked. The read
    // runs after the work committed, so it must never turn committed work into a 500 (a retry
    // of approve() would then 400 and the operator would never see the response).
    const tenantId = this.prisma.getTenantId();
    // No tenant context (SUPER_ADMIN): nothing was checked, so the field is omitted.
    if (!tenantId) return ret;
    try {
      const rows = await this.prisma.forTenant().regulatedLedgerParkedReversal.findMany({
        where: { returnId: ret.id, tenantId, resolvedAt: null },
        select: { returnedPieces: true },
      });
      const parkedReversals = rows.length
        ? {
            count: rows.length,
            pieces: rows.reduce((sum: number, r: any) => sum + Number(r.returnedPieces), 0),
          }
        : null;
      return { ...ret, parkedReversals };
    } catch (err) {
      this.logger.warn(
        `B735: parked-reversal read failed for return ${ret.id}; response omits parkedReversals: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return ret;
    }
  }

  /**
   * Captures an inline return against an existing carrying order: prices it (the same
   * engine the quote endpoint uses), and either restocks + reverses the regulated ledger +
   * issues a standalone credit note immediately, or (above the driver cap) holds the whole
   * credit for approval — HIGH-4: a held return's restock/ledger reversal is DEFERRED to
   * `approve()`, never applied at capture.
   */
  async capture(dto: CaptureInlineReturnDto, user: JwtPayload): Promise<any> {
    // CUSTOMER refused before any DB read (Q5 — buyers keep the post-delivery request flow).
    if (user.role === UserRole.CUSTOMER) {
      throw new ForbiddenException("Buyers cannot capture returns at order entry");
    }

    const tenantId = this.prisma.getTenantId();
    await this.assertGranted(tenantId);

    let result: { replayed: boolean; ret: any; overCap: boolean };

    // m-2/m-3: an unlocked pre-read resolves an already-captured returnKey without opening a
    // transaction — a retried submission (offline replay, double-tap) burns nothing. Routed
    // through the SAME post-processing tail below (never a bare early return) so a row stuck
    // RECEIVED with no credit note and no hold (HIGH-2: a prior issueCredit that failed after
    // capture committed) gets retried here too, not just on a fresh capture. Only trusted as a
    // replay when it actually belongs to this (customerId, orderId) pair — a returnKey
    // collision across two unrelated requests is a genuine conflict, not a replay.
    const preExisting = dto.returnKey
      ? await this.prisma.forTenant().return.findFirst({
          where: { returnKey: dto.returnKey, kind: "INLINE" },
          include: { items: true },
        })
      : null;

    if (
      preExisting &&
      preExisting.customerId === dto.customerId &&
      preExisting.orderId === dto.orderId
    ) {
      this.assertReplaySameItems(preExisting, dto); // #2424
      result = {
        replayed: true,
        ret: preExisting,
        overCap: preExisting.holdReason === "DRIVER_CAP",
      };
    } else {
      try {
        result = await this.prisma.tenantTransaction(async (tx: any) => {
          // §5: the SAME customer-scoped lock returns.service.ts's create() takes — inline and
          // standard return creation for one customer serialize against each other here. The
          // order create/edit paths (#2094) take this same lock themselves, as their FIRST
          // statement, and then call `captureInTx`.
          await this.lockCustomerInTx(tx, dto.customerId);
          return this.captureInTx(tx, dto, user);
        });
      } catch (err: any) {
        if (this.isReturnKeyConflict(err) && dto.returnKey) {
          const raced = await this.prisma.forTenant().return.findFirst({
            where: { returnKey: dto.returnKey, kind: "INLINE" },
            include: { items: true },
          });
          if (raced && raced.customerId === dto.customerId && raced.orderId === dto.orderId) {
            this.assertReplaySameItems(raced, dto); // #2424
            result = { replayed: true, ret: raced, overCap: raced.holdReason === "DRIVER_CAP" };
          } else {
            throw new ConflictException({
              code: INLINE_RETURN_ERROR_CODES.RETURN_KEY_CONFLICT,
              message: "A different return already used this capture key",
            });
          }
        } else {
          throw err;
        }
      }
    }

    // HIGH-2: a RECEIVED row with neither a credit note nor a hold is "stuck" — either just
    // captured (the normal, expected case) or left behind by a PRIOR issueCredit that failed
    // after this same capture committed. Either way, (re-)issue idempotently before returning.
    if (result.ret.status === "RECEIVED" && !result.ret.creditNoteId && !result.ret.holdReason) {
      await this.issueCredit(result.ret.id);
      const reissued = await this.prisma
        .forTenant()
        .return.findUnique({ where: { id: result.ret.id }, include: { items: true } });
      // #2144: never fall back to the PRE-issue snapshot — it has no creditNoteId, so the response
      // would look un-issued for a credit that WAS issued. Like approve() (#2467), a null read-back
      // (the row vanished mid-request) refuses; a retry with the same returnKey replays and
      // returns the issued row.
      if (!reissued) throw new NotFoundException("Return not found");
      return this.withParkedReversals(reissued);
    }
    return this.withParkedReversals(result.ret);
  }

  /**
   * The shared mint+link+intent+settle body — runs INSIDE the caller's OWN transaction and
   * OWN row lock (never opens one itself). Used by `issueCredit()` (the plain, immediate-
   * issue path) and `approve()` (HIGH-2: the driver-cap approval path, now merged into ONE
   * transaction with its own claim/restock instead of a separate later step). Returns the
   * minted credit note (for the caller's post-commit gateway emit), or `null` if `amount` is
   * not worth minting.
   */
  private async issueCreditInTx(
    tx: any,
    fresh: { id: string; customerId: string; orderId: string; returnNumber: string | null },
    amount: number,
    tenantId: string | null,
    extra?: {
      approvedById?: string;
      creditNoteNumber?: string;
      /** In-order path (#2094): cap the system-owned intent at the order's remaining balance. */
      capIntentToOrderBalance?: boolean;
    },
  ): Promise<any> {
    if (!(amount > 0.001)) return null;

    const year = new Date().getFullYear();
    // #2094: an order create reserves the number ONCE before its P2002 retry loop and reuses it
    // across attempts; every other caller reserves here, on its own tx.
    const creditNoteNumber =
      extra?.creditNoteNumber ??
      (await this.numbering.reserveNext("CREDIT_NOTE", {
        year,
        tenantId: tenantId ?? undefined,
        tx,
      }));

    const minted = await this.creditNotes.mintStandaloneInTx(
      tx,
      {
        customerId: fresh.customerId,
        amount,
        reason: `Inline return ${fresh.returnNumber ?? fresh.id.slice(0, 8)}`,
      },
      creditNoteNumber,
      tenantId,
    );

    // N-1 guarded link: under the row lock the caller already holds this can only ever match
    // 0 rows if `fresh` was stale — a miss throws and rolls the mint back too, rather than
    // ever leaving an orphaned CN with no return pointing at it.
    const linked = await tx.return.updateMany({
      where: { id: fresh.id, kind: "INLINE", status: "RECEIVED", creditNoteId: null },
      data: {
        creditNoteId: minted.id,
        status: "REFUNDED",
        refundMethod: "CREDIT_NOTE",
        refundAmount: amount,
        refundedAt: new Date(),
        holdReason: null,
        heldAmount: null,
        ...(extra?.approvedById
          ? { approvedById: extra.approvedById, approvedAt: new Date() }
          : {}),
      },
    });
    if (linked.count === 0) {
      throw new ConflictException("Return changed state during credit issue — retry");
    }

    // §2.1/§6.3: the one explicit, SYSTEM-OWNED intent on the carrying order.
    // #2094 (SA-221 change 3): inside an order create/edit the intent is capped at the order's
    // balance, read under the Order lock the caller holds = the order total minus the credits
    // already applied to it. A new order has no invoice yet, so that is the whole balance. The CN is
    // minted in full either way; whatever the cap leaves out stays on the customer's account.
    let intent = amount;
    if (extra?.capIntentToOrderBalance) {
      const order = await tx.order.findFirst({
        where: { id: fresh.orderId },
        select: { total: true },
      });
      const applied = await tx.orderCreditNote.aggregate({
        where: { orderId: fresh.orderId },
        _sum: { amount: true },
      });
      const balance = Number(order?.total ?? 0) - Number(applied._sum.amount ?? 0);
      intent = roundMoney(Math.min(amount, Math.max(0, balance)));
    }
    if (intent > 0.001) {
      await tx.orderCreditNote.create({
        data: { orderId: fresh.orderId, creditNoteId: minted.id, amount: intent },
      });
    }
    await this.creditNotes.settleOrderCreditsInTx(tx, fresh.orderId, tenantId);
    return minted;
  }

  private emitCreditNoteCreated(tenantId: string | null, minted: any): void {
    // Fired AFTER commit — never from inside the transaction (a later rollback must never
    // have already told the dashboard about a credit note that doesn't exist).
    this.gateway.emitCreditNoteCreated(tenantId, {
      creditNoteId: minted.id,
      creditNoteNumber: minted.creditNoteNumber,
      customerId: minted.customerId,
      amount: Number(minted.amount),
    });
  }

  /**
   * §6.5.3: unlocked pre-read (m-2) → tx: Return FOR UPDATE → guard → `issueCreditInTx`
   * (m-1 mint, N-1 guarded link, intent, settle) → one commit. The immediate-issue path for
   * a return that was NOT held — the amount is the full priced total, never overridden
   * (`approve()` calls `issueCreditInTx` directly with its own, possibly-reduced amount).
   */
  private async issueCredit(returnId: string): Promise<void> {
    // m-2: a return that's already issued, held, or not eligible at all burns no number and
    // opens no transaction — "a refused retry burns nothing".
    const pre = await this.prisma.forTenant().return.findFirst({
      where: { id: returnId, kind: "INLINE" },
    });
    if (!pre || pre.status !== "RECEIVED" || pre.creditNoteId || pre.holdReason) return;

    const tenantId = this.prisma.getTenantId();
    let minted: any;
    await this.prisma.tenantTransaction(async (tx: any) => {
      // N-1: the Return row lock IS the shared issue/cancel claim.
      await tx.$executeRaw`SELECT id FROM "Return" WHERE id = ${returnId} FOR UPDATE`;
      const fresh = await tx.return.findFirst({ where: { id: returnId, kind: "INLINE" } });
      // cancel() (or a racing issue) already moved this return out of RECEIVED/no-CN/no-hold —
      // "cancel between re-read and link ⇒ no CN": mint nothing.
      if (!fresh || fresh.status !== "RECEIVED" || fresh.creditNoteId || fresh.holdReason) return;

      const amount = roundMoney(
        Number(fresh.creditSubtotal ?? 0) +
          Number(fresh.creditTax ?? 0) +
          Number(fresh.creditCategoryTax ?? 0),
      );
      minted = await this.issueCreditInTx(tx, fresh, amount, tenantId);
    });

    if (minted) this.emitCreditNoteCreated(tenantId, minted);
  }

  /**
   * N-5/Q-C: approves (optionally reducing) a driver-cap hold — restocking + reversing the
   * regulated ledger (HIGH-4: deferred from capture) and issuing the credit note, all inside
   * ONE transaction (HIGH-2) — a failure anywhere in that body rolls back the WHOLE thing,
   * leaving the return exactly as it was (still RECEIVED+DRIVER_CAP+heldAmount), never stuck
   * mid-approval. A retried/duplicate approve loses the row-lock race and mints nothing a
   * second time — "approve retry ⇒ one CN".
   */
  async approve(id: string, user: JwtPayload, dto?: ApproveInlineReturnDto): Promise<any> {
    const tenantId = this.prisma.getTenantId();
    await this.assertGranted(tenantId);

    // Fast pre-check (unlocked): a genuinely invalid target 400s here without opening a
    // transaction. A RACE (another approve/reject/cancel wins between this read and the row
    // lock below) is caught again, authoritatively, under the lock — that miss returns the
    // current state silently instead of throwing.
    const pre = await this.prisma.forTenant().return.findFirst({ where: { id, kind: "INLINE" } });
    if (!pre) throw new NotFoundException("Return not found");
    // #2143: an ALREADY-APPROVED hold (approve() committed, then its read-back failed and the
    // operator retried). The approval set status REFUNDED, the credit note and approvedAt, so a
    // retry returns the current state — idempotent, no transaction, no second money write. A
    // return issued without a hold has no approvedAt and still falls through to the 400 below.
    if (pre.status === "REFUNDED" && pre.creditNoteId && pre.approvedAt) {
      const current = await this.prisma
        .forTenant()
        .return.findUnique({ where: { id }, include: { items: true } });
      if (!current) throw new NotFoundException("Return not found");
      return this.withParkedReversals(current);
    }
    if (pre.status !== "RECEIVED" || pre.holdReason !== "DRIVER_CAP" || pre.creditNoteId) {
      throw new BadRequestException("Only a driver-cap hold awaiting approval can be approved");
    }
    const heldAmountPre = roundMoney(Number(pre.heldAmount ?? 0));
    const requestedPre = dto?.amount != null ? roundMoney(dto.amount) : heldAmountPre;
    if (dto?.amount != null && requestedPre > heldAmountPre + 0.001) {
      throw new BadRequestException("Approved amount cannot exceed the held credit");
    }
    // Re-review LOW-MED: a zero (or near-zero) amount is never a real "approval" — that's
    // what reject() is for. Thrown here, BEFORE the transaction opens, so a garbage/zero
    // amount never triggers a restock or regulated-ledger reversal at all.
    if (!(requestedPre > 0.001)) {
      throw new BadRequestException(
        "Approved amount must be greater than 0 — use reject() to decline a hold entirely",
      );
    }

    let minted: any;
    const result = await this.prisma.tenantTransaction(async (tx: any) => {
      await tx.$executeRaw`SELECT id FROM "Return" WHERE id = ${id} FOR UPDATE`;
      const fresh = await tx.return.findFirst({
        where: { id, kind: "INLINE" },
        include: { items: true },
      });
      if (
        !fresh ||
        fresh.status !== "RECEIVED" ||
        fresh.holdReason !== "DRIVER_CAP" ||
        fresh.creditNoteId
      ) {
        return { skipped: true as const };
      }
      const heldAmount = roundMoney(Number(fresh.heldAmount ?? 0));
      const amount = dto?.amount != null ? roundMoney(dto.amount) : heldAmount;
      if (amount > heldAmount + 0.001) {
        throw new BadRequestException("Approved amount cannot exceed the held credit");
      }
      // Authoritative re-check under the row lock — same rule as the pre-check above, in
      // case a concurrent write shrank `heldAmount` to ~0 between the two reads.
      if (!(amount > 0.001)) {
        throw new BadRequestException(
          "Approved amount must be greater than 0 — use reject() to decline a hold entirely",
        );
      }

      // HIGH-4: apply what capture() deferred — restock + regulated-ledger reversal — now
      // that an operator has actually approved the credit.
      await restockReturnItems(tx, fresh, user.sub);
      await this.reverseLedgerForReturn(tx, fresh);

      minted = await this.issueCreditInTx(tx, fresh, amount, tenantId, { approvedById: user.sub });
      return { skipped: false as const };
    });

    if (!result.skipped && minted) this.emitCreditNoteCreated(tenantId, minted);
    const afterApprove = await this.prisma
      .forTenant()
      .return.findUnique({ where: { id }, include: { items: true } });
    // The row was locked and (on the non-skipped path) just written inside the transaction
    // above under this same id — a null read here would mean it vanished mid-request.
    if (!afterApprove) throw new NotFoundException("Return not found");
    return this.withParkedReversals(afterApprove);
  }

  /** Q-C: declines a driver-cap hold outright. HIGH-4: nothing was ever restocked or
   * reversed for a held return (that's deferred to `approve()`), so reject() undoes nothing
   * — it just finalizes the row as REJECTED. `holdReason`/`heldAmount` are deliberately LEFT
   * AS-IS (never cleared) rather than nulled — `cancel()`'s "was anything applied" check
   * relies on `holdReason` staying `"DRIVER_CAP"` here to tell a rejected-but-never-applied
   * hold apart from a genuinely applied (issued) return. */
  async reject(id: string, user: JwtPayload): Promise<any> {
    const tenantId = this.prisma.getTenantId();
    await this.assertGranted(tenantId);

    const claimed = await this.prisma.forTenant().return.updateMany({
      where: {
        id,
        kind: "INLINE",
        status: "RECEIVED",
        holdReason: "DRIVER_CAP",
        creditNoteId: null,
      },
      data: { status: "REJECTED", approvedById: user.sub, approvedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Only a driver-cap hold awaiting approval can be rejected");
    }
    return this.prisma.forTenant().return.findUnique({ where: { id }, include: { items: true } });
  }

  /**
   * m-5: Return FOR UPDATE → claim CANCELLED → carrying Order FOR UPDATE → unrestock +
   * unreverse only if this return's goods were ACTUALLY applied (REFUNDED, or RECEIVED with
   * no active hold — HIGH-4 changed what that means: a still-held or rejected-while-held
   * DRIVER_CAP row was never restocked at all) → pull back this CN's payments and void it →
   * delete the system-owned intent.
   */
  async cancel(id: string, user: JwtPayload): Promise<any> {
    const tenantId = this.prisma.getTenantId();
    await this.assertGranted(tenantId);

    return this.prisma.tenantTransaction(async (tx: any) => {
      await tx.$executeRaw`SELECT id FROM "Return" WHERE id = ${id} FOR UPDATE`;
      const fresh = await tx.return.findFirst({
        where: { id, kind: "INLINE" },
        include: { items: true },
      });
      if (!fresh) throw new NotFoundException("Return not found");

      const claimed = await tx.return.updateMany({
        where: { id, status: { not: "CANCELLED" } },
        data: { status: "CANCELLED", holdReason: null, heldAmount: null },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("Return is already cancelled");
      }

      // m-5 order: the carrying order is locked before any credit pull-back below touches
      // its invoices.
      await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${fresh.orderId} FOR UPDATE`;

      // HIGH-4: "applied" (restocked + regulated-ledger reversed) is no longer just
      // `status IN (RECEIVED, REFUNDED)` — a RECEIVED row still carrying `DRIVER_CAP` in
      // `holdReason` was captured but explicitly NOT yet applied (deferred to approve()); a
      // REJECTED row (from `reject()`, which leaves `holdReason` at `"DRIVER_CAP"` on
      // purpose) was never applied either. PENDING (1d's not-yet-captured order-hook rows)
      // and any other REJECTED/CANCELLED shape are likewise never applied.
      const wasApplied =
        fresh.status === "REFUNDED" || (fresh.status === "RECEIVED" && !fresh.holdReason);
      if (wasApplied) {
        for (const item of fresh.items as any[]) {
          if (!item.restock) continue;
          const product = await tx.product.findFirst({
            where: { id: item.productId },
            select: { currentStock: true, averageCost: true },
          });
          const qty = new Prisma.Decimal(item.qty);
          const currentStock = product?.currentStock ?? new Prisma.Decimal(0);
          await tx.product.update({
            where: { id: item.productId },
            data: { currentStock: { decrement: qty } },
          });
          // LOW: a COMPENSATING movement (negative qty) rather than deleting the original
          // RETURN movement by a fragile 8-char reference-prefix match — preserves the full
          // audit trail (a delete erased history; the prefix match also risks colliding
          // across two returns whose ids happen to share their first 8 characters).
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              type: "RETURN",
              quantity: qty.neg(),
              unitCost: product?.averageCost ?? null,
              avgCostAfter: product?.averageCost ?? null,
              stockAfter: currentStock.sub(qty),
              performedById: user.sub,
              reference: `RET-CANCEL-${fresh.id.slice(0, 8)}`,
            },
          });
        }
        await this.ledger.unreverseReturnEntries({ returnId: fresh.id, db: tx });
      }

      if (fresh.status === "REFUNDED" && fresh.creditNoteId) {
        // Pull back every non-VOID payment this ONE credit note made, then void it — never
        // sweeps a DIFFERENT credit note that happens to sit on the same order/invoice.
        // Throws RETURN_CREDIT_CONSUMED if some of its `amountUsed` can't be traced back to a
        // restorable payment (m-5: "restore < amountUsed").
        await this.creditNotes.cancelStandaloneInTx(tx, fresh.creditNoteId);
        await tx.orderCreditNote.deleteMany({
          where: { orderId: fresh.orderId, creditNoteId: fresh.creditNoteId },
        });
      }

      return tx.return.findUnique({ where: { id } });
    });
  }
}

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
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
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
import type { CaptureInlineReturnDto } from "./dto/capture-inline-return.dto";

/** design.md §8 — the ONE gate every money-writing method here re-checks itself,
 * regardless of the registry's rollout state (the `AddonGuard` on the controller courtesy-
 * allows a `dark` key; a service-level money write never does). */
const INLINE_RETURNS_ADDON_KEY = "orders_inline_returns";

@Injectable()
export class InlineReturnsService {
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

  /**
   * Captures an inline return against an existing carrying order: prices it (the same
   * engine the quote endpoint uses), restocks, reverses the regulated ledger, audits, and
   * either issues a standalone credit note immediately or holds the whole credit for
   * approval (N-5, above the driver cap).
   */
  async capture(dto: CaptureInlineReturnDto, user: JwtPayload): Promise<any> {
    // CUSTOMER refused before any DB read (Q5 — buyers keep the post-delivery request flow).
    if (user.role === UserRole.CUSTOMER) {
      throw new ForbiddenException("Buyers cannot capture returns at order entry");
    }

    const tenantId = this.prisma.getTenantId();
    await this.assertGranted(tenantId);

    // m-2/m-3 shape: an unlocked pre-read resolves an already-captured returnKey without
    // opening a transaction at all — a retried submission (offline replay, double-tap)
    // burns nothing and returns the SAME row.
    if (dto.returnKey) {
      const existing = await this.prisma.forTenant().return.findFirst({
        where: { returnKey: dto.returnKey, kind: "INLINE" },
        include: { items: true },
      });
      if (existing) return existing;
    }

    const result = await this.prisma.tenantTransaction(async (tx: any) => {
      // §5: the SAME customer-scoped lock returns.service.ts's create() takes — inline and
      // standard return creation for one customer serialize against each other here.
      await this.idempotency.acquireLock(
        this.idempotency.hashFor(dto.customerId, tenantId, "returns.customer"),
        tx,
      );

      await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${dto.orderId} FOR UPDATE`;
      const order = await tx.order.findFirst({
        where: { id: dto.orderId },
        select: { id: true, customerId: true, total: true },
      });
      if (!order) throw new NotFoundException("Order not found");
      if (order.customerId !== dto.customerId) {
        throw new BadRequestException("Order does not belong to this customer");
      }

      // Re-check the replay key INSIDE the lock — a racer that lost the acquire above may
      // have committed a matching row while this call waited for it.
      if (dto.returnKey) {
        const raced = await tx.return.findFirst({
          where: { returnKey: dto.returnKey, kind: "INLINE" },
          include: { items: true },
        });
        if (raced) return { replayed: true as const, ret: raced, overCap: false };
      }

      // Same pricing engine the quote endpoint uses, run on THIS transaction's client so it
      // reads the matching-set/prior-returned snapshot under the lock just taken.
      const priced = await this.quoteService.priceInlineReturn(
        { customerId: dto.customerId, items: dto.items, routeRunStopId: dto.routeRunStopId },
        user,
        tx,
      );

      // §4 N-5: Σ (issued + held credit of non-cancelled inline returns already on this
      // order), read under the carrying-order lock just taken — the driver cap compares
      // Σ+this return's total against the order's gross (config driverCreditCap = 0 = gross,
      // PR-1..3's fixed default; no config reader yet).
      const priorCredit = await sumInlineReturnCredit(tx, dto.orderId);
      const cap = roundMoney(Number(order.total ?? 0));
      const wouldBe = roundMoney(priorCredit + priced.total);
      const isDriver = user.role === UserRole.DRIVER;
      const overCap = isDriver && wouldBe > cap + 0.001;

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

      let created: any;
      try {
        created = await tx.return.create({
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
      } catch (err: any) {
        // m-3: a returnKey collision (a racer's insert won first) is a replay, never a 500.
        if (err?.code === "P2002" && dto.returnKey) {
          const raced = await tx.return.findFirst({
            where: { returnKey: dto.returnKey, kind: "INLINE" },
            include: { items: true },
          });
          if (raced) return { replayed: true as const, ret: raced, overCap: false };
        }
        throw err;
      }

      // §5: shared with receive() — restocks every item whose (resolved) restock flag is true.
      await restockReturnItems(tx, created, user.sub);

      // Regulated ledger reversal, grouped per SOURCE order — an inline return's goods can
      // come from MULTIPLE source orders, unlike a STANDARD return.
      const bySource = new Map<string, Map<string, number>>();
      for (const item of created.items as any[]) {
        if (!item.sourceOrderId) continue;
        const m = bySource.get(item.sourceOrderId) ?? new Map<string, number>();
        m.set(item.productId, (m.get(item.productId) ?? 0) + Number(item.qty));
        bySource.set(item.sourceOrderId, m);
      }
      for (const [sourceOrderId, returnedByProduct] of bySource) {
        await this.ledger.reverseReturnEntries({
          returnId: created.id,
          orderId: sourceOrderId,
          returnedByProduct,
          db: tx,
        });
      }

      if (overCap) {
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
    });

    if (result.replayed || result.overCap) return result.ret;

    // Sequential, NOT nested (same shape as ReturnsService.processRefund): the capture
    // transaction above already committed; issuing the credit is its own transaction.
    await this.issueCredit(result.ret.id);
    return this.prisma
      .forTenant()
      .return.findUnique({ where: { id: result.ret.id }, include: { items: true } });
  }

  /**
   * §6.5.3: unlocked pre-read (m-2) → `reserveNext("CREDIT_NOTE")` standalone (hoisted, same
   * reason `create()`/`CreditNotesService.create()` hoist theirs) → tx: Return FOR UPDATE →
   * guard → `mintStandaloneInTx` (m-1) → guarded link (N-1) → intent → settle; one commit.
   * `overrideAmount` is approve()'s (possibly reduced) held amount; omitted for the
   * immediate-issue path, which mints the full priced total.
   */
  private async issueCredit(returnId: string, overrideAmount?: number): Promise<void> {
    // m-2: a return that's already issued (or not eligible at all) burns no number and opens
    // no transaction — "a refused retry burns nothing".
    const pre = await this.prisma.forTenant().return.findFirst({
      where: { id: returnId, kind: "INLINE" },
    });
    if (!pre || pre.status !== "RECEIVED" || pre.creditNoteId) return;

    const tenantId = this.prisma.getTenantId();
    const amount =
      overrideAmount != null
        ? roundMoney(overrideAmount)
        : roundMoney(
            Number(pre.creditSubtotal ?? 0) +
              Number(pre.creditTax ?? 0) +
              Number(pre.creditCategoryTax ?? 0),
          );
    if (!(amount > 0.001)) return;

    const year = new Date().getFullYear();
    const creditNoteNumber = await this.numbering.reserveNext("CREDIT_NOTE", {
      year,
      tenantId: tenantId ?? undefined,
    });

    let minted: any;
    await this.prisma.tenantTransaction(async (tx: any) => {
      // N-1: the Return row lock IS the shared issue/cancel claim.
      await tx.$executeRaw`SELECT id FROM "Return" WHERE id = ${returnId} FOR UPDATE`;
      const fresh = await tx.return.findFirst({ where: { id: returnId, kind: "INLINE" } });
      // cancel() (or a racing issue) already moved this return out of RECEIVED/no-CN —
      // "cancel between re-read and link ⇒ no CN": mint nothing.
      if (!fresh || fresh.status !== "RECEIVED" || fresh.creditNoteId) return;

      minted = await this.creditNotes.mintStandaloneInTx(
        tx,
        {
          customerId: fresh.customerId,
          amount,
          reason: `Inline return ${fresh.returnNumber ?? fresh.id.slice(0, 8)}`,
        },
        creditNoteNumber,
        tenantId,
      );

      // N-1 guarded link: under the row lock just taken this can only ever match 0 rows if
      // `fresh` above lied — never actually reachable — so a miss throws and rolls the mint
      // back too, rather than ever leaving an orphaned CN with no return pointing at it.
      const linked = await tx.return.updateMany({
        where: { id: returnId, kind: "INLINE", status: "RECEIVED", creditNoteId: null },
        data: {
          creditNoteId: minted.id,
          status: "REFUNDED",
          refundMethod: "CREDIT_NOTE",
          refundAmount: amount,
          refundedAt: new Date(),
          holdReason: null,
          heldAmount: null,
        },
      });
      if (linked.count === 0) {
        throw new ConflictException("Return changed state during credit issue — retry");
      }

      // §2.1/§6.3: the one explicit, SYSTEM-OWNED intent on the carrying order.
      await tx.orderCreditNote.create({
        data: { orderId: fresh.orderId, creditNoteId: minted.id, amount },
      });
      await this.creditNotes.settleOrderCreditsInTx(tx, fresh.orderId, tenantId);
    });

    if (minted) {
      // Fired AFTER commit — never from inside the transaction (a later rollback must never
      // have already told the dashboard about a credit note that doesn't exist).
      this.gateway.emitCreditNoteCreated(tenantId, {
        creditNoteId: minted.id,
        creditNoteNumber: minted.creditNoteNumber,
        customerId: minted.customerId,
        amount,
      });
    }
  }

  /**
   * N-5/Q-C: approves (optionally reducing) a driver-cap hold, then issues the credit note.
   * A retried/duplicate approve matches 0 rows on the claim below and mints nothing a second
   * time — "approve retry ⇒ one CN".
   */
  async approve(id: string, user: JwtPayload, dto?: { amount?: number }): Promise<any> {
    const tenantId = this.prisma.getTenantId();
    await this.assertGranted(tenantId);

    const pre = await this.prisma.forTenant().return.findFirst({ where: { id, kind: "INLINE" } });
    if (!pre) throw new NotFoundException("Return not found");
    if (pre.status !== "RECEIVED" || pre.holdReason !== "DRIVER_CAP" || pre.creditNoteId) {
      throw new BadRequestException("Only a driver-cap hold awaiting approval can be approved");
    }
    const heldAmount = roundMoney(Number(pre.heldAmount ?? 0));
    const amount = dto?.amount != null ? roundMoney(dto.amount) : heldAmount;
    if (amount < 0 || amount > heldAmount + 0.001) {
      throw new BadRequestException("Approved amount cannot exceed the held credit");
    }

    // The claim: only one approve() call can move this row OUT of the DRIVER_CAP hold.
    const claimed = await this.prisma.forTenant().return.updateMany({
      where: {
        id,
        kind: "INLINE",
        status: "RECEIVED",
        holdReason: "DRIVER_CAP",
        creditNoteId: null,
      },
      data: { holdReason: null, heldAmount: null, approvedById: user.sub, approvedAt: new Date() },
    });
    if (claimed.count === 0) {
      return this.prisma.forTenant().return.findUnique({ where: { id }, include: { items: true } });
    }

    await this.issueCredit(id, amount);
    return this.prisma.forTenant().return.findUnique({ where: { id }, include: { items: true } });
  }

  /** Q-C: declines a driver-cap hold outright — the goods stay captured/restocked (already
   * happened at capture), but no credit note is ever minted for the held amount. */
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
      data: {
        status: "REJECTED",
        holdReason: null,
        heldAmount: null,
        approvedById: user.sub,
        approvedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Only a driver-cap hold awaiting approval can be rejected");
    }
    return this.prisma.forTenant().return.findUnique({ where: { id }, include: { items: true } });
  }

  /**
   * m-5: Return FOR UPDATE → claim CANCELLED → carrying Order FOR UPDATE → unrestock +
   * unreverse only if this return was previously captured (RECEIVED/REFUNDED — never a
   * PENDING hold, which wrote no stock at all) → pull back this CN's payments and void it →
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

      // A PENDING (never-captured — PR-1d's order-hook path) return wrote no stock at all:
      // nothing to undo. RECEIVED/REFUNDED were captured — undo restock + regulated reversal.
      if (fresh.status === "RECEIVED" || fresh.status === "REFUNDED") {
        for (const item of fresh.items as any[]) {
          if (item.restock) {
            await tx.product.update({
              where: { id: item.productId },
              data: { currentStock: { decrement: Number(item.qty) } },
            });
          }
        }
        await tx.stockMovement.deleteMany({
          where: { reference: `RET-${fresh.id.slice(0, 8)}` },
        });
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

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { recomputeInvoiceStatus } from "../invoices/invoice-status";
import { tenantTimeZone } from "../common/tenant-time-zone";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { roundMoney, sumConfirmed, remainingCapacity } from "@routeflow/pricing";
import { InvoiceStatus, PaymentMethod } from "@prisma/client";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { retryOnTxConflict, txConflictState } from "../common/tx-retry";
import { asReadableConflict, cnBad, cnConflict, type CreditNoteCode } from "./credit-note-errors";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { blockedPairs, clearApplyBlocks, pairKey, writeApplyBlocks } from "./apply-block";
import {
  lockCreditNotes,
  lockCustomerCreditsForSweep,
  lockInvoiceForCredit,
  lockOrderCreditSettle,
} from "./credit-note-locks";
import { SOURCE_DELETED_MESSAGE, hasSourceDeletedMarker } from "./sourced-credit-guard";
import {
  loadLineCredits,
  countCreditableInvoices,
  loadOrderPool,
  lockOrderPoolRows,
  pooledRefundRefusal,
  pooledTakeRefusal,
  toHeadroomLine,
  type OrderPool,
} from "./line-credit-headroom";
import {
  CREDIT_NOT_APPLICABLE,
  CREDIT_SETTLE_EXCLUDED,
  CREDIT_SOURCE_EXCLUDED,
} from "../invoices/invoice-status-sets";

@Injectable()
export class CreditNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly ledger: RegulatedLedgerService,
    private readonly commissionEngine: CommissionEngineService,
    private readonly numbering: NumberingService,
  ) {}

  private readonly logger = new Logger(CreditNotesService.name);

  /** Round a quantity to 3 decimals (matches the Decimal(12,3) columns). */
  private round3(n: number): number {
    return Math.round(n * 1000) / 1000;
  }

  /**
   * F1 (REG-B267-F/G/I), folded onto the house predicate (Opus on #2234, #2200's scope for this
   * one call site): a write conflict is whatever `txConflictState` (common/tx-retry.ts) says:
   * 40001 / 40P01 in every Prisma 7 / pg shape, P2034, or an unwrapped DriverAdapterError
   * TransactionWriteConflict. It never counts an HttpException (REG-B267-I) and never matches on
   * message text, so a 40P01 the commission sync now rethrows is retried here, not a 500.
   */
  private isSerializationFailure(err: any): boolean {
    return txConflictState(err) != null;
  }

  /**
   * REG-B267 / cause-ruling.md §2 D2: everything a credit-note create can reject
   * on — invoice existence, customer match, CREDIT_SOURCE_EXCLUDED status, the
   * cumulative invoice-total cap, and (with line items) the per-line cap and the
   * line-sum reconciliation — lives here so it can run TWICE: once on a
   * standalone (non-tx) read in `create()` BEFORE the number is reserved (so a
   * rejected request burns no number), and again on the `tx` client inside the
   * SERIALIZABLE transaction (so a genuine concurrent race is still caught —
   * cause-refutation.md §2.1 CORRECTION 1 — at the cost of burning a number for
   * that race's loser, same trade the invoice mint already takes). Returns the
   * CreditNoteItem rows to write; `[]` when there is no source invoice.
   */
  async validateAndBuildCnItems(
    db: any,
    dto: {
      customerId: string;
      invoiceId?: string;
      amount: number;
      items?: Array<{ invoiceItemId: string; amount: number; qty?: number }>;
    },
    // #2648 / SA-535b(1): the reissue's pre-reserve DRY RUN only — leaves the note about to be
    // voided out of BOTH caps, so the dry run counts exactly the headroom its void frees. create()
    // never passes it, no DTO carries it, and the in-tx re-cap after the void runs without it.
    opts: {
      excludeCreditNoteId?: string;
      ledgerReversedByReturn?: boolean;
      // B947: a return refund on an order with 2+ creditable invoices is a lump sum (no items); these are the
      // returned products it must fit, in the ORDER POOL, re-checked here under the locks (the pre-claim check is stale).
      pooledRefund?: Array<{ productId: string; qty: number }>;
    } = {},
  ): Promise<
    Array<{
      invoiceItemId: string;
      trackedCategoryId: string | null;
      amount: number;
      qty: number;
      categoryTax: number;
    }>
  > {
    if (!dto.invoiceId) return [];

    const lineItems = Array.isArray(dto.items) && dto.items.length > 0 ? dto.items : null;

    const invoice = await db.invoice.findFirst({
      where: { id: dto.invoiceId },
      select: {
        total: true,
        customerId: true,
        status: true,
        orderId: true,
        items: {
          select: {
            id: true,
            productId: true,
            subtotal: true,
            qty: true,
            boxes: true,
            unitsPerBox: true,
            pieces: true,
            product: { select: { unitsPerBox: true } },
            trackedCategoryId: true,
            categoryTaxAmount: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }], // deterministic line order for the shared headroom (SA-628)
        },
      },
    });
    if (!invoice) throw cnBad(API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE, "Invoice not found");
    if (invoice.customerId !== dto.customerId)
      throw new BadRequestException("Invoice does not belong to this customer");
    // F09/B66: a dead or forgiven invoice justifies no new credit. DRAFT is
    // allowed on purpose (returns.processRefund and the UI picker rely on it).
    if (CREDIT_SOURCE_EXCLUDED.includes(invoice.status)) {
      throw cnBad(
        API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE,
        `Cannot issue a credit note against a ${invoice.status} invoice.`,
      );
    }

    const existingCredits = await db.creditNote.aggregate({
      where: {
        invoiceId: dto.invoiceId,
        status: { not: "VOID" },
        ...(opts.excludeCreditNoteId ? { id: { not: opts.excludeCreditNoteId } } : {}),
      },
      _sum: { amount: true },
    });
    const totalExisting = Number(existingCredits._sum.amount ?? 0);
    const invoiceTotal = Number(invoice.total);
    if (totalExisting + dto.amount > invoiceTotal + 0.001) {
      throw cnBad(
        API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM,
        `Credit note amount (${dto.amount}) would exceed invoice total (${invoiceTotal}). Already credited: ${totalExisting}.`,
      );
    }

    // B947: with 2+ creditable invoices on the order, ONE pool per product across ALL of them (see loadOrderPool): the credit
    // note's own line room is still checked below; this is the second check. Locked in a tx (Order, then the invoices).
    let pool: OrderPool | null = null;
    if (
      invoice.orderId &&
      ((opts.pooledRefund?.length ?? 0) > 0 || lineItems) &&
      (await countCreditableInvoices(db, invoice.orderId)) >= 2 // a lone invoice never pays for a pool read
    ) {
      pool = await loadOrderPool(db, invoice.orderId, {
        excludeCreditNoteId: opts.excludeCreditNoteId,
      });
    }
    if (pool)
      for (const r of opts.pooledRefund ?? []) {
        const refusal = pooledRefundRefusal(pool, r.productId, r.qty);
        if (refusal)
          // `pooled`: the refund path maps ONLY this refusal (not the invoice-total cap) to its own 409 wording
          throw new BadRequestException({
            code: API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM,
            pooled: true,
            message: `Refund of ${refusal.requestedQty} would exceed what this order's invoices still allow to be credited for the product (${refusal.remainingQty} left).`,
          });
      }

    if (!lineItems) return [];

    const lineById = new Map((invoice.items ?? []).map((it: any) => [it.id, it]));
    // Merge duplicate line references so there is exactly ONE CreditNoteItem per
    // invoice line and the per-line cap sees the COMBINED amount — otherwise two
    // sub-cap items on the same line could together over-credit (and over-reverse)
    // that line.
    const mergedByLine = new Map<
      string,
      { invoiceItemId: string; amount: number; qty: number | null }
    >();
    for (const li of lineItems) {
      const amt = Number(li.amount);
      const prev = mergedByLine.get(li.invoiceItemId);
      if (prev) {
        prev.amount += amt;
        if (li.qty != null) prev.qty = (prev.qty ?? 0) + Number(li.qty);
      } else {
        mergedByLine.set(li.invoiceItemId, {
          invoiceItemId: li.invoiceItemId,
          amount: amt,
          qty: li.qty != null ? Number(li.qty) : null,
        });
      }
    }
    // Cumulative per-LINE cap: credits already booked against each of these
    // invoice lines by OTHER non-void credit notes. Repeated credits of the same
    // line across separate notes must not exceed that line's subtotal even when
    // the invoice-total cap above still has headroom — on a multi-line invoice an
    // under-credited line's slack would otherwise let another line be over-credited
    // (over-refunding AR and over-reversing the regulated ledger for that line).
    // NOTE: this cap keys on invoiceItemId, which a delivered-basis reconcile
    // ROTATES (it recreates the invoice's items under fresh ids). CreditNoteItem
    // snapshots only invoiceItemId (no orderItemId) and the pre-reconcile item is
    // deleted, so a credit issued AFTER a reconcile can't see a prior credit booked
    // under the old id — this per-line cap is BEST-EFFORT there. The authoritative
    // guards still hold: the header invoice-total cap above (keyed on the stable
    // CreditNote.invoiceId) bounds total AR, and the regulated ledger's own
    // order-line-keyed cap (RegulatedLedgerService.reverseCreditNoteEntries) floors
    // the filing at 0 — so a reconcile-rotated double-credit is a within-invoice
    // line-attribution quirk, never a net over-refund or a negative filing.
    // SA-628: the credited-so-far per line comes from the ONE shared headroom (credit-note ITEMS plus the legacy term for old
    // itemless refund notes), so a credit note and a return refund can never together exceed a line's value. Qty is credited
    // QUANTITY per line too (SA-401a, base pieces, like InvoiceItem.qty).
    // B960: with the order pool active (2+ creditable invoices) the pool is the ONE source for itemless refund lumps (it attributes
    // each across the COMBINED lines); the per-invoice legacy term would attribute the same lump to THIS invoice's lines and
    // refuse what the pool allows. The line's own credit note items and inline returns still bind per line.
    const lineCredits = await loadLineCredits(
      db,
      dto.invoiceId,
      (invoice.items ?? []).map(toHeadroomLine),
      { ...opts, skipLegacy: pool !== null },
    );
    const creditedByLine = new Map<string, number>();
    const creditedQtyByLine = new Map<string, number>();
    for (const [k, v] of lineCredits) {
      creditedByLine.set(k, v.amount);
      creditedQtyByLine.set(k, v.qty);
    }

    let sum = 0;
    const cnItemsData = [...mergedByLine.values()].map((li) => {
      const line: any = lineById.get(li.invoiceItemId);
      if (!line)
        throw cnBad(
          API_ERROR_CODES.CREDIT_NOTE_LINE_INVALID,
          `Credit line ${li.invoiceItemId} is not on invoice ${dto.invoiceId}`,
        );
      const amt = li.amount;
      // a return-refund row may carry its qty at amount 0 (a free line, or a paid line whose share of the pooled price is 0, SA-628b); nothing else may be $0
      const freeRefundRow = opts.ledgerReversedByReturn && amt === 0 && li.qty != null;
      if (!(amt > 0) && !freeRefundRow)
        throw cnBad(
          API_ERROR_CODES.CREDIT_NOTE_LINE_INVALID,
          "Credit line amount must be greater than 0",
        );
      const lineSubtotal = Number(line.subtotal);
      const priorForLine = creditedByLine.get(li.invoiceItemId) ?? 0;
      if (priorForLine + amt > lineSubtotal + 0.001)
        throw cnBad(
          priorForLine > 0
            ? API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM
            : API_ERROR_CODES.CREDIT_NOTE_LINE_INVALID,
          priorForLine > 0
            ? `Credit line amount (${amt}) plus prior credits (${roundMoney(priorForLine)}) would exceed invoice line subtotal (${lineSubtotal})`
            : `Credit line amount (${amt}) exceeds invoice line subtotal (${lineSubtotal})`,
        );
      sum += amt;
      const frac = lineSubtotal > 0 ? Math.min(1, amt / lineSubtotal) : 0;
      const lineQty = Number(line.qty);
      const priorQtyForLine = creditedQtyByLine.get(li.invoiceItemId) ?? 0;
      // #2245: an amount-only credit (no qty — the web picker) defaults to line.qty × fraction,
      // and those round3s accumulate (three 1/3 credits of 2 pieces are 0.667 × 3 = 2.001). The
      // default is clamped to what is left, and the credit that CLOSES the line's amount takes
      // exactly the rest. An explicit qty is the operator's number and stays strictly capped.
      const qtyLeft = this.round3(Math.max(0, lineQty - priorQtyForLine));
      const closesLine = priorForLine + amt >= lineSubtotal - 0.001;
      const qty =
        li.qty != null
          ? this.round3(li.qty)
          : closesLine
            ? qtyLeft
            : Math.min(this.round3(lineQty * frac), qtyLeft);
      if (priorQtyForLine + qty > lineQty + 0.001)
        throw cnBad(
          priorQtyForLine > 0
            ? API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM
            : API_ERROR_CODES.CREDIT_NOTE_LINE_INVALID,
          priorQtyForLine > 0
            ? `Credit line qty (${qty}) plus prior credited qty (${this.round3(priorQtyForLine)}) would exceed invoice line qty (${lineQty})`
            : `Credit line qty (${qty}) exceeds invoice line qty (${lineQty})`,
        );
      return {
        invoiceItemId: line.id,
        // Snapshot the category as it was AT SALE (the invoice line), NEVER the
        // live product — a product's category may have drifted, and only a line
        // that actually sold regulated has a matching SALE row to reverse.
        // SA-628: a RETURN REFUND note is itemised only so the shared per-line headroom counts it; receive() already reversed
        // the returned regulated goods, so its rows carry NO category and NO tax (a second reversal would double-file them).
        trackedCategoryId: opts.ledgerReversedByReturn ? null : (line.trackedCategoryId ?? null),
        amount: roundMoney(amt),
        qty,
        categoryTax: opts.ledgerReversedByReturn
          ? 0
          : roundMoney(Number(line.categoryTaxAmount ?? 0) * frac),
      };
    });
    if (pool) {
      // Every row's qty binds, derived or typed (in PIECES). With the pool as the only source for refund lumps, an amount-only
      // credit's derived qty is what keeps the PRODUCT's pieces (and the regulated reversal that follows them) from being credited
      // past what was billed when lines of the product carry different prices (B960 review).
      const byProduct = new Map<string, { amount: number; qty: number }>();
      for (const row of cnItemsData) {
        const productId = (lineById.get(row.invoiceItemId) as any)?.productId;
        if (!productId) continue;
        const prev = byProduct.get(productId) ?? { amount: 0, qty: 0 };
        // the pool's qty is in PIECES (lines can use different units): the row's qty is on its line's own axis
        const pieces =
          row.qty * (pool.lines.find((l) => l.id === row.invoiceItemId)?.piecesPerQty ?? 1);
        byProduct.set(productId, { amount: prev.amount + row.amount, qty: prev.qty + pieces });
      }
      for (const [productId, take] of byProduct) {
        const refusal = pooledTakeRefusal(pool, productId, { amount: take.amount, qty: take.qty });
        if (refusal)
          throw cnBad(
            API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM,
            `Credit of ${refusal.requestedAmount} would exceed what this order's invoices still allow to be credited for the product (${refusal.remainingAmount} left, counting refunds already minted on other invoices).`,
          );
      }
    }
    if (Math.abs(sum - dto.amount) > 0.01)
      throw cnBad(
        API_ERROR_CODES.CREDIT_NOTE_LINE_INVALID,
        `Credit line amounts (${roundMoney(sum)}) must sum to the credit note amount (${dto.amount})`,
      );
    return cnItemsData;
  }

  /**
   * Returns Inside Order Creation — PR-1c (m-1): mints a STANDALONE (`invoiceId: null`)
   * credit note INSIDE the caller's own already-open transaction — never opens one of its
   * own. Built for `InlineReturnsService`'s issue step (design.md §6.5.3: unlocked pre-read
   * → `reserveNext("CREDIT_NOTE")` standalone → `tx`: Return FOR UPDATE → guard →
   * `mintStandaloneInTx` → guarded link → intent → settle; ONE commit), so the number is
   * reserved by the CALLER before opening `tx` (same hoisting `create()` uses, and for the
   * same reason — a SERIALIZABLE counter UPDATE aborts rather than queues) and handed in
   * here already-reserved.
   *
   * Keeps `create()`'s two money-safety checks verbatim: the null-tenant refusal (a
   * SUPER_ADMIN context must never mint a tenant-owned credit) and the tenant-scoped
   * customer lookup (a foreign-tenant customerId 404s instead of minting against it). Skips
   * `create()`'s invoice/line validation entirely — a standalone mint has no `invoiceId` — and
   * its own serialization-retry wrapper, since the caller's transaction (already holding the
   * Return row lock) is what serializes concurrent issues for this return, not this method.
   * `gateway.emitCreditNoteCreated` is deliberately NOT fired here — the caller emits it
   * itself, once, AFTER its own transaction commits (never inside — an emit from inside a
   * transaction that later rolls back would light up the operator dashboard for a credit
   * note that was never actually minted).
   */
  async mintStandaloneInTx(
    tx: any,
    dto: { customerId: string; amount: number; reason?: string; expiresAt?: Date | null },
    creditNoteNumber: string,
    tenantId: string | null,
  ): Promise<any> {
    // REG-B267 / cause-ruling.md §2 D2 parity: refused before any write, same as create().
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    if (!dto.amount || dto.amount <= 0)
      throw new BadRequestException("Amount must be greater than 0");

    const customer = await tx.customer.findFirst({
      where: { id: dto.customerId },
      select: { id: true, businessName: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    const row = await tx.creditNote.create({
      data: {
        creditNoteNumber,
        customerId: dto.customerId,
        invoiceId: null,
        amount: roundMoney(dto.amount),
        reason: dto.reason,
        status: "ISSUED",
        expiresAt: dto.expiresAt ?? null,
      },
    });
    return { ...row, customer };
  }

  /**
   * §6.3: an INLINE return's credit is "met" against its OWN carrying order once that
   * order has no open balance left on its non-VOID invoices (every dollar owed was covered
   * some other way — cash, an earlier credit — so this return's credit is no longer needed
   * there), or the order is CANCELLED (nothing is owed on it at all any more). Read on
   * whatever client the caller passes (a bare tx has no `forTenant()` — every query here is
   * already orderId-scoped, so no cross-tenant leak is possible either way).
   */
  private async isOrderMetInTx(tx: any, orderId: string): Promise<boolean> {
    const order = await tx.order.findFirst({ where: { id: orderId }, select: { status: true } });
    if (!order) return true; // no such order — nothing left for the credit to wait on
    if (order.status === "CANCELLED") return true;
    const invoices = await tx.invoice.findMany({
      where: { orderId, status: { not: "VOID" } },
      include: { payments: true },
    });
    // Opus review (PR-1c BLOCK, MED-6): the pre-fix fallthrough (`return true` after a
    // no-op loop) treated "not invoiced yet" as "met" — exactly the common case at order-
    // entry time, when an inline return is captured before the carrying order has any
    // invoice at all. That made the §6.3 exclusion a no-op for every fresh capture: the
    // credit was immediately available to the general oldest-first sweep on some OTHER
    // invoice, before its own carrying order ever got a chance to consume it. Not met until
    // there is at least one non-VOID invoice AND every one of them is fully paid.
    if (invoices.length === 0) return false;
    // PR-2 review (payment-status-filter scan): this is a CONFIRMATION question —
    // "is this invoice actually paid off" — so paid must be the CONFIRMED-basis
    // sum (sumConfirmed), never a bare not-VOID filter. A DRAFT bank-import row
    // or a PENDING post-dated check must not count: crediting this return's
    // credit back to the general sweep before the money has actually cleared
    // would let it get consumed on some OTHER invoice while this order still
    // owes on paper.
    for (const inv of invoices) {
      const paid = roundMoney(sumConfirmed(inv.payments));
      if (roundMoney(Number(inv.total) - paid) > 0.001) return false;
    }
    return true; // every non-VOID invoice is fully paid (CONFIRMED basis)
  }

  /**
   * §6.3: true when `creditNoteId` is the ONE standalone credit note an INLINE return
   * minted for ITS OWN carrying order `orderId` — the "system-owned intent" design.md §2.1
   * describes, as opposed to an ordinary staff-selected wallet credit. Both
   * `autoApplyOldestCreditsInTx` (exclude while unmet) and `syncOrderCreditSelections`
   * (never drop/re-amount) key off this same join — no new column, no migration.
   */
  private async isSystemOwnedInlineCreditInTx(
    tx: any,
    orderId: string,
    creditNoteId: string,
  ): Promise<boolean> {
    const ret = await tx.return.findFirst({
      where: { orderId, creditNoteId, kind: "INLINE" },
      select: { id: true },
    });
    return !!ret;
  }

  /**
   * #2648: the credit-note row + its CreditNoteItems + the regulated-ledger reversal, exactly as
   * `create()` has always written them, shared with the reissue so there is ONE mint body.
   */
  async insertCreditNoteInTx(
    tx: any,
    data: {
      creditNoteNumber: string;
      customerId: string;
      invoiceId?: string | null;
      amount: number;
      reason?: string | null;
      expiresAt: Date | null;
      autoApplyExcluded?: boolean; // SA-608: the reissue carries the old note's exclusion over
    },
    cnItemsData: any[],
    tenantId: string | null,
    customer: unknown,
  ) {
    const row = await tx.creditNote.create({
      data: {
        creditNoteNumber: data.creditNoteNumber,
        customerId: data.customerId,
        invoiceId: data.invoiceId,
        amount: roundMoney(data.amount),
        reason: data.reason,
        status: "ISSUED",
        expiresAt: data.expiresAt,
        ...(data.autoApplyExcluded ? { autoApplyExcluded: true } : {}),
      },
    });
    const created = { ...row, customer };

    // SA-311 (#2181): EVERY validated line persists its CreditNoteItem, ordinary
    // and regulated: the line link feeds sales-facts attribution and the
    // cumulative per-line cap above (priorForLine), which never accumulated for
    // ordinary lines when only regulated items were written. Only regulated lines
    // drive a ledger reversal: reverseCreditNoteEntries reads items with
    // trackedCategoryId not null, so gating the call here keeps it byte-identical.
    if (cnItemsData.length > 0 && tenantId) {
      await tx.creditNoteItem.createMany({
        data: cnItemsData.map((i) => ({ ...i, creditNoteId: created.id, tenantId })),
      });
      if (cnItemsData.some((i) => i.trackedCategoryId)) {
        await this.ledger.reverseCreditNoteEntries({ creditNoteId: created.id, db: tx });
      }
    }
    return created;
  }

  async create(
    dto: {
      customerId: string;
      invoiceId?: string;
      amount: number;
      reason?: string;
      // Optional line linkage: which invoice lines this credit applies to. REQUIRED for
      // any regulated-ledger reversal — a lump-sum credit with no linkage reverses
      // NOTHING in the regulated ledger (returned regulated goods go through the returns
      // path, which attributes by product). This is what prevents a credit that concerned
      // non-regulated goods from proportionally reversing regulated excise sales.
      items?: Array<{ invoiceItemId: string; amount: number; qty?: number }>;
      /** P5-13: optional ISO date after which this credit is excluded from the wallet and can never apply. */
      expiresAt?: string;
    },
    internal: {
      ledgerReversedByReturn?: boolean;
      pooledRefund?: Array<{ productId: string; qty: number }>;
      /** B947: the Return this lump-sum refund belongs to; linked to the note inside the mint transaction. */
      returnId?: string;
    } = {},
  ) {
    if (!dto.amount || dto.amount <= 0)
      throw new BadRequestException("Amount must be greater than 0");

    // P5-13: optional expiry. Reject garbage and already-past dates at intake.
    let expiresAt: Date | null = null;
    if (dto.expiresAt != null && dto.expiresAt !== "") {
      expiresAt = new Date(dto.expiresAt);
      if (isNaN(expiresAt.getTime()))
        throw new BadRequestException("expiresAt must be a valid ISO date");
      if (expiresAt.getTime() <= Date.now())
        throw new BadRequestException("expiresAt must be in the future");
    }

    const lineItems = Array.isArray(dto.items) && dto.items.length > 0 ? dto.items : null;
    if (lineItems && !dto.invoiceId)
      throw new BadRequestException("Credit line items require a source invoice");

    const tenantId = this.prisma.getTenantId();
    // REG-B267 / cause-ruling.md §2 D2: a null request tenant (the SUPER_ADMIN
    // path) is refused HERE, before anything reads. `forTenant()` returns the
    // UNSCOPED client when the ambient tenant is null (prisma.service.ts), so
    // validating first would do cross-tenant reads and hand the caller another
    // tenant's invoice figures in a 400 body before the reservation's own tenant
    // check fired.
    if (!tenantId) throw new BadRequestException("A tenant context is required.");

    // REG-B267-E: the customer summary the response carries is read HERE, ahead
    // of the reservation, through the tenant-scoped `findFirst` — `findFirst` is
    // in SCOPED_METHODS so `tenantId` is injected into `where`, whereas
    // `findUnique`'s post-filter only fires when the projection selects
    // `tenantId`. A customerId owned by another tenant is therefore a 404 that
    // burns no number, instead of a credit note bound to a foreign customer.
    const customer = await this.prisma.forTenant().customer.findFirst({
      where: { id: dto.customerId },
      select: { id: true, businessName: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    // REG-B267 / cause-ruling.md §2 D2: validate BEFORE reserving a number — a
    // standalone (non-tx) read of everything this create can be rejected for, so
    // a rejected request burns none of the tenant's CREDIT_NOTE series. Runs on
    // `forTenant()`, never `tx` — nothing is open yet.
    await this.validateAndBuildCnItems(this.prisma.forTenant(), dto, internal);

    // Hoisted ABOVE the SERIALIZABLE tx below (never `{ tx }`): under
    // SERIALIZABLE a blocked counter UPDATE ABORTS (P2034) rather than waiting,
    // so reserving inside the tx would fail concurrent creates instead of
    // queueing them (cause-refutation.md §2.1 CORRECTION 1). A validation
    // failure above burns nothing; a genuine race caught by the re-validation
    // below still burns a number, same trade the invoice mint already takes.
    const year = new Date().getFullYear();
    const creditNoteNumber = await this.numbering.reserveNext("CREDIT_NOTE", {
      year,
      tenantId,
    });

    let cn: any;
    // F1 (REG-B267-F/G, cause-ruling.md §2 D2 follow-up): the SERIALIZABLE tx
    // re-reads CreditNote (validateAndBuildCnItems's aggregate) then inserts
    // into it, a textbook rw-antidependency — PostgreSQL SSI cancels one
    // concurrent racer with 40001/P2034. `tenantTransaction` is a bare
    // `$transaction` with no retry (prisma.service.ts:48-63), so that used to
    // surface as a raw 500 AFTER the standalone reservation above had already
    // committed `creditNoteNumber` — burning it either way. Bounded retry, same
    // house shape as REG-B108 (orders.service.ts ~:2705-2726): up to 3
    // attempts, 25/50/100ms backoff, the SAME reserved number reused on every
    // attempt (never re-reserve — that would burn a second number per retry).
    // Exhausting retries throws 409, never lets the raw P2034 escape as a 500.
    const MAX_CN_TX_ATTEMPTS = 3;
    const CN_TX_BACKOFF_MS = [25, 50, 100];
    let serializationErr: any;
    for (let attempt = 0; attempt < MAX_CN_TX_ATTEMPTS; attempt++) {
      try {
        // Everything — the cumulative-credit cap, the per-line breakdown and the
        // ledger reversal — runs inside ONE serializable transaction so concurrent
        // credit notes against the same invoice can't both pass a stale cap and
        // over-credit / over-reverse the regulated ledger. Re-validates on a fresh
        // `tx` read (the pre-check above ran on a separate, non-tx snapshot).
        cn = await this.prisma.tenantTransaction(
          async (tx: any) => {
            // SA-628 / SA-214 lock order: the INVOICE row first, tenant-scoped. The lock alone serialises the two
            // writers' transactions; it is the Serializable retry that makes the second one SEE the first's credit
            // (a stale snapshot aborts 40001 and re-reads the shared per-line headroom).
            // B947: with 2+ creditable invoices on the order, the Order and ALL of them are locked FIRST (Order -> Invoice,
            // id-sorted), so a refund on Y and a credit note on X serialise and no writer takes an Invoice then the Order.
            if (dto.invoiceId) await lockOrderPoolRows(tx, dto.invoiceId, tenantId);
            if (dto.invoiceId) {
              await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${dto.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
            }
            const cnItemsData = await this.validateAndBuildCnItems(tx, dto, internal);

            // REG-B267-E: the customer summary the response carries comes from the
            // tenant-scoped pre-read above rather than from `create({ include })`.
            // Prisma's include makes the create RE-READ the CreditNote row it just
            // wrote, and under SERIALIZABLE that read is an rw-dependency against
            // every concurrent create's insert into the same table — PostgreSQL then
            // cancels racers as SSI pivots ("could not serialize access ... during
            // read"), so five parallel creates lost two even with the number already
            // reserved outside this tx. Customer is never written on this path, so
            // the value read before the tx is still the right one. Same shape out.
            const created = await this.insertCreditNoteInTx(
              tx,
              {
                creditNoteNumber,
                customerId: dto.customerId,
                invoiceId: dto.invoiceId,
                amount: dto.amount,
                reason: dto.reason,
                expiresAt,
              },
              cnItemsData,
              tenantId,
              customer,
            );
            // B947: a lump-sum refund is attributed to its product only THROUGH its Return's link, so the link is written in
            // the SAME transaction as the note: a credit note item that reads the pool after the commit can never see the
            // lump with no return (and a crash between the mint and a later link cannot leave it uncounted).
            if (internal.returnId)
              await tx.return.updateMany({
                where: { id: internal.returnId, creditNoteId: null },
                data: { creditNoteId: created.id },
              });
            return created;
          },
          { isolationLevel: "Serializable" },
        );
        serializationErr = undefined;
        break;
      } catch (err: any) {
        if (err?.code === "P2002") {
          // The try above spans five statements, so a P2002 here is only a NUMBER
          // conflict when the violated constraint actually names creditNoteNumber.
          // Anything else (a future unique on CreditNoteItem or the ledger) must
          // propagate untouched rather than reach the operator as a retry advice
          // that cannot help — and either way the real constraint gets logged.
          const target = Array.isArray(err?.meta?.target)
            ? err.meta.target.join(",")
            : String(err?.meta?.target ?? "");
          this.logger.warn(
            `Credit note create failed [${creditNoteNumber}] customer=${dto.customerId} invoice=${dto.invoiceId ?? "-"} code=P2002 target=${target}`,
          );
          if (target === "" || target.includes("creditNoteNumber"))
            throw new ConflictException("Credit note number conflict — please retry.");
          throw err;
        }
        if (this.isSerializationFailure(err)) {
          serializationErr = err;
          if (attempt < MAX_CN_TX_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, CN_TX_BACKOFF_MS[attempt]));
            continue;
          }
          break;
        }
        throw err;
      }
    }
    if (serializationErr) {
      this.logger.error(
        `Credit note create exhausted ${MAX_CN_TX_ATTEMPTS} attempts on serialization conflict ` +
          `[${creditNoteNumber}] customer=${dto.customerId} invoice=${dto.invoiceId ?? "-"}: ${serializationErr?.message ?? serializationErr}`,
      );
      throw new ConflictException("Concurrent credit note for this invoice, please retry");
    }

    this.gateway.emitCreditNoteCreated(this.prisma.getTenantId(), {
      creditNoteId: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      customerId: cn.customerId,
      amount: Number(cn.amount),
    });

    return cn;
  }

  async findAll(
    customerId?: string,
    status?: string,
    search?: string,
    dateFrom?: string,
    dateTo?: string,
    page = 1,
    limit = 20,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (customerId) where.customerId = customerId;
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo + "T23:59:59.999Z");
    }
    if (search) {
      where.OR = [
        { creditNoteNumber: { contains: search, mode: "insensitive" } },
        { customer: { businessName: { contains: search, mode: "insensitive" } } },
        { reason: { contains: search, mode: "insensitive" } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.forTenant().creditNote.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          invoice: { select: { id: true, invoiceNumber: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.forTenant().creditNote.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findAllForUser(
    user: JwtPayload,
    customerId?: string,
    status?: string,
    search?: string,
    dateFrom?: string,
    dateTo?: string,
    page = 1,
    limit = 20,
  ) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      return this.findAll(customer.id, status, search, dateFrom, dateTo, page, limit);
    }
    if (user.role === "DRIVER") {
      // Drivers have no business reading credit notes
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }
    return this.findAll(customerId, status, search, dateFrom, dateTo, page, limit);
  }

  async findOne(id: string) {
    const cn = await this.prisma.forTenant().creditNote.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, businessName: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
        // #2648: the line split, so the Edit form can prefill a line-linked reissue.
        items: { select: { invoiceItemId: true, amount: true, qty: true } },
      },
    });
    if (!cn) throw new NotFoundException("Credit note not found");
    return cn;
  }

  async findOneForUser(id: string, user: JwtPayload) {
    // F10-003: mirror findAllForUser's DRIVER denial — drivers have no business
    // reading credit notes, and the single-item read must not fall through to a
    // full credit note the way it did before this guard.
    if (user.role === "DRIVER") throw new ForbiddenException();
    const cn = await this.findOne(id);
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || cn.customerId !== customer.id) throw new ForbiddenException();
    }
    return cn;
  }

  /**
   * P5-13: the single tx-safe primitive that applies (part of) a credit note to an
   * invoice. Runs INSIDE an already-open tenant transaction `tx` — never opens its
   * own. Every monetary figure via roundMoney. Returns {applied:0} instead of
   * throwing so the auto-apply loop can skip; the manual path throws on 0 itself.
   * Callers pre-filter VOID + expired credits (expiry is a computed filter).
   *
   * B1052: `cn` MUST have been read AFTER the caller locked the note's row (credit-note-locks.ts:
   * settle, sweep and manual apply all lock before they read). The balance below comes from `cn`;
   * an unlocked read let two transactions spend the same dollars.
   */
  private async applyCreditInTx(
    tx: any,
    tz: string | null, // SA-495a: the caller's tenant zone, resolved once — never per row
    cn: {
      id: string;
      creditNoteNumber: string;
      amount: unknown;
      amountUsed: unknown;
      appliedToInvoiceId: string | null;
      appliedAt?: Date | null;
      autoApplied?: boolean;
    },
    inv: {
      id: string;
      total: unknown;
      dueDate: Date | null;
      status: InvoiceStatus;
      payments?: Array<{ amount: unknown; status?: string }>;
    },
    requestedAmount?: number,
    opts?: { autoApplied?: boolean; tenantId?: string | null },
  ): Promise<{ applied: number; invoiceStatus: InvoiceStatus | null }> {
    // F09/B67: the write is gated here, not at the callers' queries — settle,
    // auto-apply and any future caller all pass through this line. Exclude-list
    // on purpose: a fixture without `status` still applies.
    if (CREDIT_SETTLE_EXCLUDED.includes(inv.status as InvoiceStatus)) {
      return { applied: 0, invoiceStatus: null };
    }
    const remaining = roundMoney(Number(cn.amount) - Number(cn.amountUsed));
    // P5-12: a bounced check flips its InvoicePayment to VOID — must NOT count as
    // paid, so the credit can correctly cover the re-opened balance.
    // PR-2 (check-payments B1 hardening, N4): shared remainingCapacity() replaces
    // the hand-rolled `status !== "VOID"` filter — same DRAFT+PAID(+PENDING once
    // it exists) basis, zero behavior change today (N4: capacity must keep
    // counting DRAFT, never narrow to isHeldPayment/HELD_STATUSES here).
    const invoiceBalance = remainingCapacity(Number(inv.total), inv.payments);
    const applyAmount = roundMoney(
      Math.min(remaining, invoiceBalance, requestedAmount ?? Infinity),
    );
    // `!(x > 0.001)` (not `x <= 0.001`) so NaN from malformed data also bails out.
    if (!(applyAmount > 0.001)) return { applied: 0, invoiceStatus: null };

    // The credit consumes invoice balance as a payment — the ONLY place a credit
    // reduces an invoice, and amountUsed below removes the same dollars from the
    // wallet (Σ amount − amountUsed). One or the other, never both.
    // Set tenantId explicitly (mirroring the invoice.create defense): the settle
    // path can run on an UNWRAPPED tx — the fire-and-forget invoice creation loses
    // AsyncLocalStorage context, so the tenant proxy wouldn't inject it — and a
    // tenant-orphaned (tenantId=null) payment is excluded from every tenant-scoped
    // read. On a wrapped tx the proxy overrides this with the same value; harmless.
    const effectiveTenantId = opts?.tenantId ?? this.prisma.getTenantId();
    await tx.invoicePayment.create({
      data: {
        invoiceId: inv.id,
        amount: applyAmount,
        method: PaymentMethod.CREDIT_NOTE,
        creditNoteId: cn.id,
        reference: cn.creditNoteNumber,
        autoApplied: !!opts?.autoApplied, // SA-436: the sweep's payments; every other writer is manual
        ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
      },
    });

    // PR-2 review (routeflow-Lead, 2026-09-16): the status recompute must stay
    // CONFIRMED-basis (sumConfirmed), never `total - invoiceBalance` — that capacity
    // figure is DRAFT-inclusive (remainingCapacity), so a 40-dollar credit applied
    // on top of a 60-dollar DRAFT sibling was flipping a $100 invoice straight to
    // PAID off unconfirmed money. Matches restoreCreditFromPaymentInTx's own basis.
    const newPaid = roundMoney(sumConfirmed(inv.payments) + applyAmount);
    const newStatus = recomputeInvoiceStatus(
      newPaid,
      Number(inv.total),
      inv.dueDate,
      inv.status,
      tz,
    );
    await tx.invoice.update({
      where: { id: inv.id },
      data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
    });

    // B1052: `cn` was read under its row lock (see the doc above), so this absolute value can't
    // overwrite another writer's spend.
    const newAmountUsed = roundMoney(Number(cn.amountUsed) + applyAmount);
    const fullyApplied = newAmountUsed >= Number(cn.amount) - 0.001;
    await tx.creditNote.update({
      where: { id: cn.id },
      data: {
        amountUsed: newAmountUsed,
        status: fullyApplied ? "APPLIED" : "ISSUED",
        appliedToInvoiceId: fullyApplied ? inv.id : cn.appliedToInvoiceId,
        appliedAt: cn.appliedAt ?? new Date(),
        autoApplied: opts?.autoApplied ? true : (cn.autoApplied ?? false),
      },
    });

    // Sales agents & commissions: a credit application shrinks the base and
    // is excluded from cash — both sides of the money math move.
    await this.commissionEngine.syncInvoiceCommissionSafe(inv.id, tx);

    return { applied: applyAmount, invoiceStatus: newStatus };
  }

  /**
   * P5-13: auto-apply the customer's OPEN, non-expired credits — OLDEST createdAt
   * first — to one invoice, inside the caller's transaction (InvoicesService wraps
   * this with its SENT flip). Idempotent: a re-send finds the balance covered or
   * credits exhausted and applies nothing.
   * Canonical open predicate: status != VOID && (amount − amountUsed) > 0.001 &&
   * (expiresAt == null || expiresAt > now). Prisma can't compare two columns, so
   * the remaining>0 half is evaluated in JS; status/expiry go into the query.
   */
  async autoApplyOldestCreditsInTx(
    tx: any,
    invoiceId: string,
    customerId: string,
    opts?: { excludeCreditNoteIds?: string[] },
  ): Promise<{ applied: number; invoiceStatus: InvoiceStatus | null }> {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: once per call, before any loop
    const nothing: { applied: number; invoiceStatus: InvoiceStatus | null } = {
      applied: 0,
      invoiceStatus: null,
    };
    if (!invoiceId || !customerId) return nothing;
    // SA-436 (#2401): the tenant's send-time sweep switch, OFF by default (owner ruling). No config
    // row reads as OFF. Read inside the caller's send tx; the order's own intents settle regardless.
    const tenantId = this.prisma.getTenantId();
    const cfg = tenantId
      ? await tx.tenantConfig.findUnique({
          where: { tenantId },
          select: { creditAutoApplyOnSend: true },
        })
      : null;
    if (!cfg?.creditAutoApplyOnSend) return nothing;
    // B1052: lock the invoice and the customer's live notes BEFORE reading any balance.
    await lockCustomerCreditsForSweep(tx, invoiceId, customerId);

    const first = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true },
    });
    if (!first) return nothing;
    // PR-2 (check-payments B1 hardening, N4): shared remainingCapacity() — see
    // applyCreditInTx's identical note above.
    let running = remainingCapacity(Number(first.total), first.payments);
    if (!(running > 0.001)) return nothing;

    const now = new Date();
    const candidates = await tx.creditNote.findMany({
      where: {
        customerId,
        status: { not: "VOID" },
        autoApplyExcluded: false, // SA-436: an operator kept this note out of the sweep
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        ...(opts?.excludeCreditNoteIds?.length ? { id: { notIn: opts.excludeCreditNoteIds } } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    // SA-436: a pair an operator removed (unapply / untick / void-reversal) is never re-applied.
    const blocked = await blockedPairs(tx, [invoiceId]);
    const openWithBalance = (candidates ?? []).filter(
      (c: any) =>
        roundMoney(Number(c.amount) - Number(c.amountUsed)) > 0.001 &&
        !blocked.has(pairKey(c.id, invoiceId)),
    );
    // §6.3: an INLINE return's own credit note is reserved for ITS OWN carrying order
    // until that order is "met" — skip it here so this general oldest-first sweep (any
    // invoice for this customer) never sweeps it onto an UNRELATED invoice first. Once its
    // carrying order is met, the remainder is ordinary wallet credit and this filter passes
    // it through like any other note. A non-inline (ordinary) credit is never filtered.
    const open: any[] = [];
    for (const cn of openWithBalance) {
      const ret = await tx.return.findFirst({
        where: { creditNoteId: cn.id, kind: "INLINE" },
        select: { orderId: true },
      });
      if (ret && !(await this.isOrderMetInTx(tx, ret.orderId))) continue;
      open.push(cn);
    }
    if (open.length === 0) return nothing;

    let totalApplied = 0;
    let invoiceStatus: InvoiceStatus | null = null;
    let inv = first;
    for (const cn of open) {
      if (!(running > 0.001)) break;
      // `running` as the requested amount = a hard clamp; over-applying is
      // impossible even if the invoice re-read were stale.
      const res = await this.applyCreditInTx(tx, tz, cn, inv, running, { autoApplied: true });
      if (res.applied <= 0) break;
      running = roundMoney(running - res.applied);
      totalApplied = roundMoney(totalApplied + res.applied);
      invoiceStatus = res.invoiceStatus;
      const next = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { payments: true },
      });
      if (next) inv = next;
    }
    return { applied: totalApplied, invoiceStatus };
  }

  async applyToInvoice(creditNoteId: string, invoiceId: string, amount?: number) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: once per call, before any loop
    // SA-392 (#2201): the WHOLE Serializable tx re-runs on a 40001/40P01 conflict (bounded); the
    // body is DB-only and idempotent, and the in-tx commission sync now rethrows a conflict.
    return retryOnTxConflict(`credit apply cn=${creditNoteId} inv=${invoiceId}`, () =>
      this.prisma.tenantTransaction(
        async (tx) => {
          // B1052: the invoice (with its Order), then the note, BEFORE reading the balance.
          await lockInvoiceForCredit(tx, invoiceId);
          await lockCreditNotes(tx, [creditNoteId]);
          const cn = await tx.creditNote.findUnique({ where: { id: creditNoteId } });
          if (!cn || cn.status === "APPLIED" || cn.status === "VOID")
            throw new BadRequestException("Credit note is not available for application");
          if (cn.expiresAt && new Date(cn.expiresAt) <= new Date())
            throw new BadRequestException("Credit note has expired");

          const inv = await tx.invoice.findUnique({
            where: { id: invoiceId },
            include: { payments: true },
          });
          if (!inv) throw new NotFoundException("Invoice not found");

          if (CREDIT_NOT_APPLICABLE.includes(inv.status)) {
            throw new BadRequestException(
              `Cannot apply credit note to invoice with status ${inv.status}`,
            );
          }
          if (cn.customerId !== inv.customerId) {
            throw new BadRequestException("Credit note and invoice belong to different customers");
          }

          const { applied } = await this.applyCreditInTx(tx, tz, cn, inv, amount);
          if (applied <= 0)
            throw new BadRequestException(
              "Credit note has no remaining balance or invoice is fully paid",
            );
          // SA-436: explicit human intent wins, so a manual apply lifts this pair's block.
          await clearApplyBlocks(tx, creditNoteId, [invoiceId]);

          return tx.invoice.findUnique({
            where: { id: invoiceId },
            include: {
              customer: { select: { id: true, businessName: true } },
              items: true,
              payments: { orderBy: { createdAt: "desc" } },
            },
          });
        },
        { isolationLevel: "Serializable" },
      ),
    );
  }

  /**
   * Returns Inside Order Creation — PR-1c (m-5): cancels ONE standalone credit note an
   * inline return minted, inside the CALLER's own transaction (`InlineReturnsService.
   * cancel()`, which already holds the Return + carrying-Order locks) — never opens one of
   * its own. Scoped to exactly this `creditNoteId`: unlike `releaseOrderCreditsInTx` (which
   * sweeps EVERY credit note applied to an order), this never touches a different credit
   * note that happens to sit on the same order/invoice (a manual credit, or a sibling
   * inline return's own CN).
   *
   * Pulls back every non-VOID `CREDIT_NOTE` payment this note made (mirrors the void's
   * "un-apply first" rule, but un-applies here instead of refusing), then voids it and undoes
   * its regulated-ledger reversal. Throws `RETURN_CREDIT_CONSUMED` if `amountUsed` is still
   * non-zero after restoring everything a payment row could account for — money consumed
   * through some path this couldn't find and restore, which must block the cancel rather than
   * silently void a note that's still "used" on paper (m-5's "restore < amountUsed" case).
   */
  async cancelStandaloneInTx(tx: any, creditNoteId: string): Promise<{ restored: number }> {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: once per call, before any loop
    // scan-ok: draft-payment-not-void — a CREDIT_NOTE-method InvoicePayment is an
    // internal ledger write this service itself creates atomically as CONFIRMED;
    // it is never written as DRAFT/PENDING like an imported bank row or a
    // post-dated check, so not-VOID is the correct (and only reachable) filter here.
    const payments = await tx.invoicePayment.findMany({
      where: { creditNoteId, method: PaymentMethod.CREDIT_NOTE, status: { not: "VOID" } },
      orderBy: { createdAt: "desc" },
    });
    let restored = 0;
    for (const p of payments) {
      restored = roundMoney(
        restored +
          (await this.restoreCreditFromPaymentInTx(tx, tz, p, undefined, {
            voidingNoteId: creditNoteId,
          })),
      );
    }

    const cn = await tx.creditNote.findFirst({
      where: { id: creditNoteId },
      select: { status: true, amountUsed: true },
    });
    if (!cn) return { restored };
    if (cn.status === "VOID") return { restored };
    if (Number(cn.amountUsed) > 0.001) {
      throw new BadRequestException("RETURN_CREDIT_CONSUMED");
    }

    const flipped = await tx.creditNote.updateMany({
      where: { id: creditNoteId, status: { not: "VOID" } },
      data: { status: "VOID" },
    });
    if (flipped.count > 0) {
      await this.ledger.unreverseCreditNoteEntries({ creditNoteId, db: tx });
    }
    return { restored };
  }

  /**
   * SA-436 PR-2 (#2402): the refusal (400 text) for voiding this note with its applications
   * reversed, or null when it may proceed. Shared by the preview and the void so both say the same.
   * - already VOID;
   * - backs a live return (not CANCELLED/REJECTED): the customer's return credit is not the
   *   operator's to take back here — cancel the return instead (cancelStandaloneInTx's rule);
   * - amountUsed exceeds what its non-VOID CREDIT_NOTE payments account for: money consumed
   *   through a path this cannot find and restore (RETURN_CREDIT_CONSUMED).
   */
  async voidWithReversalRefusal(
    db: any,
    cn: { id: string; status: string; amountUsed: unknown },
    payments: Array<{ amount: unknown }>,
  ): Promise<{ code: CreditNoteCode; message: string } | null> {
    if (cn.status === "VOID")
      return {
        code: API_ERROR_CODES.CREDIT_NOTE_VOID_NOT_EDITABLE,
        message: "This credit note is already void.",
      };
    const ret = await db.return.findFirst({
      where: { creditNoteId: cn.id, status: { notIn: ["CANCELLED", "REJECTED"] } },
      select: { returnNumber: true },
    });
    if (ret) {
      return {
        code: API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED,
        message: `This credit note backs a return${ret.returnNumber ? ` (${ret.returnNumber})` : ""}. Cancel the return instead of voiding its credit.`,
      };
    }
    const onInvoices = roundMoney(payments.reduce((s, p) => s + Number(p.amount), 0));
    if (roundMoney(Number(cn.amountUsed) - onInvoices) > 0.001) {
      return {
        code: API_ERROR_CODES.CREDIT_NOTE_CREDIT_CONSUMED,
        message:
          "Part of this credit was used somewhere it cannot be reversed from here (RETURN_CREDIT_CONSUMED). Nothing was changed.",
      };
    }
    return null;
  }

  /** The preview's refusal as `{ refusal, refusalCode }`: the text is for logs, the code for the UI. */
  private async previewRefusal(
    db: any,
    cn: { id: string; status: string; amountUsed: unknown },
    payments: Array<{ amount: unknown }>,
  ) {
    const r = await this.voidWithReversalRefusal(db, cn, payments);
    return { refusal: r?.message ?? null, refusalCode: r?.code ?? null };
  }

  /** The note's live CREDIT_NOTE applications (the rows a reversal restores), with their invoice. */
  liveCreditPayments(db: any, creditNoteId: string) {
    // A CREDIT_NOTE-method payment is only ever written CONFIRMED by applyCreditInTx, so not-VOID
    // is the complete filter here (see cancelStandaloneInTx).
    // scan-ok: draft-payment-not-void — CREDIT_NOTE payments are never DRAFT/PENDING.
    return db.invoicePayment.findMany({
      where: { creditNoteId, method: PaymentMethod.CREDIT_NOTE, status: { not: "VOID" } },
      orderBy: { createdAt: "desc" },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            orderId: true,
            total: true,
            dueDate: true,
            status: true,
            payments: { select: { id: true, amount: true, status: true } },
          },
        },
      },
    });
  }

  /**
   * SA-436 PR-2 (#2402): GET :id/void-preview — read-only. The invoices a void-with-reversal
   * reopens and by how much, each with its status before and after, plus the refusal (if any)
   * the void itself would return.
   */
  async voidPreview(id: string) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: once per call, before any loop
    const db = this.prisma.forTenant();
    const cn = await db.creditNote.findFirst({
      where: { id },
      select: { id: true, creditNoteNumber: true, status: true, amount: true, amountUsed: true },
    });
    if (!cn) throw new NotFoundException("Credit note not found");
    const payments: any[] = await this.liveCreditPayments(db, id);
    const byInvoice = new Map<string, { inv: any; amount: number; payIds: Set<string> }>();
    for (const p of payments) {
      const row = byInvoice.get(p.invoiceId) ?? { inv: p.invoice, amount: 0, payIds: new Set() };
      row.amount = roundMoney(row.amount + Number(p.amount));
      row.payIds.add(p.id);
      byInvoice.set(p.invoiceId, row);
    }
    const invoices = [...byInvoice.values()].map(({ inv, amount, payIds }) => {
      const remaining = (inv.payments ?? []).filter((q: any) => !payIds.has(q.id));
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount,
        statusBefore: inv.status,
        statusAfter: recomputeInvoiceStatus(
          sumConfirmed(remaining),
          Number(inv.total),
          inv.dueDate,
          inv.status,
          tz,
        ),
      };
    });
    return {
      creditNoteId: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      restoresTotal: roundMoney(invoices.reduce((s, i) => s + i.amount, 0)),
      invoices,
      ...(await this.previewRefusal(db, cn, payments)),
    };
  }

  /**
   * #2648 / SA-535a(3): `voidWithReversal`'s transaction body, lifted UNCHANGED so the credit-note
   * reissue runs the SAME void (the same locks, refusals, reversal, apply blocks and ledger
   * counter-entries) inside its own transaction. Never opens a transaction.
   */
  async voidWithReversalInTx(
    tx: any,
    id: string,
    actorId: string | null,
    tz: Awaited<ReturnType<typeof tenantTimeZone>>,
    reason?: string | null, // #2540: optional WHY, recorded in the VOIDED audit row
    // SA-608g: rows the CALLER also needs locked in SA-214 order (the reissue's SOURCE invoice and its
    // order). They join the SAME sorted sets below, so the reissue never takes KEY SHARE on the invoice
    // after holding the note (CN -> Invoice) while deleteInvoice holds the invoice and wants the note.
    // The endpoint passes none: its lock set is unchanged.
    extra?: { orderIds?: string[]; invoiceIds?: string[] },
  ) {
    const seen: any[] = await this.liveCreditPayments(tx, id);
    // SA-498a: the lock set is COMPLETE, per SA-214: every order this void writes. That is the
    // orders of the invoices it reopens, UNION the orders whose OrderCreditNote intent rows it
    // deletes below (an intent can sit on an order this note never paid anything on).
    const intentOrders: Array<{ orderId: string }> =
      (await tx.orderCreditNote.findMany({
        where: { creditNoteId: id },
        select: { orderId: true },
      })) ?? [];
    const orderIds = [
      ...new Set([
        ...(seen.map((p) => p.invoice?.orderId).filter(Boolean) as string[]),
        ...intentOrders.map((r) => r.orderId),
        ...(extra?.orderIds ?? []),
      ]),
    ].sort();
    const invoiceIds = [
      ...new Set([...seen.map((p) => p.invoiceId as string), ...(extra?.invoiceIds ?? [])]),
    ].sort();
    for (const orderId of orderIds) {
      await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    }
    for (const invoiceId of invoiceIds) {
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
    }
    await tx.$executeRaw`SELECT id FROM "CreditNote" WHERE id = ${id} FOR UPDATE`;

    const cn = await tx.creditNote.findFirst({
      where: { id },
      select: { id: true, status: true, amountUsed: true },
    });
    if (!cn) throw new NotFoundException("Credit note not found");
    // Re-read under the locks: the rows the reversal restores are exactly these.
    const payments: any[] = await this.liveCreditPayments(tx, id);
    const refusal = await this.voidWithReversalRefusal(tx, cn, payments);
    if (refusal) throw cnBad(refusal.code, refusal.message);

    const reopened: Array<{ invoiceId: string; invoiceNumber: string; amount: number }> = [];
    for (const p of payments) {
      const restored = await this.restoreCreditFromPaymentInTx(tx, tz, p, undefined, {
        voidingNoteId: id, // the note's OWN void: it ends VOID, nothing becomes spendable
      });
      const row = reopened.find((r) => r.invoiceId === p.invoiceId);
      if (row) row.amount = roundMoney(row.amount + restored);
      else
        reopened.push({
          invoiceId: p.invoiceId,
          invoiceNumber: p.invoice?.invoiceNumber,
          amount: restored,
        });
    }
    await writeApplyBlocks(tx, {
      tenantId: this.prisma.getTenantId(),
      creditNoteId: id,
      invoiceIds: reopened.map((r) => r.invoiceId),
      reason: "VOID_REVERSAL",
      createdById: actorId,
    });
    await tx.orderCreditNote.deleteMany({ where: { creditNoteId: id } });

    // The same compare-and-set as the old plain void (removed, B957): every dollar is back, so amountUsed is 0.
    const flipped = await tx.creditNote.updateMany({
      where: { id, status: { not: "VOID" }, amountUsed: 0 },
      data: { status: "VOID" },
    });
    if (flipped.count === 0) {
      throw cnBad(
        API_ERROR_CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY,
        "This credit note changed while it was being voided. Nothing was changed; try again.",
      );
    }
    await this.ledger.unreverseCreditNoteEntries({ creditNoteId: id, db: tx });
    await tx.auditLog.create({
      data: {
        tenantId: this.prisma.getTenantId(),
        userId: actorId,
        action: "VOIDED", // SA-442 vocabulary
        entityType: "CreditNote",
        entityId: id,
        meta: { reversed: reopened, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
      },
    });
    const voided = await tx.creditNote.findUnique({ where: { id } });
    return { creditNote: voided, reopened };
  }

  /**
   * SA-436 PR-2 (#2402): POST :id/void-with-reversal. Un-applies every live application of the
   * note (restoreCreditFromPaymentInTx recomputes each invoice's status), remembers each pair
   * (CreditNoteApplyBlock VOID_REVERSAL) and drops the note's order intents, then runs the SAME
   * compare-and-set void and ledger un-reversal the plain void used (B957: POST :id/void delegates here).
   *
   * Serializable and retried whole on a conflict (L-221). Lock order SA-214: the payments'
   * Orders (sorted), then their Invoices (sorted), then the CreditNote row. Every refusal is
   * decided BEFORE the first write, so a refused call writes nothing.
   */
  async voidWithReversal(id: string, actorId: string | null, reason?: string | null) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: once per call, before any loop
    let result: Awaited<ReturnType<CreditNotesService["voidWithReversalInTx"]>>;
    try {
      result = await retryOnTxConflict(`credit void-with-reversal cn=${id}`, () =>
        this.prisma.tenantTransaction(
          (tx: any) => this.voidWithReversalInTx(tx, id, actorId, tz, reason),
          { isolationLevel: "Serializable" },
        ),
      );
    } catch (err) {
      throw asReadableConflict(err, this.logger); // SA-608h: exhausted retries are a 409, not a 500
    }

    this.gateway.emitCreditNoteVoided(this.prisma.getTenantId(), {
      creditNoteId: result.creditNote.id,
      creditNoteNumber: result.creditNote.creditNoteNumber,
      customerId: result.creditNote.customerId,
      amount: Number(result.creditNote.amount),
    });
    return result;
  }

  /**
   * B949: refuse (409 CREDIT_NOTE_SOURCE_GONE) when any of these payments would restore money to a note carrying the
   * SOURCE_DELETED marker. Callers run it over the WHOLE payment list BEFORE the first restore so the operation is refused
   * atomically (the tx would roll back anyway, but nothing is even attempted). The way out is the note's own void.
   */
  private async refuseSourceGoneRestores(
    tx: any,
    payments: ReadonlyArray<{ creditNoteId: string | null }>,
  ): Promise<void> {
    const ids = [...new Set(payments.map((p) => p.creditNoteId).filter(Boolean) as string[])];
    for (const id of ids) {
      if (!(await hasSourceDeletedMarker(tx, id))) continue;
      const cn = await tx.creditNote.findFirst({
        where: { id },
        select: { creditNoteNumber: true },
      });
      throw cnConflict(
        API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE,
        `Credit note ${cn?.creditNoteNumber ?? id} came from a deleted invoice. Void that credit note first, then try again.`,
      );
    }
  }

  /**
   * Inverse of applyCreditInTx: give (part of) an applied credit back to the wallet.
   * Deletes (or shrinks) the CREDIT_NOTE InvoicePayment, decrements amountUsed,
   * reverts APPLIED→ISSUED when the credit is no longer fully consumed, and
   * recomputes the invoice's status from its remaining non-VOID payments.
   * Returns the dollars actually restored.
   */
  private async restoreCreditFromPaymentInTx(
    tx: any,
    tz: string | null, // SA-495a: the caller's tenant zone, resolved once — never per row
    payment: { id: string; invoiceId: string; creditNoteId: string | null; amount: unknown },
    reduceBy?: number,
    // B949: the note being VOIDED/CANCELLED right now: its OWN payments may be restored (it ends VOID, nothing becomes
    // spendable). No global flag: any other note's marker still refuses.
    opts: { voidingNoteId?: string } = {},
  ): Promise<number> {
    if (!payment.creditNoteId) return 0;
    const payAmt = roundMoney(Number(payment.amount));
    const restore = roundMoney(Math.min(payAmt, reduceBy ?? payAmt));
    if (!(restore > 0.001)) return 0;
    // B949: the backstop of the pre-pass below. A restore would hand a SOURCE_DELETED note's money back as SPENDABLE wallet
    // credit with no provenance; every path that restores refuses, before it writes any RESTORE (an operation such as an order cancel may already have written its own claim in the same transaction; the refusal rolls the whole transaction back).
    if (payment.creditNoteId !== opts.voidingNoteId)
      await this.refuseSourceGoneRestores(tx, [payment]);

    if (restore >= payAmt - 0.001) {
      await tx.invoicePayment.delete({ where: { id: payment.id } });
    } else {
      await tx.invoicePayment.update({
        where: { id: payment.id },
        data: { amount: roundMoney(payAmt - restore) },
      });
    }

    // B1052: lock the note before reading its balance (the write below takes this lock anyway, so
    // the lock order is unchanged); a concurrent apply can no longer overwrite the restore.
    await lockCreditNotes(tx, [payment.creditNoteId]);
    const cn = await tx.creditNote.findUnique({ where: { id: payment.creditNoteId } });
    if (cn) {
      const newUsed = Math.max(0, roundMoney(Number(cn.amountUsed) - restore));
      const fullyApplied = newUsed >= Number(cn.amount) - 0.001;
      // REVIVE (owner decision 2026-08-13): dollars coming back must land somewhere
      // SPENDABLE. A note that expired while its money was parked on an invoice —
      // or was somehow voided — would otherwise take the balance back and stay
      // closed, hiding the value from every "open credit" reader. Clearing a past
      // expiry (and an unexpected VOID) restores it to the wallet the operator can
      // actually see. A FUTURE expiry is left alone: it's still valid.
      const expired = cn.expiresAt != null && new Date(cn.expiresAt) <= new Date();
      await tx.creditNote.update({
        where: { id: cn.id },
        data: {
          amountUsed: newUsed, // B1052: from the balance read under the lock above
          // Wallet state follows consumption: fully consumed = APPLIED, else ISSUED.
          status: fullyApplied && cn.status !== "VOID" ? "APPLIED" : "ISSUED",
          appliedToInvoiceId: fullyApplied ? cn.appliedToInvoiceId : null,
          ...(expired ? { expiresAt: null } : {}),
          ...(newUsed <= 0.001 ? { appliedAt: null, autoApplied: false } : {}),
        },
      });
    }

    const inv = await tx.invoice.findUnique({
      where: { id: payment.invoiceId },
      include: { payments: true },
    });
    if (inv) {
      // PR-2 (check-payments B1 hardening): invoice STATUS must reflect only genuinely
      // confirmed money, never a DRAFT (or, once PENDING exists, an un-cleared check) —
      // sumConfirmed replaces the not-void filter (F03 discipline; design.md §3.4).
      const paid = sumConfirmed(inv.payments);
      const newStatus = recomputeInvoiceStatus(
        paid,
        Number(inv.total),
        inv.dueDate,
        inv.status,
        tz,
      );
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? (inv.paidAt ?? new Date()) : null,
        },
      });
      // Sales agents & commissions: giving the credit back to the wallet
      // grows the base again and un-shrinks the collectible.
      await this.commissionEngine.syncInvoiceCommissionSafe(payment.invoiceId, tx);
    }
    return restore;
  }

  /**
   * B315 — the ADVANCE counterpart of restoreCreditFromPaymentInTx: gives (part of) an applied
   * advance back to the customer's wallet. Deletes (or shrinks) the ADVANCE InvoicePayment and
   * increments AdvancePayment.balance back up (capped at its original `amount` — balance can
   * never exceed what the customer actually deposited), then recomputes the invoice's status
   * from its remaining non-VOID payments. Returns the dollars actually restored.
   */
  private async restoreAdvanceFromPaymentInTx(
    tx: any,
    tz: string | null, // SA-495a: the caller's tenant zone, resolved once — never per row
    payment: { id: string; invoiceId: string; advancePaymentId: string | null; amount: unknown },
    tenantId: string | null,
    reduceBy?: number,
  ): Promise<number> {
    if (!payment.advancePaymentId) return 0;
    const payAmt = roundMoney(Number(payment.amount));
    const restore = roundMoney(Math.min(payAmt, reduceBy ?? payAmt));
    if (!(restore > 0.001)) return 0;

    if (restore >= payAmt - 0.001) {
      await tx.invoicePayment.delete({ where: { id: payment.id } });
    } else {
      await tx.invoicePayment.update({
        where: { id: payment.id },
        data: { amount: roundMoney(payAmt - restore) },
      });
    }

    // Opus review (F39): a read-then-write (`findUnique` balance, compute, `update`) on this
    // SAME column is the exact lost-update class B310 just closed on the apply side — a
    // concurrent `applyAdvancePaymentToInvoiceLocked` (atomic `{ decrement }` under its
    // advisory lock) could land between this read and this write and be silently erased. A
    // blocking advisory lock here would be wrong too (this runs inside an order-edit
    // transaction already holding row locks on a different connection — a second lock from in
    // here risks a cross-connection deadlock the 10s timeout would only mask). One atomic SQL
    // statement closes it instead: the cap-at-`amount` becomes `LEAST`, so there is no
    // read-modify-write window at all.
    //
    // B406: `id` alone is already sufficient to scope this write correctly —
    // `payment.advancePaymentId` only ever reaches this call via a tenant-scoped read
    // (this function's one caller, settleOrderCreditsInTx, resolves `payment` from
    // `tx.invoice.findMany({ where: { orderId, ... } })` under the tenant-scoped `tx`
    // proxy, so a cross-tenant orderId returns zero rows before this ever runs). The
    // `tenantId` predicate below is deliberate defense-in-depth against a FUTURE caller
    // that feeds this an id from somewhere unscoped, not a fix for a live cross-tenant
    // write — do not remove it as "redundant" without re-tracing that call path.
    // Skipped only when tenantId is unknown (the documented unwrapped-tx / fire-and-forget
    // case in settleOrderCreditsInTx's own tenantId param), so that narrow legitimate case
    // keeps its pre-existing (id-only) behaviour rather than silently updating zero rows.
    if (tenantId) {
      await tx.$executeRaw`UPDATE "AdvancePayment" SET balance = LEAST(amount, balance + ${restore}) WHERE id = ${payment.advancePaymentId} AND "tenantId" = ${tenantId}`;
    } else {
      await tx.$executeRaw`UPDATE "AdvancePayment" SET balance = LEAST(amount, balance + ${restore}) WHERE id = ${payment.advancePaymentId}`;
    }

    const inv = await tx.invoice.findUnique({
      where: { id: payment.invoiceId },
      include: { payments: true },
    });
    if (inv) {
      // PR-2 (check-payments B1 hardening): same sumConfirmed basis as
      // restoreCreditFromPaymentInTx above.
      const paid = sumConfirmed(inv.payments);
      const newStatus = recomputeInvoiceStatus(
        paid,
        Number(inv.total),
        inv.dueDate,
        inv.status,
        tz,
      );
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? (inv.paidAt ?? new Date()) : null,
        },
      });
      // Sales agents & commissions: giving the advance back to the wallet grows the base
      // again and un-shrinks the collectible — same reasoning as the credit-note restore.
      await this.commissionEngine.syncInvoiceCommissionSafe(payment.invoiceId, tx);
    }
    return restore;
  }

  /**
   * Validates a proposed set of order credit-note selections against the customer's
   * wallet BEFORE any mutation. Throws BadRequest/NotFound on: duplicate creditNoteId
   * in the list; unknown id; different customer; status VOID; expired
   * (expiresAt <= now). Deliberately does NOT require remaining balance > 0 — an
   * idempotent resubmit of an already-consumed selection must not fail (the apply
   * clamp in applyCreditInTx makes over-selection harmless).
   */
  async validateSelectionsForCustomer(
    db: any,
    customerId: string,
    selections: Array<{ creditNoteId: string; amount?: number }>,
  ): Promise<void> {
    if (!selections.length) return;

    const seen = new Set<string>();
    for (const s of selections) {
      if (seen.has(s.creditNoteId))
        throw new BadRequestException(`Duplicate credit note selection: ${s.creditNoteId}`);
      seen.add(s.creditNoteId);
    }

    const ids = [...seen];
    const notes = await db.creditNote.findMany({ where: { id: { in: ids } } });
    const byId = new Map(notes.map((n: any) => [n.id, n]));
    const now = new Date();
    for (const id of ids) {
      const cn: any = byId.get(id);
      if (!cn) throw new NotFoundException(`Credit note ${id} not found`);
      if (cn.customerId !== customerId)
        throw new BadRequestException(
          `Credit note ${cn.creditNoteNumber ?? id} does not belong to this customer`,
        );
      if (cn.status === "VOID")
        throw new BadRequestException(`Credit note ${cn.creditNoteNumber ?? id} has been voided`);
      if (cn.expiresAt && new Date(cn.expiresAt) <= now)
        throw new BadRequestException(`Credit note ${cn.creditNoteNumber ?? id} has expired`);
    }
  }

  /** Pull back the money for one (orderId, creditNoteId) pair — every non-VOID
   * CREDIT_NOTE payment this credit made against this order's invoices, restored
   * via restoreCreditFromPaymentInTx. Used by syncOrderCreditSelections whenever a
   * selection is dropped or its requested amount changes. */
  private async pullBackOrderCreditPair(
    tx: any,
    orderId: string,
    creditNoteId: string,
  ): Promise<void> {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: once per call, before any loop
    const pays = await tx.invoicePayment.findMany({
      where: {
        creditNoteId,
        method: PaymentMethod.CREDIT_NOTE,
        // scan-ok: draft-payment-not-void — method-scoped to CREDIT_NOTE; a CHECK/PENDING
        // row can never match, so PR-2's PENDING concern doesn't apply here.
        status: { not: "VOID" },
        invoice: { orderId },
      },
      orderBy: { createdAt: "desc" },
    });
    await this.refuseSourceGoneRestores(tx, pays); // B949: before the first restore
    for (const p of pays) await this.restoreCreditFromPaymentInTx(tx, tz, p);
  }

  /**
   * Give an order's ENTIRE applied credit back to the wallet, and forget the
   * intents that put it there. Used when an order stops being a thing the
   * customer owes for at all — cancel, delete, or a void of its invoices.
   *
   * Two deliberate differences from the shrink path in settleOrderCreditsInTx:
   *
   *  - **VOID invoices are included.** settle skips them, so a credit that was
   *    applied to an invoice which later got voided is invisible to every other
   *    code path — the dollars sit on a dead invoice and the note stays consumed
   *    forever. Sweeping them here is what makes already-stranded money
   *    recoverable, and re-running is safe because each restore DELETES the
   *    payment row it consumed.
   *  - **Intents are cleared, not just the money.** Leaving OrderCreditNote rows
   *    behind would let a later settle re-apply the very dollars we just returned.
   *
   * Returns the per-note totals so callers can tell the operator what moved.
   */
  async releaseOrderCreditsInTx(
    tx: any,
    orderId: string,
  ): Promise<Array<{ creditNoteId: string; creditNoteNumber: string; amount: number }>> {
    const released = await this.releaseCreditsInTx(tx, { orderId });
    // Forget the intents too — otherwise a later settle re-applies what we just
    // handed back. Order-scoped only: an invoice-scoped release (a single void)
    // leaves the order's intents alone on purpose, since the order lives on.
    await tx.orderCreditNote.deleteMany({ where: { orderId } });
    return released;
  }

  /**
   * Invoice-scoped release: hand back only the credits sitting on ONE invoice.
   * Used when voiding a single invoice whose order otherwise continues.
   */
  async releaseInvoiceCreditsInTx(
    tx: any,
    invoiceId: string,
  ): Promise<Array<{ creditNoteId: string; creditNoteNumber: string; amount: number }>> {
    return this.releaseCreditsInTx(tx, { id: invoiceId });
  }

  private async releaseCreditsInTx(
    tx: any,
    invoiceWhere: Record<string, unknown>,
  ): Promise<Array<{ creditNoteId: string; creditNoteNumber: string; amount: number }>> {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: once per call, before any loop
    const payments = await tx.invoicePayment.findMany({
      where: {
        method: PaymentMethod.CREDIT_NOTE,
        // scan-ok: draft-payment-not-void — method-scoped to CREDIT_NOTE (see
        // pullBackOrderCreditPair above).
        status: { not: "VOID" },
        invoice: invoiceWhere,
      },
      orderBy: { createdAt: "desc" },
    });

    await this.refuseSourceGoneRestores(tx, payments); // B949: before the first restore
    const byNote = new Map<string, { creditNoteNumber: string; amount: number }>();
    for (const p of payments) {
      const restored = await this.restoreCreditFromPaymentInTx(tx, tz, p);
      if (!(restored > 0.001) || !p.creditNoteId) continue;
      const prev = byNote.get(p.creditNoteId);
      const number =
        prev?.creditNoteNumber ??
        (
          await tx.creditNote.findFirst({
            where: { id: p.creditNoteId },
            select: { creditNoteNumber: true },
          })
        )?.creditNoteNumber ??
        "";
      byNote.set(p.creditNoteId, {
        creditNoteNumber: number,
        amount: roundMoney((prev?.amount ?? 0) + restored),
      });
    }

    return [...byNote].map(([creditNoteId, v]) => ({ creditNoteId, ...v }));
  }

  /**
   * READ-ONLY twin of releaseOrderCreditsInTx: what the release WOULD hand back,
   * per note. Backs the cancel confirmation so the operator is told "$50.00 goes
   * back to CN-0007" before they commit, never after.
   */
  async previewOrderCreditRelease(
    orderId: string,
    tx?: any,
  ): Promise<Array<{ creditNoteId: string; creditNoteNumber: string; amount: number }>> {
    const db = tx ?? this.prisma.forTenant();
    const payments = await db.invoicePayment.findMany({
      where: {
        method: PaymentMethod.CREDIT_NOTE,
        // scan-ok: draft-payment-not-void — method-scoped to CREDIT_NOTE (see
        // pullBackOrderCreditPair above).
        status: { not: "VOID" },
        invoice: { orderId },
      },
      include: { creditNote: { select: { creditNoteNumber: true } } },
    });

    const byNote = new Map<string, { creditNoteNumber: string; amount: number }>();
    for (const p of payments) {
      if (!p.creditNoteId) continue;
      const prev = byNote.get(p.creditNoteId);
      byNote.set(p.creditNoteId, {
        creditNoteNumber: prev?.creditNoteNumber ?? p.creditNote?.creditNoteNumber ?? "",
        amount: roundMoney((prev?.amount ?? 0) + Number(p.amount)),
      });
    }
    return [...byNote].map(([creditNoteId, v]) => ({ creditNoteId, ...v }));
  }

  /**
   * Syncs an order's OrderCreditNote intent rows to the operator's desired selection
   * set. `selections === undefined` is backward compatible — leaves credits untouched
   * (clients that don't send the field never affect existing intents). Otherwise
   * `selections` is the FULL desired set: the server diffs against what's currently
   * stored and pulls back money for anything dropped or re-amounted before writing
   * the new rows. Never applies money itself — settleOrderCreditsInTx does that.
   */
  async syncOrderCreditSelections(
    tx: any,
    orderId: string,
    customerId: string,
    selections: Array<{ creditNoteId: string; amount?: number }> | undefined,
  ): Promise<void> {
    if (selections === undefined) return;
    await this.validateSelectionsForCustomer(tx, customerId, selections);

    const existing = await tx.orderCreditNote.findMany({ where: { orderId } });
    const selectionById = new Map(selections.map((s) => [s.creditNoteId, s]));
    // SA-436a: the order's non-VOID invoices, the scope of an untick's block and a re-tick's clear.
    const orderInvoiceIds: string[] = (
      (await tx.invoice.findMany({
        where: { orderId, status: { not: "VOID" } },
        select: { id: true },
      })) ?? []
    ).map((i: any) => i.id);

    for (const row of existing) {
      // design.md §2.1/§6.3: an INLINE return's own intent on its OWN carrying order is
      // "system-owned" — InlineReturnsService.capture()/issueCredit() wrote it directly,
      // never through a staff `selections` list, and it must never be dropped or
      // re-amounted just because THIS sync call's list doesn't happen to name it (a staff
      // member syncing this same order's OTHER, ordinary wallet-credit selections must not
      // silently unwind the return's own credit).
      if (await this.isSystemOwnedInlineCreditInTx(tx, orderId, row.creditNoteId)) continue;
      const sel = selectionById.get(row.creditNoteId);
      if (!sel) {
        // Dropped selection — pull back this pair's money then delete the row.
        await this.pullBackOrderCreditPair(tx, orderId, row.creditNoteId);
        await tx.orderCreditNote.delete({ where: { id: row.id } });
        // SA-436a: an untick blocks the note on every non-VOID invoice of the order, so neither
        // the send-time sweep nor a later settle puts it back. No actor reaches this path.
        await writeApplyBlocks(tx, {
          tenantId: this.prisma.getTenantId(),
          creditNoteId: row.creditNoteId,
          invoiceIds: orderInvoiceIds,
          reason: "UNTICKED",
        });
        continue;
      }
      const nextAmount = sel.amount != null ? roundMoney(sel.amount) : null;
      const currentAmount = row.amount != null ? roundMoney(Number(row.amount)) : null;
      if (nextAmount !== currentAmount) {
        // Requested amount changed (null vs number, or a different rounded number) —
        // pull back this pair's money; settle re-applies at the new request.
        await this.pullBackOrderCreditPair(tx, orderId, row.creditNoteId);
        await tx.orderCreditNote.update({ where: { id: row.id }, data: { amount: nextAmount } });
        // SA-436a: a re-amount is explicit intent; lift the note's blocks so settle re-applies.
        await clearApplyBlocks(tx, row.creditNoteId, orderInvoiceIds);
      }
    }

    const existingIds = new Set(existing.map((r: any) => r.creditNoteId));
    for (const sel of selections) {
      if (existingIds.has(sel.creditNoteId)) continue;
      // SA-436a: a (re-)tick is explicit intent; lift the note's blocks so settle applies it.
      await clearApplyBlocks(tx, sel.creditNoteId, orderInvoiceIds);
      await tx.orderCreditNote.create({
        data: {
          orderId,
          creditNoteId: sel.creditNoteId,
          amount: sel.amount ?? null,
          tenantId: this.prisma.getTenantId(),
        },
      });
    }
  }

  /**
   * Reconcile the order's credit INTENTS (OrderCreditNote rows) with actual
   * CREDIT_NOTE InvoicePayments, inside the caller's transaction. Idempotent:
   * (a) SHRINK — if an order edit dropped an invoice total below what its
   *     payments cover, un-apply the excess from credit payments (newest first;
   *     cash is never auto-adjusted);
   * (b) APPLY — for each intent (oldest first), apply the unmet remainder
   *     across the order's non-VOID invoices (base number first, then -R#
   *     siblings). applyCreditInTx clamps everything, so re-runs are no-ops.
   * No-op when the order has no invoices yet (intent waits for one).
   */
  async settleOrderCreditsInTx(
    tx: any,
    orderId: string,
    // Effective tenant for the credit payment rows. Defaults to the request context,
    // but callers on an unwrapped tx (fire-and-forget invoice creation) MUST pass it
    // explicitly — AsyncLocalStorage is lost there, so getTenantId() returns null and
    // the payment would be written tenant-orphaned.
    tenantId: string | null = this.prisma.getTenantId(),
  ): Promise<{ applied: number; unapplied: number }> {
    const tz = await tenantTimeZone(this.prisma, tenantId); // #2556 B3: the explicit tenant, not the ambient one
    const result = { applied: 0, unapplied: 0 };
    // B1052: the FIRST statements — lock this Order, its invoices and every note this settle can
    // touch (SA-214 order, each set in id order) BEFORE any balance is read. Two office settles
    // (or office then driver) of orders sharing a note used to both read amountUsed=0 and both
    // spend it; now the second waits here and reads the first's committed balance.
    await lockOrderCreditSettle(tx, orderId);
    const intents = await tx.orderCreditNote.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      include: { creditNote: true },
    });
    const invoices = await tx.invoice.findMany({
      where: { orderId, status: { not: "VOID" } },
      include: { payments: true },
      orderBy: { invoiceNumber: "asc" },
    });
    if (invoices.length === 0) return result;
    // SA-436: a pair an operator removed is skipped by the apply pass below (never the shrink).
    const blocked = await blockedPairs(
      tx,
      invoices.map((i: any) => i.id),
    );

    // (a) shrink
    for (const inv of invoices) {
      // PR-2 review (routeflow-Lead, 2026-09-16): reverted the earlier sumConfirmed
      // conversion here — with sumConfirmed, a DRAFT payment stacked on top of a PAID
      // one (e.g. 40 PAID + 60 DRAFT on a total shrunk to 70) reports excess = 40-70
      // (negative), so the shrink never refunds the real $30 over-collection sitting in
      // the not-void total, leaving it stuck. Master's not-void basis restored; see the
      // REG-B1-shrink test below for exactly this scenario.
      // scan-ok: draft-payment-not-void — a candidate-selection list, never summed into a
      // paid/status figure directly; the method-scoped filters below already exclude CHECK.
      const nonVoid = (inv.payments ?? []).filter((p: any) => p.status !== "VOID");
      const paid = roundMoney(nonVoid.reduce((s: number, p: any) => s + Number(p.amount), 0));
      let excess = roundMoney(paid - Number(inv.total));
      if (!(excess > 0.001)) continue;
      const creditPays = nonVoid
        .filter((p: any) => p.method === "CREDIT_NOTE" && p.creditNoteId)
        .sort(
          (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      await this.refuseSourceGoneRestores(tx, creditPays); // B949: before the first restore
      for (const p of creditPays) {
        if (!(excess > 0.001)) break;
        const restored = await this.restoreCreditFromPaymentInTx(tx, tz, p, excess);
        excess = roundMoney(excess - restored);
        result.unapplied = roundMoney(result.unapplied + restored);
        // Fold the restore back into the in-memory snapshot so the apply pass below
        // sees POST-shrink consumption. restoreCreditFromPaymentInTx mutated the DB
        // rows but not these objects; without this, appliedForPair (explicit intents)
        // and the credit's amountUsed (null-amount intents) would still reflect the
        // pre-shrink dollars, over-counting consumption and under-applying the credit
        // across sibling invoices within this same settle call.
        p.amount = roundMoney(Number(p.amount) - restored);
        const owner = intents.find((it: any) => it.creditNoteId === p.creditNoteId);
        if (owner?.creditNote) {
          owner.creditNote.amountUsed = Math.max(
            0,
            roundMoney(Number(owner.creditNote.amountUsed) - restored),
          );
        }
      }
      // B315: an ADVANCE payment is wallet money exactly like a credit note — when the order
      // edit above shrinks the invoice below what an applied advance covers, the excess must
      // come back to the customer's AdvancePayment.balance the same way a credit note's
      // excess comes back to amountUsed. Before this, the shrink pass only ever looked at
      // CREDIT_NOTE payments, so an applied advance just stayed "spent" against a total that
      // no longer existed — money the customer prepaid, silently gone from the wallet.
      if (excess > 0.001) {
        const advancePays = nonVoid
          .filter((p: any) => p.method === "ADVANCE" && p.advancePaymentId)
          .sort(
            (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );
        for (const p of advancePays) {
          if (!(excess > 0.001)) break;
          const restored = await this.restoreAdvanceFromPaymentInTx(tx, tz, p, tenantId, excess);
          excess = roundMoney(excess - restored);
          result.unapplied = roundMoney(result.unapplied + restored);
        }
      }
    }

    // (b) apply — reads the in-memory `invoices`/`intent.creditNote` snapshot, which
    // pass (a) folded its restore deltas into, so consumption figures are current.
    const now = new Date();
    for (const intent of intents) {
      const cn0 = intent.creditNote;
      if (!cn0 || cn0.status === "VOID") continue;
      if (cn0.expiresAt && new Date(cn0.expiresAt) <= now) continue;
      // scan-ok: draft-payment-not-void — `creditNoteId` is only ever set on a
      // CREDIT_NOTE-method payment (applyCreditInTx), so a CHECK/PENDING row can
      // never match this filter regardless of its status.
      const appliedForPair = roundMoney(
        invoices
          .flatMap((inv: any) => inv.payments ?? [])
          .filter((p: any) => p.status !== "VOID" && p.creditNoteId === intent.creditNoteId)
          .reduce((s: number, p: any) => s + Number(p.amount), 0),
      );
      let unmet =
        intent.amount != null
          ? roundMoney(Math.max(0, Number(intent.amount) - appliedForPair))
          : roundMoney(Number(cn0.amount) - Number(cn0.amountUsed));
      for (const inv of invoices) {
        if (!(unmet > 0.001)) break;
        if (blocked.has(pairKey(intent.creditNoteId, inv.id))) continue;
        // Fresh reads — earlier loop iterations move money.
        const cn = await tx.creditNote.findUnique({ where: { id: intent.creditNoteId } });
        const freshInv = await tx.invoice.findUnique({
          where: { id: inv.id },
          include: { payments: true },
        });
        if (!cn || !freshInv) break;
        const res = await this.applyCreditInTx(tx, tz, cn, freshInv, unmet, { tenantId });
        if (res.applied <= 0) continue;
        unmet = roundMoney(unmet - res.applied);
        result.applied = roundMoney(result.applied + res.applied);
      }
    }
    return result;
  }

  /**
   * Un-applies a credit note from one invoice: restores this (creditNoteId, invoiceId)
   * pair's active CREDIT_NOTE payments to the wallet, then reduces (or removes) the
   * order's OrderCreditNote intent so a later settle doesn't just re-apply the same
   * dollars. Returns the fresh credit note row.
   */
  async unapplyFromInvoice(creditNoteId: string, invoiceId: string, actorId: string | null = null) {
    const tz = await tenantTimeZone(this.prisma); // SA-495a: once per call, before any loop
    // SA-392 (#2201): the WHOLE Serializable tx re-runs on a 40001/40P01 conflict (bounded).
    return retryOnTxConflict(`credit unapply cn=${creditNoteId} inv=${invoiceId}`, () =>
      this.prisma.tenantTransaction(
        async (tx: any) => {
          // scan-ok: draft-payment-not-void — method-scoped to CREDIT_NOTE (see
          // pullBackOrderCreditPair above).
          const payments = await tx.invoicePayment.findMany({
            where: {
              creditNoteId,
              invoiceId,
              method: PaymentMethod.CREDIT_NOTE,
              status: { not: "VOID" },
            },
            orderBy: { createdAt: "desc" },
          });
          if (!payments.length)
            throw new BadRequestException(
              "This credit note has no active application to that invoice",
            );

          await this.refuseSourceGoneRestores(tx, payments); // B949: before the first restore
          let restored = 0;
          for (const p of payments) {
            restored = roundMoney(restored + (await this.restoreCreditFromPaymentInTx(tx, tz, p)));
          }
          // SA-436: remember the removal so neither the sweep nor a settle re-applies this pair.
          await writeApplyBlocks(tx, {
            tenantId: this.prisma.getTenantId(),
            creditNoteId,
            invoiceIds: [invoiceId],
            reason: "UNAPPLIED",
            createdById: actorId,
          });

          const invoice = await tx.invoice.findFirst({
            where: { id: invoiceId },
            select: { orderId: true },
          });
          if (invoice?.orderId) {
            const link = await tx.orderCreditNote.findFirst({
              where: { orderId: invoice.orderId, creditNoteId },
            });
            if (link) {
              if (link.amount == null) {
                await tx.orderCreditNote.delete({ where: { id: link.id } });
              } else {
                const newAmt = roundMoney(Number(link.amount) - restored);
                if (newAmt > 0.001) {
                  await tx.orderCreditNote.update({
                    where: { id: link.id },
                    data: { amount: newAmt },
                  });
                } else {
                  await tx.orderCreditNote.delete({ where: { id: link.id } });
                }
              }
            }
          }

          return tx.creditNote.findUnique({ where: { id: creditNoteId } });
        },
        { isolationLevel: "Serializable" },
      ),
    );
  }

  /**
   * SA-436 (#2401): keep this note out of (or back in) the send-time oldest-first sweep. A manual
   * apply stays allowed either way. Audited with the acting user.
   */
  async setAutoApplyExcluded(id: string, excluded: boolean, actorId: string | null) {
    return this.prisma.tenantTransaction(async (tx: any) => {
      // findFirst, not findUnique: the tenant proxy injects tenantId into findFirst's where, so a
      // foreign tenant's note id is a 404 here (findUnique skips the injection and 500s later).
      const cn = await tx.creditNote.findFirst({ where: { id }, select: { id: true } });
      if (!cn) throw new NotFoundException("Credit note not found");
      const updated = await tx.creditNote.update({
        where: { id },
        data: { autoApplyExcluded: excluded },
      });
      await tx.auditLog.create({
        data: {
          tenantId: this.prisma.getTenantId(),
          userId: actorId,
          action: "EXCLUDED",
          entityType: "CreditNote", // SA-442: one credit-note audit vocabulary
          entityId: id,
          meta: { excluded },
        },
      });
      return updated;
    });
  }

  /**
   * Edits a credit note's descriptive `reason` (any status — it's just text that
   * renders via the relation everywhere the credit is shown) and/or `expiresAt`
   * (ISSUED only — an applied/void credit's expiry is no longer meaningful).
   */
  async updateCreditNote(
    id: string,
    dto: { reason?: string; expiresAt?: string | null },
    actorId: string | null = null,
  ) {
    // #2648 / SA-535(a): the in-place edit is the NON-money fields only (reason, expiresAt). It never
    // touches amount/amountUsed/status/invoiceId/links (an amount edit is the reissue), a VOID note
    // is not editable at all (409), and every save that changes something leaves an EDITED audit
    // row with what changed.
    return this.prisma.tenantTransaction(async (tx: any) => {
      const cn = await tx.creditNote.findFirst({
        where: { id },
        select: { id: true, status: true, reason: true, expiresAt: true },
      });
      if (!cn) throw new NotFoundException("Credit note not found");
      if (cn.status === "VOID")
        throw cnConflict(
          API_ERROR_CODES.CREDIT_NOTE_VOID_NOT_EDITABLE,
          "A void credit note can't be edited.",
        );

      // SA-535b: the no-op filter runs FIRST, so a field that does not change is never validated
      // (re-saving an unchanged expiry on an applied or expired note is a quiet no-op, not a 400).
      const sameDate = (a: Date | null, b: Date | null) =>
        (a ? new Date(a).getTime() : null) === (b ? b.getTime() : null);
      const data: any = {};
      if (dto.reason !== undefined && (cn.reason ?? null) !== (dto.reason ?? null))
        data.reason = dto.reason;
      if (dto.expiresAt !== undefined) {
        let next: Date | null = null;
        if (dto.expiresAt !== null) {
          next = new Date(dto.expiresAt);
          if (isNaN(next.getTime()))
            throw new BadRequestException("expiresAt must be a valid ISO date");
        }
        if (!sameDate(cn.expiresAt ?? null, next)) {
          // #2848: an expiry change could revive an orphan's value; refused once its source is gone.
          if (await hasSourceDeletedMarker(tx, id))
            throw cnConflict(API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE, SOURCE_DELETED_MESSAGE);
          if (cn.status !== "ISSUED")
            throw cnBad(
              API_ERROR_CODES.CREDIT_NOTE_EXPIRY_NOT_EDITABLE,
              "expiresAt can only be changed while the credit note is ISSUED",
            );
          if (next && next.getTime() <= Date.now())
            throw cnBad(API_ERROR_CODES.CREDIT_NOTE_EXPIRY_PAST, "expiresAt must be in the future");
          data.expiresAt = next;
        }
      }
      if (Object.keys(data).length === 0) return tx.creditNote.findFirst({ where: { id } });

      const updated = await tx.creditNote.update({ where: { id }, data });
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const k of Object.keys(data)) {
        before[k] = (cn as any)[k] ?? null;
        after[k] = data[k];
      }
      await tx.auditLog.create({
        data: {
          tenantId: this.prisma.getTenantId(),
          userId: actorId,
          action: "EDITED", // SA-442 vocabulary (SA-535a)
          entityType: "CreditNote",
          entityId: id,
          meta: { before, after } as any,
        },
      });
      return updated;
    });
  }
}

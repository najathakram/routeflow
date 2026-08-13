import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { roundMoney } from "../common/pricing";
import { InvoiceStatus, PaymentMethod } from "@prisma/client";

@Injectable()
export class CreditNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly ledger: RegulatedLedgerService,
  ) {}

  /** Round a quantity to 3 decimals (matches the Decimal(12,3) columns). */
  private round3(n: number): number {
    return Math.round(n * 1000) / 1000;
  }

  private async nextCnNumber(db: any) {
    const year = new Date().getFullYear();
    const prefix = `CN-${year}-`;
    const last = await db.creditNote.findFirst({
      where: { creditNoteNumber: { startsWith: prefix } },
      orderBy: { creditNoteNumber: "desc" },
    });
    const seq = last ? parseInt(last.creditNoteNumber.split("-")[2], 10) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, "0")}`;
  }

  private recomputeStatus(
    totalPaid: number,
    total: number,
    dueDate: Date | null,
    currentStatus?: InvoiceStatus,
  ): InvoiceStatus {
    // DRAFT, VOID, and WRITTEN_OFF are terminal/deliberate states — never auto-override.
    if (
      currentStatus === InvoiceStatus.DRAFT ||
      currentStatus === InvoiceStatus.VOID ||
      currentStatus === InvoiceStatus.WRITTEN_OFF
    ) {
      return currentStatus;
    }
    if (totalPaid >= total - 0.001) return InvoiceStatus.PAID;
    if (totalPaid > 0) return InvoiceStatus.PARTIAL;
    if (dueDate && new Date(dueDate) < new Date()) return InvoiceStatus.OVERDUE;
    return InvoiceStatus.SENT;
  }

  async create(dto: {
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
  }) {
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

    // Everything — number allocation, the cumulative-credit cap, the per-line
    // breakdown and the ledger reversal — runs inside ONE serializable transaction so
    // concurrent credit notes against the same invoice can't both pass a stale cap and
    // over-credit / over-reverse the regulated ledger.
    const cn = await this.prisma.tenantTransaction(
      async (tx: any) => {
        let cnItemsData: Array<{
          invoiceItemId: string;
          trackedCategoryId: string | null;
          amount: number;
          qty: number;
          categoryTax: number;
        }> = [];

        if (dto.invoiceId) {
          const invoice = await tx.invoice.findUnique({
            where: { id: dto.invoiceId },
            select: {
              total: true,
              customerId: true,
              items: {
                select: {
                  id: true,
                  subtotal: true,
                  qty: true,
                  trackedCategoryId: true,
                  categoryTaxAmount: true,
                },
              },
            },
          });
          if (!invoice) throw new BadRequestException("Invoice not found");
          if (invoice.customerId !== dto.customerId)
            throw new BadRequestException("Invoice does not belong to this customer");

          const existingCredits = await tx.creditNote.aggregate({
            where: { invoiceId: dto.invoiceId, status: { not: "VOID" } },
            _sum: { amount: true },
          });
          const totalExisting = Number(existingCredits._sum.amount ?? 0);
          const invoiceTotal = Number(invoice.total);
          if (totalExisting + dto.amount > invoiceTotal + 0.001) {
            throw new BadRequestException(
              `Credit note amount (${dto.amount}) would exceed invoice total (${invoiceTotal}). Already credited: ${totalExisting}.`,
            );
          }

          if (lineItems) {
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
            const priorLineItems = await tx.creditNoteItem.findMany({
              where: {
                invoiceItemId: { in: [...mergedByLine.keys()] },
                creditNote: { invoiceId: dto.invoiceId, status: { not: "VOID" } },
              },
              select: { invoiceItemId: true, amount: true },
            });
            const creditedByLine = new Map<string, number>();
            for (const it of priorLineItems) {
              const k = it.invoiceItemId ?? "";
              creditedByLine.set(k, (creditedByLine.get(k) ?? 0) + Number(it.amount));
            }

            let sum = 0;
            cnItemsData = [...mergedByLine.values()].map((li) => {
              const line: any = lineById.get(li.invoiceItemId);
              if (!line)
                throw new BadRequestException(
                  `Credit line ${li.invoiceItemId} is not on invoice ${dto.invoiceId}`,
                );
              const amt = li.amount;
              if (!(amt > 0))
                throw new BadRequestException("Credit line amount must be greater than 0");
              const lineSubtotal = Number(line.subtotal);
              const priorForLine = creditedByLine.get(li.invoiceItemId) ?? 0;
              if (priorForLine + amt > lineSubtotal + 0.001)
                throw new BadRequestException(
                  priorForLine > 0
                    ? `Credit line amount (${amt}) plus prior credits (${roundMoney(priorForLine)}) would exceed invoice line subtotal (${lineSubtotal})`
                    : `Credit line amount (${amt}) exceeds invoice line subtotal (${lineSubtotal})`,
                );
              sum += amt;
              const frac = lineSubtotal > 0 ? Math.min(1, amt / lineSubtotal) : 0;
              return {
                invoiceItemId: line.id,
                // Snapshot the category as it was AT SALE (the invoice line), NEVER the
                // live product — a product's category may have drifted, and only a line
                // that actually sold regulated has a matching SALE row to reverse.
                trackedCategoryId: line.trackedCategoryId ?? null,
                amount: roundMoney(amt),
                qty: li.qty != null ? this.round3(li.qty) : this.round3(Number(line.qty) * frac),
                categoryTax: roundMoney(Number(line.categoryTaxAmount ?? 0) * frac),
              };
            });
            if (Math.abs(sum - dto.amount) > 0.01)
              throw new BadRequestException(
                `Credit line amounts (${roundMoney(sum)}) must sum to the credit note amount (${dto.amount})`,
              );
          }
        }

        const creditNoteNumber = await this.nextCnNumber(tx);
        const created = await tx.creditNote.create({
          data: {
            creditNoteNumber,
            customerId: dto.customerId,
            invoiceId: dto.invoiceId,
            amount: dto.amount,
            reason: dto.reason,
            status: "ISSUED",
            expiresAt,
          },
          include: { customer: { select: { id: true, businessName: true } } },
        });

        // Only regulated lines drive a ledger reversal (CreditNoteItem is consumed
        // solely by reverseCreditNoteEntries, which filters on trackedCategoryId).
        const regulatedItems = cnItemsData.filter((i) => i.trackedCategoryId);
        if (regulatedItems.length > 0 && tenantId) {
          await tx.creditNoteItem.createMany({
            data: regulatedItems.map((i) => ({ ...i, creditNoteId: created.id, tenantId })),
          });
          await this.ledger.reverseCreditNoteEntries({ creditNoteId: created.id, db: tx });
        }
        return created;
      },
      { isolationLevel: "Serializable" },
    );

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
        include: { customer: { select: { id: true, businessName: true } } },
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

  async issue(id: string) {
    return this.findOne(id);
  }

  /**
   * P5-13: the single tx-safe primitive that applies (part of) a credit note to an
   * invoice. Runs INSIDE an already-open tenant transaction `tx` — never opens its
   * own. Every monetary figure via roundMoney. Returns {applied:0} instead of
   * throwing so the auto-apply loop can skip; the manual path throws on 0 itself.
   * Callers pre-filter VOID + expired credits (expiry is a computed filter).
   */
  private async applyCreditInTx(
    tx: any,
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
    const remaining = roundMoney(Number(cn.amount) - Number(cn.amountUsed));
    // P5-12: a bounced check flips its InvoicePayment to VOID — must NOT count as
    // paid, so the credit can correctly cover the re-opened balance.
    const alreadyPaid = roundMoney(
      (inv.payments ?? [])
        .filter((p) => p.status !== "VOID")
        .reduce((s, p) => s + Number(p.amount), 0),
    );
    const invoiceBalance = roundMoney(Number(inv.total) - alreadyPaid);
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
        ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
      },
    });

    const newPaid = roundMoney(alreadyPaid + applyAmount);
    const newStatus = this.recomputeStatus(newPaid, Number(inv.total), inv.dueDate, inv.status);
    await tx.invoice.update({
      where: { id: inv.id },
      data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
    });

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
    const nothing: { applied: number; invoiceStatus: InvoiceStatus | null } = {
      applied: 0,
      invoiceStatus: null,
    };
    if (!invoiceId || !customerId) return nothing;

    const first = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true },
    });
    if (!first) return nothing;
    const paid = roundMoney(
      (first.payments ?? [])
        .filter((p: any) => p.status !== "VOID")
        .reduce((s: number, p: any) => s + Number(p.amount), 0),
    );
    let running = roundMoney(Number(first.total) - paid);
    if (!(running > 0.001)) return nothing;

    const now = new Date();
    const candidates = await tx.creditNote.findMany({
      where: {
        customerId,
        status: { not: "VOID" },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        ...(opts?.excludeCreditNoteIds?.length ? { id: { notIn: opts.excludeCreditNoteIds } } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    const open = (candidates ?? []).filter(
      (c: any) => roundMoney(Number(c.amount) - Number(c.amountUsed)) > 0.001,
    );
    if (open.length === 0) return nothing;

    let totalApplied = 0;
    let invoiceStatus: InvoiceStatus | null = null;
    let inv = first;
    for (const cn of open) {
      if (!(running > 0.001)) break;
      // `running` as the requested amount = a hard clamp; over-applying is
      // impossible even if the invoice re-read were stale.
      const res = await this.applyCreditInTx(tx, cn, inv, running, { autoApplied: true });
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
    return this.prisma.tenantTransaction(
      async (tx) => {
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

        const notApplicableStatuses: InvoiceStatus[] = [
          InvoiceStatus.PAID,
          InvoiceStatus.VOID,
          InvoiceStatus.WRITTEN_OFF,
        ];
        if (notApplicableStatuses.includes(inv.status)) {
          throw new BadRequestException(
            `Cannot apply credit note to invoice with status ${inv.status}`,
          );
        }
        if (cn.customerId !== inv.customerId) {
          throw new BadRequestException("Credit note and invoice belong to different customers");
        }

        const { applied } = await this.applyCreditInTx(tx, cn, inv, amount);
        if (applied <= 0)
          throw new BadRequestException(
            "Credit note has no remaining balance or invoice is fully paid",
          );

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
    );
  }

  async voidCreditNote(id: string) {
    return this.prisma.tenantTransaction(
      async (tx: any) => {
        const cn = await tx.creditNote.findUnique({
          where: { id },
          select: { status: true, amountUsed: true },
        });
        if (!cn) throw new NotFoundException("Credit note not found");
        // A credit that's been consumed as a payment can't be voided — un-applying it
        // first is the only safe path. Without this, void would delete the ledger
        // reversal (re-inflating net sales) AND leave the InvoicePayment orphaned.
        if (cn.status === "APPLIED" || Number(cn.amountUsed) > 0) {
          throw new BadRequestException(
            "Cannot void a credit note that has been applied — un-apply it first.",
          );
        }
        // Race-free flip: only ISSUED/DRAFT + unused → VOID. A concurrent
        // applyToInvoice (also serializable) that sets amountUsed>0 / APPLIED makes
        // this updateMany match 0 rows, so we refuse rather than orphan the payment.
        const flipped = await tx.creditNote.updateMany({
          where: { id, status: { notIn: ["APPLIED", "VOID"] }, amountUsed: 0 },
          data: { status: "VOID" },
        });
        if (flipped.count === 0) {
          throw new BadRequestException(
            "Cannot void a credit note that has been applied — un-apply it first.",
          );
        }
        // W5c: undo the regulated ledger reversal booked at creation (safe now — the
        // credit was never consumed, so voiding restores the sale to full).
        await this.ledger.unreverseCreditNoteEntries({ creditNoteId: id, db: tx });
        return tx.creditNote.findUnique({ where: { id } });
      },
      { isolationLevel: "Serializable" },
    );
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
    payment: { id: string; invoiceId: string; creditNoteId: string | null; amount: unknown },
    reduceBy?: number,
  ): Promise<number> {
    if (!payment.creditNoteId) return 0;
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
          amountUsed: newUsed,
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
      const paid = roundMoney(
        (inv.payments ?? [])
          .filter((p: any) => p.status !== "VOID")
          .reduce((s: number, p: any) => s + Number(p.amount), 0),
      );
      const newStatus = this.recomputeStatus(paid, Number(inv.total), inv.dueDate, inv.status);
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          status: newStatus,
          paidAt: newStatus === InvoiceStatus.PAID ? (inv.paidAt ?? new Date()) : null,
        },
      });
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
    const pays = await tx.invoicePayment.findMany({
      where: {
        creditNoteId,
        method: PaymentMethod.CREDIT_NOTE,
        status: { not: "VOID" },
        invoice: { orderId },
      },
      orderBy: { createdAt: "desc" },
    });
    for (const p of pays) await this.restoreCreditFromPaymentInTx(tx, p);
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
    const payments = await tx.invoicePayment.findMany({
      where: {
        method: PaymentMethod.CREDIT_NOTE,
        status: { not: "VOID" },
        invoice: invoiceWhere,
      },
      orderBy: { createdAt: "desc" },
    });

    const byNote = new Map<string, { creditNoteNumber: string; amount: number }>();
    for (const p of payments) {
      const restored = await this.restoreCreditFromPaymentInTx(tx, p);
      if (!(restored > 0.001) || !p.creditNoteId) continue;
      const prev = byNote.get(p.creditNoteId);
      const number =
        prev?.creditNoteNumber ??
        (
          await tx.creditNote.findUnique({
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

    for (const row of existing) {
      const sel = selectionById.get(row.creditNoteId);
      if (!sel) {
        // Dropped selection — pull back this pair's money then delete the row.
        await this.pullBackOrderCreditPair(tx, orderId, row.creditNoteId);
        await tx.orderCreditNote.delete({ where: { id: row.id } });
        continue;
      }
      const nextAmount = sel.amount != null ? roundMoney(sel.amount) : null;
      const currentAmount = row.amount != null ? roundMoney(Number(row.amount)) : null;
      if (nextAmount !== currentAmount) {
        // Requested amount changed (null vs number, or a different rounded number) —
        // pull back this pair's money; settle re-applies at the new request.
        await this.pullBackOrderCreditPair(tx, orderId, row.creditNoteId);
        await tx.orderCreditNote.update({ where: { id: row.id }, data: { amount: nextAmount } });
      }
    }

    const existingIds = new Set(existing.map((r: any) => r.creditNoteId));
    for (const sel of selections) {
      if (existingIds.has(sel.creditNoteId)) continue;
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
    const result = { applied: 0, unapplied: 0 };
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

    // (a) shrink
    for (const inv of invoices) {
      const nonVoid = (inv.payments ?? []).filter((p: any) => p.status !== "VOID");
      const paid = roundMoney(nonVoid.reduce((s: number, p: any) => s + Number(p.amount), 0));
      let excess = roundMoney(paid - Number(inv.total));
      if (!(excess > 0.001)) continue;
      const creditPays = nonVoid
        .filter((p: any) => p.method === "CREDIT_NOTE" && p.creditNoteId)
        .sort(
          (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      for (const p of creditPays) {
        if (!(excess > 0.001)) break;
        const restored = await this.restoreCreditFromPaymentInTx(tx, p, excess);
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
    }

    // (b) apply — reads the in-memory `invoices`/`intent.creditNote` snapshot, which
    // pass (a) folded its restore deltas into, so consumption figures are current.
    const now = new Date();
    for (const intent of intents) {
      const cn0 = intent.creditNote;
      if (!cn0 || cn0.status === "VOID") continue;
      if (cn0.expiresAt && new Date(cn0.expiresAt) <= now) continue;
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
        // Fresh reads — earlier loop iterations move money.
        const cn = await tx.creditNote.findUnique({ where: { id: intent.creditNoteId } });
        const freshInv = await tx.invoice.findUnique({
          where: { id: inv.id },
          include: { payments: true },
        });
        if (!cn || !freshInv) break;
        const res = await this.applyCreditInTx(tx, cn, freshInv, unmet, { tenantId });
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
  async unapplyFromInvoice(creditNoteId: string, invoiceId: string) {
    return this.prisma.tenantTransaction(
      async (tx: any) => {
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

        let restored = 0;
        for (const p of payments) {
          restored = roundMoney(restored + (await this.restoreCreditFromPaymentInTx(tx, p)));
        }

        const invoice = await tx.invoice.findUnique({
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
    );
  }

  /**
   * Edits a credit note's descriptive `reason` (any status — it's just text that
   * renders via the relation everywhere the credit is shown) and/or `expiresAt`
   * (ISSUED only — an applied/void credit's expiry is no longer meaningful).
   */
  async updateCreditNote(id: string, dto: { reason?: string; expiresAt?: string | null }) {
    const cn = await this.prisma.forTenant().creditNote.findUnique({ where: { id } });
    if (!cn) throw new NotFoundException("Credit note not found");

    const data: any = {};
    if (dto.reason !== undefined) data.reason = dto.reason;
    if (dto.expiresAt !== undefined) {
      if (cn.status !== "ISSUED")
        throw new BadRequestException(
          "expiresAt can only be changed while the credit note is ISSUED",
        );
      if (dto.expiresAt === null) {
        data.expiresAt = null;
      } else {
        const expiresAt = new Date(dto.expiresAt);
        if (isNaN(expiresAt.getTime()))
          throw new BadRequestException("expiresAt must be a valid ISO date");
        data.expiresAt = expiresAt;
      }
    }

    return this.prisma.forTenant().creditNote.update({ where: { id }, data });
  }
}

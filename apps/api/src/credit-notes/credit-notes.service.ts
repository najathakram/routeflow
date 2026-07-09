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
  }) {
    if (!dto.amount || dto.amount <= 0)
      throw new BadRequestException("Amount must be greater than 0");

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
              if (amt > lineSubtotal + 0.001)
                throw new BadRequestException(
                  `Credit line amount (${amt}) exceeds invoice line subtotal (${lineSubtotal})`,
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

  async applyToInvoice(creditNoteId: string, invoiceId: string, amount?: number) {
    return this.prisma.tenantTransaction(
      async (tx) => {
        const cn = await tx.creditNote.findUnique({ where: { id: creditNoteId } });
        if (!cn || cn.status === "APPLIED" || cn.status === "VOID")
          throw new BadRequestException("Credit note is not available for application");

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

        const alreadyPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        const invoiceBalance = Number(inv.total) - alreadyPaid;
        const cnRemaining = Number(cn.amount) - Number(cn.amountUsed);
        const applyAmount = Math.min(cnRemaining, invoiceBalance, amount ?? Infinity);

        if (applyAmount <= 0.001)
          throw new BadRequestException(
            "Credit note has no remaining balance or invoice is fully paid",
          );

        // Create invoice payment record for the credit note
        await tx.invoicePayment.create({
          data: {
            invoiceId,
            amount: applyAmount,
            method: PaymentMethod.CREDIT_NOTE,
            creditNoteId: cn.id,
            reference: cn.creditNoteNumber,
          },
        });

        // Recompute invoice status
        const newPaid = alreadyPaid + applyAmount;
        const newStatus = this.recomputeStatus(newPaid, Number(inv.total), inv.dueDate, inv.status);
        const updatedInv = await tx.invoice.update({
          where: { id: invoiceId },
          data: { status: newStatus, paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null },
          include: {
            customer: { select: { id: true, businessName: true } },
            items: true,
            payments: { orderBy: { createdAt: "desc" } },
          },
        });

        // Update amountUsed; mark APPLIED only when fully exhausted
        const newAmountUsed = Number(cn.amountUsed) + applyAmount;
        const fullyApplied = newAmountUsed >= Number(cn.amount) - 0.001;
        await tx.creditNote.update({
          where: { id: creditNoteId },
          data: {
            amountUsed: newAmountUsed,
            status: fullyApplied ? "APPLIED" : "ISSUED",
            appliedToInvoiceId: fullyApplied ? invoiceId : cn.appliedToInvoiceId,
          },
        });

        return updatedInv;
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
}

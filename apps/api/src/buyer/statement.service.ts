import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { monthRange, periodBucketOf } from "../regulated/period";
import { roundMoney } from "../common/pricing";

/** Strict "YYYY-MM" — anything else is a 400 before any query runs. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Payment methods that are credit APPLICATIONS (P5-13), not cash-like tender.
 * A credit-note or advance application is itself an InvoicePayment row, so the
 * month's non-VOID payment rows ALREADY contain them — the statement splits
 * them into the `credits` bucket so nothing is ever double-counted.
 */
const CREDIT_METHODS = ["CREDIT_NOTE", "ADVANCE"] as const;

export interface StatementLineItem {
  date: string;
  type: "INVOICE" | "PAYMENT" | "CREDIT";
  description: string;
  reference: string;
  /** Signed, roundMoney'd: charges positive, payments/credits negative. */
  amount: number;
}

export interface MonthlyStatement {
  period: { month: string; from: string; to: string; label: string };
  customer: { id: string; businessName: string };
  opening: number;
  charges: number;
  payments: number;
  credits: number;
  /** Residual making opening+charges−payments−credits+adjustments=closing EXACT. 0 when |x|<0.005. */
  adjustments: number;
  /** Net receivable at period end — computed INDEPENDENTLY (ground truth). */
  closing: number;
  availableCredit: number;
  lineItems: StatementLineItem[];
}

@Injectable()
export class StatementService {
  constructor(private readonly prisma: PrismaService) {}

  async buildMonthlyStatement(
    customerId: string,
    month: string,
    now: Date = new Date(),
  ): Promise<MonthlyStatement> {
    if (!MONTH_RE.test(month)) {
      throw new BadRequestException("month must be formatted YYYY-MM");
    }
    const { from, to } = monthRange(month);
    const db = this.prisma.forTenant();

    const [customer, invoices, monthPayments, creditNotes] = await Promise.all([
      db.customer.findUnique({
        where: { id: customerId },
        select: { id: true, businessName: true },
      }),
      db.invoice.findMany({
        where: {
          customerId,
          status: { notIn: ["DRAFT", "VOID"] },
          issueDate: { lt: to },
        },
        orderBy: { issueDate: "asc" },
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          status: true,
          issueDate: true,
          payments: { select: { amount: true, paidAt: true, status: true, method: true } },
        },
      }),
      db.invoicePayment.findMany({
        where: {
          invoice: { customerId },
          status: { not: "VOID" },
          paidAt: { gte: from, lt: to },
        },
        orderBy: { paidAt: "asc" },
        select: {
          id: true,
          amount: true,
          method: true,
          reference: true,
          paidAt: true,
          invoice: { select: { invoiceNumber: true } },
        },
      }),
      db.creditNote.findMany({
        where: { customerId },
        select: { amount: true, amountUsed: true, status: true, expiresAt: true },
      }),
    ]);
    if (!customer) throw new NotFoundException("Customer not found");

    // Net receivable at a boundary — getStatementForOperator.outstandingAmount
    // semantics (customers.service.ts:642-644) with the VOID payment filter
    // added and time bounds applied.
    const receivableAt = (boundary: Date): number =>
      roundMoney(
        invoices
          .filter((inv) => inv.status !== "WRITTEN_OFF" && inv.issueDate < boundary)
          .reduce((sum, inv) => {
            const paid = inv.payments
              .filter((p) => p.status !== "VOID" && p.paidAt < boundary)
              .reduce((s, p) => s + Number(p.amount), 0);
            return sum + roundMoney(Number(inv.total) - paid);
          }, 0),
      );

    const opening = receivableAt(from);
    const closing = receivableAt(to);

    const monthInvoices = invoices.filter((inv) => inv.issueDate >= from);
    const charges = roundMoney(monthInvoices.reduce((s, inv) => s + Number(inv.total), 0));

    const isCredit = (method: string) => (CREDIT_METHODS as readonly string[]).includes(method);
    const paymentRows = monthPayments.filter((p) => !isCredit(p.method));
    const creditRows = monthPayments.filter((p) => isCredit(p.method));
    const payments = roundMoney(paymentRows.reduce((s, p) => s + Number(p.amount), 0));
    const credits = roundMoney(creditRows.reduce((s, p) => s + Number(p.amount), 0));

    let adjustments = roundMoney(closing - (opening + charges - payments - credits));
    if (Math.abs(adjustments) < 0.005) adjustments = 0;

    const availableCredit = roundMoney(
      creditNotes
        .filter(
          (c) =>
            c.status !== "VOID" &&
            Number(c.amount) - Number(c.amountUsed) > 0.001 &&
            (!c.expiresAt || new Date(c.expiresAt) > now),
        )
        .reduce((sum, c) => sum + roundMoney(Number(c.amount) - Number(c.amountUsed)), 0),
    );

    const lineItems: StatementLineItem[] = [
      ...monthInvoices.map((inv) => ({
        date: inv.issueDate.toISOString(),
        type: "INVOICE" as const,
        description: `Invoice #${inv.invoiceNumber}${
          inv.status === "WRITTEN_OFF" ? " (written off)" : ""
        }`,
        reference: inv.invoiceNumber,
        amount: roundMoney(Number(inv.total)),
      })),
      ...paymentRows.map((p) => ({
        date: p.paidAt.toISOString(),
        type: "PAYMENT" as const,
        description: `Payment — ${p.method}${p.reference ? ` (${p.reference})` : ""} on #${
          p.invoice.invoiceNumber
        }`,
        reference: p.invoice.invoiceNumber,
        amount: roundMoney(-Number(p.amount)),
      })),
      ...creditRows.map((p) => ({
        date: p.paidAt.toISOString(),
        type: "CREDIT" as const,
        description: `${p.method === "ADVANCE" ? "Advance applied" : "Credit applied"} to #${
          p.invoice.invoiceNumber
        }`,
        reference: p.invoice.invoiceNumber,
        amount: roundMoney(-Number(p.amount)),
      })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const label = from.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    return {
      period: { month, from: from.toISOString(), to: to.toISOString(), label },
      customer: { id: customer.id, businessName: customer.businessName },
      opening,
      charges,
      payments,
      credits,
      adjustments,
      closing,
      availableCredit,
      lineItems,
    };
  }

  /** Month buckets back to the customer's earliest non-DRAFT/VOID invoice, ≤12, newest first. */
  async listAvailableMonths(
    customerId: string,
    now: Date = new Date(),
  ): Promise<{ months: string[] }> {
    const earliest = await this.prisma.forTenant().invoice.findFirst({
      where: { customerId, status: { notIn: ["DRAFT", "VOID"] } },
      orderBy: { issueDate: "asc" },
      select: { issueDate: true },
    });
    if (!earliest) return { months: [] };

    const firstBucket = periodBucketOf(earliest.issueDate);
    const months: string[] = [];
    let y = now.getUTCFullYear();
    let m = now.getUTCMonth() + 1;
    for (let i = 0; i < 12; i++) {
      const bucket = `${y}-${String(m).padStart(2, "0")}`;
      if (bucket < firstBucket) break;
      months.push(bucket);
      m -= 1;
      if (m === 0) {
        m = 12;
        y -= 1;
      }
    }
    return { months };
  }
}

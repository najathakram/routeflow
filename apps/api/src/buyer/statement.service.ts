import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { monthRange, periodBucketOf } from "../regulated/period";
import { roundMoney } from "@routeflow/pricing";
import {
  ADVANCE_METHOD,
  collectedDateOf,
  CONFIRMED_PAYMENT,
  CREDIT_NOTE_METHOD,
  splitConfirmed,
  sumConfirmed,
} from "../invoices/payment-predicates";
import { settledDateFilter } from "../invoices/settled-date-filter";

/** Strict "YYYY-MM" — anything else is a 400 before any query runs. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Payment methods that are credit APPLICATIONS (P5-13), not cash-like tender.
 * A credit-note or advance application is itself an InvoicePayment row, so the
 * month's CONFIRMED payment rows ALREADY contain them — the statement splits
 * them into the `credits` bucket so nothing is ever double-counted.
 *
 * B421: sourced from the shared `@routeflow/pricing` constants (never a
 * second, locally-declared method list — that drift is exactly how B421
 * happened elsewhere) via `isCredit`, below. The two figures this produces
 * (`payments`/`credits`) are pinned equal to `splitConfirmed`'s
 * `cash`/`creditApplied + advanceApplied` over the SAME array by a spec —
 * this file still needs the filtered ROW arrays for line items, which
 * `splitConfirmed` (aggregate-only) doesn't return, so the partition stays
 * local while the classification itself does not.
 */
const isCredit = (method: string) => method === CREDIT_NOTE_METHOD || method === ADVANCE_METHOD;

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
      db.customer.findFirst({
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
          payments: {
            select: { amount: true, paidAt: true, settledAt: true, status: true, method: true },
          },
        },
      }),
      // F03/R1: the statement's payment + credit activity is a SUMMING read —
      // every row here lands in the `payments`/`credits` totals AND as a signed
      // line item, and StatementLineItem has no status to render a "pending"
      // label with. So it narrows to CONFIRMED (PAID) rows, exactly like the
      // invoice PDF's totalPaid and the reminder email: a DRAFT (unconfirmed)
      // payment must not tell a customer their balance dropped.
      db.invoicePayment.findMany({
        where: {
          invoice: { customerId },
          ...CONFIRMED_PAYMENT,
          // check-payments PR-2b (M2): a payment lands in this month's
          // statement on its collected date (settledAt ?? paidAt), same
          // basis as getCashFlow/getSummary — never the raw paidAt alone.
          ...settledDateFilter({ gte: from, lt: to }),
        },
        orderBy: { paidAt: "asc" },
        select: {
          id: true,
          amount: true,
          method: true,
          // B421: the `where` above already guarantees every row is PAID, but
          // `splitConfirmed` re-checks `status` generically (it's a shared
          // helper with no knowledge of this query's own filter) — without
          // this field every row silently fails that check and the whole
          // statement reports $0 payments/credits.
          status: true,
          reference: true,
          paidAt: true,
          settledAt: true,
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
    // semantics (customers.service.ts:642-644) with the CONFIRMED payment basis
    // (F03/R1 — DRAFT and VOID rows both excluded) and time bounds applied.
    const receivableAt = (boundary: Date): number =>
      roundMoney(
        invoices
          .filter((inv) => inv.status !== "WRITTEN_OFF" && inv.issueDate < boundary)
          .reduce((sum, inv) => {
            // check-payments PR-2b (M2): a payment has reduced the balance as
            // of its collected date (settledAt ?? paidAt), not its paidAt.
            const paid = sumConfirmed(
              inv.payments.filter((p) => (collectedDateOf(p) as Date) < boundary),
            );
            return sum + roundMoney(Number(inv.total) - paid);
          }, 0),
      );

    const opening = receivableAt(from);
    const closing = receivableAt(to);

    const monthInvoices = invoices.filter((inv) => inv.issueDate >= from);
    const charges = roundMoney(monthInvoices.reduce((s, inv) => s + Number(inv.total), 0));

    const paymentRows = monthPayments.filter((p) => !isCredit(p.method));
    const creditRows = monthPayments.filter((p) => isCredit(p.method));
    // B421: derived from the SAME shared helper every other surface uses,
    // never a second re-filter of monthPayments — mathematically guaranteed
    // equal to a reduce over paymentRows/creditRows above (both partition
    // the identical already-CONFIRMED array by the identical method check),
    // pinned by statement.service.spec.ts.
    const { cash, creditApplied, advanceApplied } = splitConfirmed(monthPayments);
    const payments = roundMoney(cash);
    const credits = roundMoney(creditApplied + advanceApplied);

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
        date: (collectedDateOf(p) as Date).toISOString(),
        type: "PAYMENT" as const,
        description: `Payment — ${p.method}${p.reference ? ` (${p.reference})` : ""} on #${
          p.invoice.invoiceNumber
        }`,
        reference: p.invoice.invoiceNumber,
        amount: roundMoney(-Number(p.amount)),
      })),
      ...creditRows.map((p) => ({
        date: (collectedDateOf(p) as Date).toISOString(),
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

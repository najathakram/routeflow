import { roundMoney } from "@routeflow/pricing";
import type { AccountStatement } from "@routeflow/types";
import { fmtPdfDate } from "../common/pdf-date";

/**
 * SA-1078 (W-1096) PR-3: everything the printable "Open balance" statement says, as plain strings, built from the
 * server's `AccountStatement` and nothing else. The template (`account-statement-pdf-template.tsx`) only lays these out,
 * so the words and figures are testable under Jest (which cannot load react-pdf) and no figure is ever re-derived.
 */

export const fmtMoney = (n: number): string => `$${roundMoney(Math.abs(n)).toFixed(2)}`;
const dayOf = (day: string): string => fmtPdfDate(`${day}T00:00:00.000Z`);

/** What a stored method prints as. An unknown future method reads as "Payment", never as its raw code. */
const METHOD_WORDS: Record<string, string> = {
  CASH: "Cash",
  CHECK: "Check",
  ZELLE: "Zelle",
  ACH: "Bank transfer",
  CREDIT_CARD: "Credit card",
  OTHER: "Payment",
  CREDIT_NOTE: "Credit note",
  ADVANCE: "Advance",
};
export const methodWords = (method: string): string => METHOD_WORDS[method] ?? "Payment";

export const daysLateWords = (days: number): string =>
  `${days} ${days === 1 ? "day" : "days"} late`;

export type Tone = "danger" | "success" | "plain";

export interface PdfSummaryLine {
  label: string;
  value: string;
  tone: Tone;
}
export interface PdfInvoiceRow {
  key: string;
  invoice: string;
  due: string;
  /** null when not late */
  late: string | null;
  total: string;
  paid: string;
  credit: string;
  unpaid: string;
}
export interface PdfPaymentRow {
  key: string;
  date: string;
  what: string;
  amount: string;
}
export interface PdfCreditRow {
  key: string;
  date: string;
  what: string;
  amount: string;
}
export interface AccountStatementPdfModel {
  title: string;
  asOfLabel: string;
  customerName: string;
  summary: PdfSummaryLine[];
  /** the Credit column exists only when some row has credit applied */
  showCreditColumn: boolean;
  invoices: PdfInvoiceRow[];
  payments: PdfPaymentRow[];
  paymentsNote: string | null;
  credits: PdfCreditRow[];
  foot: { label: string; value: string };
}

export function buildAccountStatementPdfModel(s: AccountStatement): AccountStatementPdfModel {
  const summary: PdfSummaryLine[] = [
    {
      label: "Open balance",
      value: fmtMoney(s.openBalance),
      tone: s.openBalance > 0 ? "danger" : "success",
    },
  ];
  if (s.overdue > 0) summary.push({ label: "Overdue", value: fmtMoney(s.overdue), tone: "danger" });
  if (s.creditAvailable > 0) {
    summary.push({
      label: "Credit available",
      value: fmtMoney(s.creditAvailable),
      tone: "success",
    });
    summary.push({ label: "After credit", value: fmtMoney(s.afterCredit), tone: "plain" });
  }
  if (s.waitingToClear > 0) {
    summary.push({ label: "Waiting to clear", value: fmtMoney(s.waitingToClear), tone: "plain" });
  }

  return {
    title: `Statement as of ${dayOf(s.asOf)} — ${s.customer.businessName}`,
    asOfLabel: `As of ${dayOf(s.asOf)}`,
    customerName: s.customer.businessName,
    summary,
    showCreditColumn: s.openInvoices.some((i) => i.credit > 0),
    invoices: s.openInvoices.map((i) => ({
      key: i.id,
      invoice: i.invoiceNumber,
      due: i.dueDate ? fmtPdfDate(i.dueDate) : "—",
      late: i.daysLate > 0 ? daysLateWords(i.daysLate) : null,
      total: fmtMoney(i.total),
      paid: fmtMoney(i.paid),
      credit: fmtMoney(i.credit),
      unpaid: fmtMoney(i.unpaid),
    })),
    payments: s.recentPayments.map((p, idx) => ({
      key: `${p.date}-${p.invoiceNumber}-${idx}`,
      date: fmtPdfDate(p.date),
      what: [methodWords(p.method), p.reference, `Invoice ${p.invoiceNumber}`]
        .filter(Boolean)
        .join(" · "),
      amount: fmtMoney(p.amount),
    })),
    paymentsNote: s.recentPaymentsTruncated
      ? `The latest ${s.recentPayments.length} payments are shown.`
      : null,
    credits: s.credits.map((c) => ({
      key: c.id,
      date: fmtPdfDate(c.date),
      what: [
        c.kind === "ADVANCE" ? "Advance" : "Credit note",
        c.number,
        c.reason,
        c.expiresAt ? `Expires ${fmtPdfDate(c.expiresAt)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      amount: fmtMoney(c.remaining),
    })),
    foot: { label: "Open balance", value: fmtMoney(s.openBalance) },
  };
}

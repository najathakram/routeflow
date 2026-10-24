import { NotFoundException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";
import {
  CONFIRMED_PAYMENT,
  RECEIVED_METHOD_FILTER,
  sumConfirmed,
} from "../invoices/payment-predicates";
import { KPI_SUMMARY_EXCLUDED, LIFETIME_INVOICED_EXCLUDED } from "../invoices/invoice-status-sets";
import { loadCreditExposure, OPEN_ORDER_STATUSES } from "../invoices/credit-exposure";
import {
  classifyInvoiceBalance,
  type ClassifiableInvoice,
} from "../invoices/invoice-balance-classify";
import { overdueCutoff } from "../common/calendar-date";
import { tenantTimeZone } from "../common/tenant-time-zone";

/**
 * The customer statement builds, moved verbatim out of `CustomersService` (size-ratchet headroom, no
 * behaviour change): the buyer's own statement (`getMyStatement`) and the operator's
 * (`getStatementForOperator`). Both take the Prisma service by parameter and read through
 * `prisma.forTenant()` exactly as the service methods did; the service methods keep their public
 * signatures and delegate here (the operator route resolves the customer first, in the service).
 */

/**
 * Row 309 (SA-770 "one predicate"): the statement's overdue figure = Σ the POSITIVE balance of every open
 * invoice the one classifier calls overdue: a balance is due AND the due DAY has ended in the statement's
 * own tenant zone (RF-202: an invoice due today is NOT overdue; UTC when the tenant has no zone). The zone
 * is resolved ONCE per statement by the caller. Each contribution is the classifier's
 * clamped balance (max(0, roundMoney(total - confirmed))), so an overpaid open invoice adds 0.
 */
function statementOverdueAmount(
  open: ReadonlyArray<ClassifiableInvoice>,
  timeZone: string | null,
): number {
  const cutoff = overdueCutoff(new Date(), timeZone);
  let sum = 0;
  for (const inv of open) {
    const { balanceDue, isOverdue } = classifyInvoiceBalance(inv, cutoff);
    if (isOverdue) sum += balanceDue;
  }
  return roundMoney(sum);
}

/** The buyer's own statement: outstanding / overdue / credit / lifetime figures + the capped ledger. */
export async function buildMyStatement(prisma: PrismaService, user: JwtPayload) {
  const customer = await prisma.forTenant().customer.findFirst({ where: { userId: user.sub } });
  if (!customer) throw new NotFoundException("Customer profile not found");

  const INVOICE_SELECT = {
    id: true,
    invoiceNumber: true,
    total: true,
    status: true,
    dueDate: true,
    createdAt: true,
    payments: { select: { amount: true, status: true } },
  } as const;
  const CREDIT_NOTE_SELECT = {
    id: true,
    creditNoteNumber: true,
    amount: true,
    status: true,
    createdAt: true,
    amountUsed: true,
    expiresAt: true,
  } as const;
  // REG-B110: the LEDGER caps below are for the transactions DISPLAY only —
  // the money figures (outstanding/overdue/availableCredit) are computed
  // from the separate, uncapped OPEN-set reads further down, never from a
  // take-capped page.
  const LEDGER_INVOICE_CAP = 50;
  const LEDGER_CREDIT_NOTE_CAP = 50;

  const [
    openInvoices,
    ledgerInvoicesRaw,
    openCreditNotes,
    ledgerCreditNotesRaw,
    lifetimeInvoicedAgg,
    lifetimeReceivedAgg,
  ] = await Promise.all([
    prisma.forTenant().invoice.findMany({
      // DRAFT is excluded with the settled/dead/forgiven statuses: a
      // not-yet-issued invoice is not receivable, so it must not inflate
      // outstanding/overdue. Same set as the invoices KPI summary (and the
      // Invoices-tab card's former client-side filter).
      where: { customerId: customer.id, status: { notIn: KPI_SUMMARY_EXCLUDED } },
      select: INVOICE_SELECT,
    }),
    prisma.forTenant().invoice.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: "desc" },
      take: LEDGER_INVOICE_CAP + 1,
      select: INVOICE_SELECT,
    }),
    prisma.forTenant().creditNote.findMany({
      where: { customerId: customer.id, status: { not: "VOID" } },
      select: CREDIT_NOTE_SELECT,
    }),
    prisma.forTenant().creditNote.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: "desc" },
      take: LEDGER_CREDIT_NOTE_CAP + 1,
      select: CREDIT_NOTE_SELECT,
    }),
    // M1 — lifetime "Invoiced Amount" / "Amount Received", summed by the
    // DATABASE over the buyer's whole history (never a reduce over the
    // take-capped ledger below, which under-reports past one page).
    prisma.forTenant().invoice.aggregate({
      _sum: { total: true },
      // DRAFT was never issued and VOID was cancelled — neither was billed.
      where: { customerId: customer.id, status: { notIn: LIFETIME_INVOICED_EXCLUDED } },
    }),
    prisma.forTenant().invoicePayment.aggregate({
      _sum: { amount: true },
      // B421: feeds `lifetimeReceived` below — "money genuinely received",
      // so CREDIT_NOTE is excluded (never cash) but ADVANCE stays (an
      // advance application is the only place that already-real cash is
      // ever recorded — see RECEIVED_METHOD_FILTER's own doc).
      where: {
        ...CONFIRMED_PAYMENT,
        method: RECEIVED_METHOD_FILTER,
        invoice: { customerId: customer.id },
      },
    }),
  ]);

  // Each ledger read asks for one row MORE than its cap; a read that comes
  // back over the cap is the proof that rows were left behind. The extra row
  // is sliced off before the ledger is built.
  const invoicesTruncated = ledgerInvoicesRaw.length > LEDGER_INVOICE_CAP;
  const creditNotesTruncated = ledgerCreditNotesRaw.length > LEDGER_CREDIT_NOTE_CAP;
  const ledgerInvoices = ledgerInvoicesRaw.slice(0, LEDGER_INVOICE_CAP);
  const ledgerCreditNotes = ledgerCreditNotesRaw.slice(0, LEDGER_CREDIT_NOTE_CAP);

  // CONFIRMED (PAID) basis — a DRAFT (unconfirmed) payment must never count
  // as paid (F03/sumConfirmed); VOID (e.g. a bounced check, P5-12) already
  // doesn't. B421: `amountPaid` here is NEVER returned to the client — it
  // only feeds `total - amountPaid` (outstanding/runningBalance below), so
  // it deliberately stays the FULL confirmed total (sumConfirmed, not
  // splitConfirmed's cash-only figure): a credit note or advance genuinely
  // reduces what's outstanding on this invoice, same basis as
  // invoices.service.ts's own balanceDue.
  const withPaid = <T extends { payments: { amount: unknown; status: string }[] }>(rows: T[]) =>
    rows.map((i) => ({ ...i, amountPaid: sumConfirmed(i.payments) }));

  const openInvoicesWithPaid = withPaid(openInvoices);
  const ledgerInvoicesWithPaid = withPaid(ledgerInvoices);

  // H2: every money figure this statement returns is rounded to cents —
  // a float reduce over many invoices leaks binary-float dust
  // (0.1 + 0.2 = 0.30000000000000004) straight into the UI.
  const outstanding = roundMoney(
    openInvoicesWithPaid.reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0),
  );

  const overdue = statementOverdueAmount(openInvoicesWithPaid, await tenantTimeZone(prisma));

  // P5-13: wallet = Σ remaining over OPEN, non-expired credits. amount − amountUsed
  // (not face amount) prevents the double-count — a partial credit already sits on
  // the invoice as a CREDIT_NOTE payment, so only its unused remainder appears here.
  const now = new Date();
  const availableCredit = roundMoney(
    openCreditNotes
      .filter(
        (c) =>
          c.status !== "VOID" &&
          Number(c.amount) - Number(c.amountUsed) > 0.001 &&
          (!c.expiresAt || new Date(c.expiresAt) > now),
      )
      .reduce((sum, c) => sum + roundMoney(Number(c.amount) - Number(c.amountUsed)), 0),
  );

  // True whenever the transactions ledger below is a partial view of the
  // customer's full history (the ledger reads ALL statuses, capped) —
  // derived from the ledger read itself, never from the open-set size.
  // Read by the customer statement ledgers on web and mobile, which render a
  // partial-view line above the ledger when it is true and nothing when it is
  // false (LedgerTruncationNote on web, the mobile statement screen's line).
  const transactionsTruncated = invoicesTruncated || creditNotesTruncated;

  // Aggregate over an empty set returns a NULL sum — `?? 0` so a brand-new
  // buyer reads $0.00, never NaN.
  const lifetimeInvoiced = roundMoney(Number(lifetimeInvoicedAgg?._sum?.total ?? 0));
  const lifetimeReceived = roundMoney(Number(lifetimeReceivedAgg?._sum?.amount ?? 0));

  const transactions = [
    ...ledgerInvoicesWithPaid.map((i) => ({
      type: "INVOICE" as const,
      id: i.id,
      description: `Invoice #${i.invoiceNumber}`,
      date: i.createdAt.toISOString(),
      amount: Number(i.total),
      runningBalance: -(Number(i.total) - i.amountPaid),
      status: i.status,
    })),
    ...ledgerCreditNotes.map((c) => {
      const expired = !!c.expiresAt && new Date(c.expiresAt) <= now;
      const remaining =
        c.status === "VOID" || expired ? 0 : roundMoney(Number(c.amount) - Number(c.amountUsed));
      return {
        type: "CREDIT_NOTE" as const,
        id: c.id,
        description: `Credit Note #${c.creditNoteNumber}`,
        date: c.createdAt.toISOString(),
        amount: -Number(c.amount),
        runningBalance: remaining > 0.001 ? remaining : 0,
        status: c.status,
        expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      };
    }),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    outstandingAmount: outstanding,
    overdueAmount: overdue,
    availableCredit,
    lifetimeInvoiced,
    lifetimeReceived,
    transactionsTruncated,
    transactions,
  };
}

/**
 * The operator statement body. `opts.includeExposure` (operator route only) adds
 * creditExposure/pendingExposure (D6 / B462); the keys are ABSENT otherwise.
 */
export async function buildOperatorStatement(
  prisma: PrismaService,
  customerId: string,
  opts?: { includeExposure?: boolean },
) {
  const INVOICE_SELECT = {
    id: true,
    invoiceNumber: true,
    total: true,
    status: true,
    dueDate: true,
    createdAt: true,
    payments: { select: { amount: true, status: true } },
  } as const;
  const CREDIT_NOTE_SELECT = {
    id: true,
    creditNoteNumber: true,
    amount: true,
    status: true,
    createdAt: true,
    amountUsed: true,
    expiresAt: true,
  } as const;
  const ADVANCE_PAYMENT_SELECT = {
    id: true,
    amount: true,
    balance: true,
    method: true,
    reference: true,
    receivedAt: true,
  } as const;
  // REG-B110: the LEDGER caps below are for the transactions DISPLAY only —
  // the money figures (outstanding/overdue/availableCredit/advanceBalance)
  // are computed from the separate, uncapped OPEN-set reads further down,
  // never from a take-capped page (a customer with >100 open invoices was
  // silently under-reported).
  const LEDGER_INVOICE_CAP = 100;
  const LEDGER_CREDIT_NOTE_CAP = 50;
  const LEDGER_ADVANCE_CAP = 50;

  const [
    openInvoices,
    ledgerInvoicesRaw,
    openCreditNotes,
    ledgerCreditNotesRaw,
    openAdvancePayments,
    ledgerAdvancePaymentsRaw,
    pendingOrders,
    lifetimeInvoicedAgg,
    lifetimeReceivedAgg,
    exposure,
  ] = await Promise.all([
    prisma.forTenant().invoice.findMany({
      // DRAFT is excluded with the settled/dead/forgiven statuses: a
      // not-yet-issued invoice is not receivable, so it must not inflate
      // outstanding/overdue. Same set as the invoices KPI summary (and the
      // Invoices-tab card's former client-side filter).
      where: { customerId, status: { notIn: KPI_SUMMARY_EXCLUDED } },
      select: INVOICE_SELECT,
    }),
    prisma.forTenant().invoice.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: LEDGER_INVOICE_CAP + 1,
      select: INVOICE_SELECT,
    }),
    prisma.forTenant().creditNote.findMany({
      where: { customerId, status: { not: "VOID" } },
      select: CREDIT_NOTE_SELECT,
    }),
    prisma.forTenant().creditNote.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: LEDGER_CREDIT_NOTE_CAP + 1,
      select: CREDIT_NOTE_SELECT,
    }),
    prisma.forTenant().advancePayment.findMany({
      where: { customerId, balance: { gt: 0 } },
      select: ADVANCE_PAYMENT_SELECT,
    }),
    prisma.forTenant().advancePayment.findMany({
      where: { customerId },
      orderBy: { receivedAt: "desc" },
      take: LEDGER_ADVANCE_CAP + 1,
      select: ADVANCE_PAYMENT_SELECT,
    }),
    // Pending / confirmed / out-for-delivery orders not yet invoiced
    prisma.forTenant().order.findMany({
      where: {
        customerId,
        // The same open set `loadCreditExposure` uses (B584): a new open status can't reach the
        // block but miss this tile.
        status: { in: OPEN_ORDER_STATUSES },
      },
      select: { id: true, total: true, orderNumber: true, status: true, createdAt: true },
    }),
    // M1 — the statement header's "Invoiced Amount" / "Amount Received"
    // tiles are LIFETIME figures over the customer's WHOLE history, so the
    // DATABASE sums them: a reduce over the take-capped `transactions`
    // ledger below under-reports every customer with more history than one
    // capped page holds, right beside the uncapped Outstanding/Overdue.
    // Aggregates — no rows materialised, no cap to out-grow.
    prisma.forTenant().invoice.aggregate({
      _sum: { total: true },
      // DRAFT was never issued and VOID was cancelled — neither was billed.
      // PAID/OVERDUE/WRITTEN_OFF are real past billings and DO belong here.
      where: { customerId, status: { notIn: LIFETIME_INVOICED_EXCLUDED } },
    }),
    prisma.forTenant().invoicePayment.aggregate({
      _sum: { amount: true },
      // B421: feeds `lifetimeReceived` below — "money genuinely received",
      // so CREDIT_NOTE is excluded (never cash) but ADVANCE stays (an
      // advance application is the only place that already-real cash is
      // ever recorded — see RECEIVED_METHOD_FILTER's own doc). A DRAFT
      // (unconfirmed) or VOID (bounced check) payment is not money
      // received either way, via CONFIRMED_PAYMENT.
      where: { ...CONFIRMED_PAYMENT, method: RECEIVED_METHOD_FILTER, invoice: { customerId } },
    }),
    // D6 / B462: operator-only exposure (the credit block's own derivation); null = not asked.
    opts?.includeExposure
      ? loadCreditExposure(prisma.forTenant(), customerId)
      : Promise.resolve(null),
  ]);

  // Each ledger read asks for one row MORE than its cap; a read that comes
  // back over the cap is the proof that rows were left behind. The extra row
  // is sliced off before the ledger is built.
  const invoicesTruncated = ledgerInvoicesRaw.length > LEDGER_INVOICE_CAP;
  const creditNotesTruncated = ledgerCreditNotesRaw.length > LEDGER_CREDIT_NOTE_CAP;
  const advancesTruncated = ledgerAdvancePaymentsRaw.length > LEDGER_ADVANCE_CAP;
  const ledgerInvoices = ledgerInvoicesRaw.slice(0, LEDGER_INVOICE_CAP);
  const ledgerCreditNotes = ledgerCreditNotesRaw.slice(0, LEDGER_CREDIT_NOTE_CAP);
  const ledgerAdvancePayments = ledgerAdvancePaymentsRaw.slice(0, LEDGER_ADVANCE_CAP);

  // CONFIRMED (PAID) basis — a DRAFT (unconfirmed) payment must never count
  // as paid (F03/sumConfirmed); VOID (e.g. a bounced check, P5-12) already
  // doesn't. B421: `amountPaid` here is NEVER returned to the client — it
  // only feeds `total - amountPaid` (outstanding/runningBalance below), so
  // it deliberately stays the FULL confirmed total (sumConfirmed, not
  // splitConfirmed's cash-only figure): a credit note or advance genuinely
  // reduces what's outstanding on this invoice, same basis as
  // invoices.service.ts's own balanceDue.
  const withPaid = <T extends { payments: { amount: unknown; status: string }[] }>(rows: T[]) =>
    rows.map((i) => ({ ...i, amountPaid: sumConfirmed(i.payments) }));

  const openInvoicesWithPaid = withPaid(openInvoices);
  const ledgerInvoicesWithPaid = withPaid(ledgerInvoices);

  // H2: every money figure this statement returns is rounded to cents —
  // a float reduce over many invoices leaks binary-float dust
  // (0.1 + 0.2 = 0.30000000000000004) straight into the UI.
  const outstanding = roundMoney(
    openInvoicesWithPaid.reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0),
  );

  const overdue = statementOverdueAmount(openInvoicesWithPaid, await tenantTimeZone(prisma));

  // P5-13: wallet = Σ remaining over OPEN, non-expired credits. amount − amountUsed
  // (not face amount) prevents the double-count — a partial credit already sits on
  // the invoice as a CREDIT_NOTE payment, so only its unused remainder appears here.
  const now = new Date();
  const availableCredit = roundMoney(
    openCreditNotes
      .filter(
        (c) =>
          c.status !== "VOID" &&
          Number(c.amount) - Number(c.amountUsed) > 0.001 &&
          (!c.expiresAt || new Date(c.expiresAt) > now),
      )
      .reduce((sum, c) => sum + roundMoney(Number(c.amount) - Number(c.amountUsed)), 0),
  );

  const advanceBalance = roundMoney(
    openAdvancePayments.reduce((sum, a) => sum + Number(a.balance), 0),
  );

  const pendingOrdersAmount = roundMoney(
    pendingOrders.reduce((sum, o) => sum + Number(o.total), 0),
  );

  // Aggregate over an empty set returns a NULL sum — `?? 0` so an untouched
  // customer reads $0.00, never NaN.
  const lifetimeInvoiced = roundMoney(Number(lifetimeInvoicedAgg?._sum?.total ?? 0));
  const lifetimeReceived = roundMoney(Number(lifetimeReceivedAgg?._sum?.amount ?? 0));

  // True whenever the transactions ledger below is a partial view of the
  // customer's full history (the ledger reads ALL statuses, capped) —
  // derived from the ledger read itself, never from the open-set size.
  // Read by the customer statement ledgers on web and mobile, which render a
  // partial-view line above the ledger when it is true and nothing when it is
  // false (LedgerTruncationNote on web, the mobile statement screen's line).
  const transactionsTruncated = invoicesTruncated || creditNotesTruncated || advancesTruncated;

  const transactions = [
    ...ledgerInvoicesWithPaid.map((i) => ({
      type: "INVOICE" as const,
      id: i.id,
      description: `Invoice #${i.invoiceNumber}`,
      date: i.createdAt.toISOString(),
      amount: Number(i.total),
      runningBalance: -(Number(i.total) - i.amountPaid),
      status: i.status,
    })),
    ...ledgerCreditNotes.map((c) => {
      const expired = !!c.expiresAt && new Date(c.expiresAt) <= now;
      const remaining =
        c.status === "VOID" || expired ? 0 : roundMoney(Number(c.amount) - Number(c.amountUsed));
      return {
        type: "CREDIT_NOTE" as const,
        id: c.id,
        description: `Credit Note #${c.creditNoteNumber}`,
        date: c.createdAt.toISOString(),
        amount: -Number(c.amount),
        runningBalance: remaining > 0.001 ? remaining : 0,
        status: c.status,
        expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      };
    }),
    ...ledgerAdvancePayments.map((a) => ({
      type: "ADVANCE_PAYMENT" as const,
      id: a.id,
      description: `Advance Payment${a.reference ? ` (${a.reference})` : ""}`,
      date: a.receivedAt.toISOString(),
      amount: Number(a.amount),
      runningBalance: Number(a.balance),
      status: Number(a.balance) > 0 ? "AVAILABLE" : "USED",
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    outstandingAmount: outstanding,
    overdueAmount: overdue,
    availableCredit,
    advanceBalance,
    pendingOrdersAmount,
    lifetimeInvoiced,
    lifetimeReceived,
    transactionsTruncated,
    transactions,
    ...(exposure
      ? {
          creditExposure: roundMoney(exposure.counted),
          pendingExposure: roundMoney(exposure.pendingExposure),
        }
      : {}),
  };
}

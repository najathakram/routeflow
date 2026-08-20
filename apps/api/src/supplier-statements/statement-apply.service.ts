import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PaymentMethod } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "../common/pricing";
import { normalizeInvoiceNumber } from "../import/duplicate-match.service";
import {
  matchStatementLines,
  type MatchableBill,
  type StatementLineMatch,
} from "./statement-matcher";
import type { ParsedStatementLine } from "./dto/statement.dto";

/** House convention (CLAUDE.md): cents-level rounding noise on a stored balance. */
const BALANCE_EPSILON = 0.001;
/**
 * The window `statement-matcher.ts` (WP2) uses to call an amount a match for
 * a statement line — reused here so a re-derived cap agrees with the tier the
 * review screen showed the operator, rather than drifting from it.
 */
const LINE_AMOUNT_EPSILON = 0.005;

/** One bill the operator confirmed paying off this statement, and how much. */
export interface ApplyStatementConfirmedLine {
  billId: string;
  amount: number;
  /**
   * Index into the scan's parsed `lines` of the row the operator was looking
   * at when they picked this bill — the review screen's candidate picker
   * offers EVERY candidate on a line, not just the matcher's suggestion, so
   * the bill alone doesn't identify which line backs it. Optional: without it
   * the bill's own primary-pick line is used, falling back to the first line
   * that lists it as a candidate.
   */
  lineIndex?: number;
}

/**
 * Older, local bills this statement doesn't mention at all, that the operator
 * has separately decided to mark paid because the statement's opening balance
 * implies they were settled. Kept fully separate from `confirmed` — see
 * `applyStatement` below and the review screen's own second confirmation.
 */
export interface ApplyStatementImpliedPaid {
  billIds: string[];
}

export interface ApplyStatementDto {
  confirmed: ApplyStatementConfirmedLine[];
  impliedPaid?: ApplyStatementImpliedPaid;
  notes?: string;
}

/** One `BillPayment` this apply wrote (confirmed or implied-paid alike). */
export interface AppliedStatementPayment {
  id: string;
  vendorBillId: string;
  amount: number;
}

/**
 * The wire shape the review screen (`apps/web/lib/api/supplier-statements.ts`,
 * WP4) already declares and calls `POST /supplier-statements/:id/apply`
 * expecting back — kept field-for-field identical to
 * `VendorBillsService.recordSupplierPayment`'s own return shape (`excess`,
 * not `surplus`), since WP3 mirrors that method's mechanics throughout.
 */
export interface ApplyStatementResult {
  paymentGroupId: string | null;
  payments: AppliedStatementPayment[];
  /**
   * Overpayment banked as on-account `SupplierCredit`. **Always 0 on this
   * flow** — kept only so the wire shape stays identical to
   * `recordSupplierPayment`'s. There is no cash total on `ApplyStatementDto`
   * to overshoot: every confirmed amount is capped at the bill's own
   * outstanding balance, so a surplus is impossible here by construction.
   * (The gap between a statement LINE and the confirmed amount is not
   * surplus cash — it is an accounting discrepancy, and minting credit from
   * it would invent money the operator never paid.)
   */
  excess: number;
  bills: { id: string; status: string; totalPaid: number }[];
  /** True when this scan was already `APPLIED` — nothing was written this call. */
  alreadyApplied: boolean;
}

/**
 * The one Apply transaction for a reconciled supplier statement (PR-F, WP3).
 * Mirrors `VendorBillsService.recordSupplierPayment` (PR-E) closely: one
 * `BillPayment` per bill, all sharing a single `paymentGroupId`, eligibility
 * always arithmetic (`totalOwed − totalPaid`, never `VendorBillStatus`).
 *
 * One deliberate DIVERGENCE from PR-E: no `SupplierCredit` is ever minted
 * here. `recordSupplierPayment` banks `dto.totalAmount − allocatedTotal` —
 * real cash the operator handed over, minus what it was allocated to. This
 * DTO carries no cash total at all, and every confirmed amount is already
 * capped at the bill's outstanding balance, so there is no surplus cash to
 * bank. Treating the gap between a statement LINE and the confirmed amount as
 * surplus would fabricate spendable credit out of an accounting discrepancy
 * (a bill part-paid earlier, or a line that simply disagrees with our books)
 * and let the tenant under-pay the supplier by that amount later.
 *
 * The write is duplicated here rather than calling into `VendorBillsService`,
 * per the plan's module note: importing `VendorBillsModule` into
 * `SupplierStatementsModule` would create a cycle, and the payment call is
 * small enough that copying it is cheaper than the cycle.
 *
 * The system never silently guesses about money: `dto.confirmed` is the
 * operator's explicit decision, but the amount on it is never trusted as-is —
 * every confirmed amount is independently re-checked against both the
 * statement's own line (so a statement can never be made to pay out more than
 * it itself claims) and the bill's real outstanding balance, and the whole
 * apply is rejected — nothing partially written — on either violation. The
 * statement-line cap is re-derived by re-running `statement-matcher.ts`'s
 * own deterministic `matchStatementLines` against the tenant's CURRENT bills
 * (never a persisted match result — the scan row keeps only the raw parsed
 * statement, not which line matched which bill), so a confirmed bill is held
 * to a real line of the statement the review screen showed the operator — any
 * candidate of that line, not only the matcher's own suggestion (see
 * `resolveBackingLine`).
 */
@Injectable()
export class StatementApplyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Apply a scan's confirmed matches (and, separately, any implied-paid
   * bills) as real payments. Idempotent: re-applying an already-`APPLIED`
   * scan changes nothing and returns the payment group it wrote the first
   * time, so a client whose response was lost cannot double-pay. Checked
   * both before opening the transaction (the common case — cheap, no lock)
   * and again inside it behind a `SELECT … FOR UPDATE` on the scan row, which
   * is what actually closes the race between two simultaneous Applies —
   * `tenantTransaction` runs at READ COMMITTED, where the re-read alone would
   * still see a pre-write snapshot.
   */
  async applyStatement(
    scanId: string,
    dto: ApplyStatementDto,
    user: { sub: string },
  ): Promise<ApplyStatementResult> {
    const scan = await this.prisma.forTenant().supplierStatementScan.findUnique({
      where: { id: scanId },
    });
    if (!scan) throw new NotFoundException("Statement scan not found");

    if (scan.status === "APPLIED") {
      return this.alreadyAppliedResult(scan.appliedPaymentGroupId);
    }
    if (scan.status === "DISCARDED") {
      throw new BadRequestException("This statement was discarded and cannot be applied.");
    }
    if (!scan.supplierId) {
      throw new BadRequestException("This statement has not been matched to a supplier yet.");
    }

    const confirmed = (dto.confirmed ?? []).filter(
      (c) => roundMoney(Number(c.amount)) > BALANCE_EPSILON,
    );
    const impliedPaidIds = Array.from(new Set(dto.impliedPaid?.billIds ?? []));
    if (confirmed.length === 0 && impliedPaidIds.length === 0) {
      throw new BadRequestException("Nothing to apply.");
    }
    // One bill, one line — the plan's rule (AC 4), enforced here rather than
    // discovered halfway through the loop as a confusing balance error.
    const seenBillIds = new Set<string>();
    for (const c of confirmed) {
      if (seenBillIds.has(c.billId)) {
        throw new BadRequestException(
          "The same bill was confirmed on more than one statement line — a bill can only be settled once per apply.",
        );
      }
      seenBillIds.add(c.billId);
    }

    const supplierId = scan.supplierId;
    const lines = this.parseStatementLines(scan.extractedPayload);
    const matchableBills = await this.fetchMatchableBills(supplierId);
    const matches = matchStatementLines(lines, matchableBills);
    const paymentGroupId = randomUUID();

    return this.prisma.tenantTransaction(async (tx) => {
      // Race guard: two concurrent Applies for the same scan must not both
      // write. The transaction ALONE does not close it — tenantTransaction
      // runs at READ COMMITTED, so both racers would take a snapshot still
      // showing SCANNED, both write a full set of payments under two
      // different groups, and only the second group would be recorded on the
      // scan (leaving the first unattributable, breaking AC 9). Lock the scan
      // row FIRST so they serialize here, then re-read status through the
      // lock — the same idiom as invoices.service.ts recordPayment and
      // returns.service.ts create.
      await tx.$executeRaw`SELECT id FROM "SupplierStatementScan" WHERE id = ${scanId} FOR UPDATE`;
      const fresh = await tx.supplierStatementScan.findUnique({ where: { id: scanId } });
      if (!fresh) throw new NotFoundException("Statement scan not found");
      if (fresh.status === "APPLIED") {
        return this.alreadyAppliedResult(fresh.appliedPaymentGroupId);
      }

      const payments: AppliedStatementPayment[] = [];
      const bills: { id: string; status: string; totalPaid: number }[] = [];

      for (const line of confirmed) {
        const amount = roundMoney(Number(line.amount));

        const bill = await tx.vendorBill.findUnique({
          where: { id: line.billId },
          include: { payments: true },
        });
        if (!bill) throw new NotFoundException(`Bill ${line.billId} not found`);
        // Highest-risk guard, checked per bill not once for the group — money
        // must never land on another supplier's bill. Mirrors
        // recordSupplierPayment's cross-supplier check.
        if (bill.supplierId !== supplierId) {
          throw new BadRequestException(
            `Bill ${bill.billNumber} does not belong to this statement's supplier.`,
          );
        }
        // VOID is the one status this method compares against (landmine 1 in
        // recordSupplierPayment): a voided bill keeps its totalOwed and would
        // be resurrected into AP by the status recompute below.
        if (bill.status === "VOID") {
          throw new BadRequestException(`Bill ${bill.billNumber} is void and cannot be paid.`);
        }
        // DRAFT is refused here for exactly the reason the implied-paid loop
        // below refuses it: a draft has not been received, so there is no
        // liability for this statement to settle, and flipping it to
        // PAID/PARTIAL strips it of every draft-only transition (edit,
        // revert-to-draft, delete) and drops it out of the needs-mapping
        // queue — permanently, for stock that never arrived. Drafts DO reach
        // this loop: `fetchMatchableBills` excludes only VOID, and a
        // scanned-but-unmapped draft routinely carries the very
        // `supplierInvoiceNumber` an EXACT_REF line matches on, so its row
        // arrives pre-checked. The review screen keeps drafts unchecked and
        // blocks them; reject any that still arrive.
        if (bill.status === "DRAFT") {
          throw new BadRequestException(
            `Bill ${bill.billNumber} is still a draft — receive it before settling it off a statement.`,
          );
        }

        const match = this.resolveBackingLine(matches, bill.id, line.lineIndex);
        if (!match) {
          throw new BadRequestException(
            `No line on this statement backs the confirmed amount for bill ${bill.billNumber}.`,
          );
        }
        const capAmount = roundMoney(Number(match.line.amount) || 0);
        if (amount > capAmount + LINE_AMOUNT_EPSILON) {
          throw new BadRequestException(
            `Confirmed amount ${amount.toFixed(2)} for bill ${bill.billNumber} exceeds the ` +
              `statement's own line of ${capAmount.toFixed(2)}.`,
          );
        }

        // The ledger, exactly as recordSupplierPayment does — never the
        // denormalised totalPaid column, and never bill.status (landmine 1).
        const alreadyPaid = roundMoney(
          bill.payments.reduce((s: number, p: any) => s + Number(p.amount), 0),
        );
        const remaining = roundMoney(Number(bill.totalOwed) - alreadyPaid);
        if (amount > remaining + BALANCE_EPSILON) {
          throw new BadRequestException(
            `Confirmed amount ${amount.toFixed(2)} for bill ${bill.billNumber} exceeds its ` +
              `remaining balance of ${remaining.toFixed(2)}.`,
          );
        }

        const payment = await tx.billPayment.create({
          data: {
            vendorBillId: bill.id,
            amount,
            method: PaymentMethod.OTHER,
            // paidAt is deliberately left to the column default (now()), the
            // same default the implied-paid loop below relies on and what
            // recordSupplierPayment falls back to. The matched line is an
            // INVOICE line, so `line.date` is when the SUPPLIER ISSUED the
            // invoice, not when it was paid: backdating to it would push a
            // September reconciliation of a July statement into July, where
            // bookkeeping's cash-flow report (which buckets by paidAt) would
            // rewrite a month the operator has already closed.
            reference: `STATEMENT-${scanId.slice(0, 8)}`,
            notes: dto.notes ?? null,
            paymentGroupId,
          },
        });
        payments.push({ id: payment.id, vendorBillId: bill.id, amount });

        const newPaid = roundMoney(alreadyPaid + amount);
        const newStatus = newPaid >= Number(bill.totalOwed) - BALANCE_EPSILON ? "PAID" : "PARTIAL";
        await tx.vendorBill.update({
          where: { id: bill.id },
          data: { totalPaid: newPaid, status: newStatus as any },
        });
        bills.push({ id: bill.id, status: newStatus, totalPaid: newPaid });
        // NO excess is banked from `capAmount - amount`. That gap is not
        // surplus cash — it is the statement disagreeing with our books (a
        // bill already part-paid, or a line total that differs from the
        // bill's) — and minting SupplierCredit from it would hand the tenant
        // spendable credit for money nobody paid. See the class doc.
      }

      // impliedPaid is validated on its OWN terms — it is never derived from,
      // or capped by, a statement line (these bills predate the statement's
      // period and are not on it at all), and never folded into `confirmed`.
      for (const billId of impliedPaidIds) {
        const bill = await tx.vendorBill.findUnique({
          where: { id: billId },
          include: { payments: true },
        });
        if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
        if (bill.supplierId !== supplierId) {
          throw new BadRequestException(
            `Bill ${bill.billNumber} does not belong to this statement's supplier.`,
          );
        }
        if (bill.status === "VOID") {
          throw new BadRequestException(
            `Bill ${bill.billNumber} is void and cannot be marked paid.`,
          );
        }
        // DRAFT is the other status this loop must refuse. A draft has not
        // been received, so it is not a liability this statement can imply was
        // settled — and flipping it to PAID strips it of every draft-only
        // transition (edit, revert-to-draft, delete) and drops it out of the
        // needs-mapping queue, permanently, for a payment it never received.
        // The review screen keeps drafts out of the proposal; reject any that
        // still arrive rather than silently locking them.
        if (bill.status === "DRAFT") {
          throw new BadRequestException(
            `Bill ${bill.billNumber} is still a draft and cannot be marked paid.`,
          );
        }

        const alreadyPaid = roundMoney(
          bill.payments.reduce((s: number, p: any) => s + Number(p.amount), 0),
        );
        const remaining = roundMoney(Number(bill.totalOwed) - alreadyPaid);
        if (remaining <= BALANCE_EPSILON) {
          // Already settled in our own books — nothing to write.
          continue;
        }

        const payment = await tx.billPayment.create({
          data: {
            vendorBillId: bill.id,
            amount: remaining,
            method: PaymentMethod.OTHER,
            reference: `STATEMENT-IMPLIED-${scanId.slice(0, 8)}`,
            notes: dto.notes ?? "Marked paid — implied settled by supplier statement",
            paymentGroupId,
          },
        });
        payments.push({ id: payment.id, vendorBillId: bill.id, amount: remaining });

        const totalPaid = roundMoney(alreadyPaid + remaining);
        await tx.vendorBill.update({
          where: { id: bill.id },
          data: { totalPaid, status: "PAID" as any },
        });
        bills.push({ id: bill.id, status: "PAID", totalPaid });
      }

      await tx.supplierStatementScan.update({
        where: { id: scanId },
        data: {
          status: "APPLIED",
          appliedPaymentGroupId: paymentGroupId,
          appliedAt: new Date(),
          appliedById: user.sub,
        },
      });

      return {
        paymentGroupId,
        alreadyApplied: false,
        payments,
        // Always 0 — see ApplyStatementResult.excess.
        excess: 0,
        bills,
      };
    });
  }

  /**
   * The statement line that backs one confirmed bill — the cap its amount is
   * held to.
   *
   * Looking the bill up by `match.billId` alone (the matcher's single PRIMARY
   * pick per line) would reject anything else the operator chose: the review
   * screen's picker deliberately offers EVERY entry of `candidates`, which
   * `matchStatementLines` leaves un-deduped for exactly that purpose, so a
   * hand-picked non-suggested candidate — the normal way to resolve two bills
   * carrying the same supplier invoice number, or two same-amount FUZZY
   * candidates — would fail the whole apply with nothing the operator could do
   * from the UI.
   *
   * `lineIndex` is the row the operator was actually looking at; when the
   * client sends it, the bill must be one of THAT line's candidates. Without
   * it, the bill's own primary-pick line wins, falling back to the first line
   * listing it as a candidate. Either way the cap is a real line of this
   * statement, so a statement still can never pay out more than it claims.
   */
  private resolveBackingLine(
    matches: StatementLineMatch[],
    billId: string,
    lineIndex?: number,
  ): StatementLineMatch | null {
    if (lineIndex != null) {
      const chosen = matches[lineIndex];
      if (!chosen) return null;
      return chosen.candidates.some((c) => c.billId === billId) ? chosen : null;
    }
    return (
      matches.find((m) => m.billId === billId) ??
      matches.find((m) => m.candidates.some((c) => c.billId === billId)) ??
      null
    );
  }

  private alreadyAppliedResult(paymentGroupId: string | null): ApplyStatementResult {
    return {
      paymentGroupId,
      alreadyApplied: true,
      payments: [],
      excess: 0,
      bills: [],
    };
  }

  private parseStatementLines(payload: unknown): ParsedStatementLine[] {
    const raw = (payload as any)?.lines;
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * The candidate bills `matchStatementLines` needs, fetched fresh (never
   * from the scan's own snapshot) so a confirmed amount is checked against
   * the statement line the tenant's bills match TODAY. Mirrors
   * `SupplierStatementsService.fetchMatchableBills` (WP2) exactly — VOID
   * bills excluded, `supplierInvoiceNumber` re-normalized rather than
   * trusted as stored. Duplicated rather than imported: that method is
   * private to WP2's service, and the query is small enough that copying it
   * is cheaper than exporting a new cross-file contract for it.
   */
  private async fetchMatchableBills(supplierId: string | null): Promise<MatchableBill[]> {
    if (!supplierId) return [];
    const bills = await this.prisma.forTenant().vendorBill.findMany({
      where: { supplierId, status: { not: "VOID" } },
      select: {
        id: true,
        billNumber: true,
        supplierInvoiceNumber: true,
        totalOwed: true,
        billDate: true,
        status: true,
      },
      take: 500,
    });
    return bills.map((b: any) => ({
      id: b.id,
      billNumber: b.billNumber,
      supplierInvoiceNumber: b.supplierInvoiceNumber
        ? normalizeInvoiceNumber(b.supplierInvoiceNumber)
        : null,
      totalOwed: Number(b.totalOwed),
      billDate: b.billDate,
      status: b.status,
    }));
  }
}

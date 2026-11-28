import { roundMoney } from "@routeflow/pricing";
import type { AcceptLineTotal, InvoiceEditConsentBody } from "@routeflow/types";
import type { EditedLine } from "./invoice-edit-plan";
import { isNsfLine } from "./nsf-line";
import type { IssuedRecompute } from "./stored-tax-state";

/**
 * SA-1508 A2-N1 rule 6, A3-H1, A3-M2/M3: an admin's MONEY edit of an issued invoice whose stored figures do not come from
 * its own lines (an imported file total, an older tax) is never silent and never a dead end. The judge reads the figures
 * the save WRITES (the lines after the verified stamp), never a prediction, and asks for consent only when a stored cent
 * would move. Pure: the caller hands it the written totals; it sums nothing.
 */

export interface ConsentVerdict {
  /** Set when the save must be refused until the admin confirms (or fixes the lines). */
  body: InvoiceEditConsentBody | null;
  /** True when the admin's echo matched the fresh figures: the save proceeds and the audit row says so. */
  consented: boolean;
}

const NONE: ConsentVerdict = { body: null, consented: false };
const cents = (v: unknown): number => Math.round(roundMoney(Number(v ?? 0)) * 100);
const HALF_CENT = 0.005 + 1e-9;

export function issuedConsent(a: {
  recompute: IssuedRecompute | null | undefined;
  invoice: { total?: unknown; taxAmount?: unknown };
  storedRows: ReadonlyArray<Record<string, any>>;
  /** The totals the save would write (the header-only save passes no lines and no tax when only the total moves). */
  written: { total: number; tax?: number; lines?: ReadonlyArray<EditedLine> | null };
  accept?: AcceptLineTotal | null;
}): ConsentVerdict {
  const { recompute, invoice, written, accept } = a;
  if (!recompute || recompute.state === "REPRODUCES") return NONE;
  const storedTotal = roundMoney(Number(invoice.total ?? 0));
  const storedTax = roundMoney(Number(invoice.taxAmount ?? 0));
  const newTotal = roundMoney(written.total);
  const newTax = roundMoney(written.tax ?? storedTax);
  // A3-M2: the same cents on both is no change to ask about ("add a line for the difference" lands here).
  if (cents(newTotal) === cents(storedTotal) && cents(newTax) === cents(storedTax)) return NONE;
  // A3-H1: a verified rate was stamped on every KEPT goods line, so the written tax IS the verified rate's: SA-814 R5-2,
  // kept. M4: a NEW line is not a kept row (the stamp never reaches it), so a new rate-0 line does not turn this into a
  // prompt; with no kept row at all nothing was stamped, so a moved cent still asks.
  if (recompute.state === "TAX_STALE" && recompute.restampRate != null && written.lines) {
    const kept = written.lines.filter((l) => l.rowId && a.storedRows.some((r) => r.id === l.rowId));
    // R-302: a kept row is silent only at the rate it was stored with, or (stored at 0) at the verified stamp itself;
    // any other rate on a kept row is a tax change the admin must confirm.
    const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
    const taxed = kept.every((l) => {
      const row = a.storedRows.find((r) => r.id === l.rowId);
      if (isNsfLine(row ?? l.data)) return true;
      const rate = Number(l.data.taxRate ?? 0);
      const was = Number(row?.taxRate ?? 0);
      return (
        rate !== 0 && (near(rate, was) || (was === 0 && near(rate, recompute.restampRate ?? NaN)))
      );
    });
    if (kept.length > 0 && taxed) return NONE;
  }
  const body: InvoiceEditConsentBody = {
    storedTotal,
    newTotal,
    difference: roundMoney(storedTotal - newTotal),
    storedTax,
    newTax,
    cause: recompute.state === "TAX_STALE" ? "OLDER_TAX" : "TOTAL_NOT_FROM_LINES",
  };
  // R-302 P4: the tax is echoed too. A client that sends no tax figures can only confirm a save whose tax does not move.
  const taxEchoed =
    (accept?.newTax ?? accept?.storedTax) === undefined
      ? cents(newTax) === cents(storedTax)
      : Math.abs(Number(accept?.storedTax ?? storedTax) - storedTax) <= HALF_CENT &&
        Math.abs(Number(accept?.newTax ?? newTax) - newTax) <= HALF_CENT;
  const echoed =
    !!accept &&
    Math.abs(Number(accept.storedTotal) - storedTotal) <= HALF_CENT &&
    Math.abs(Number(accept.newTotal) - newTotal) <= HALF_CENT &&
    taxEchoed;
  return echoed ? { body: null, consented: true } : { body, consented: false };
}

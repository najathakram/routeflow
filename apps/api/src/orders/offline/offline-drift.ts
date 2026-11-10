import { roundMoney } from "@routeflow/pricing";
import type { OfflineQuote } from "@routeflow/types";

/**
 * SA-1124 (SA-817 §4): did the price the device showed move before the server saw the order? PURE: no Prisma, no clock.
 *
 * The server prices every line itself at replay time and the quote is display evidence only. A line is compared on the
 * server's own computed unit price (no new formula), in whole cents through `roundMoney`: two amounts differ when they
 * are not the same cent (a half-cent gap that rounds to the same cent is no drift, a one-cent gap is).
 */

/** The server's priced line at the same position in `items` (what `create()` is about to store). */
export interface ServerLine {
  productId: string | null;
  unitPrice: number;
  unitsPerBox: number | null;
  unitLabel: string | null;
  /** A staff-typed price (`items[i].unitPrice`): judged as online, never flagged for price or unit. */
  override: boolean;
}

export type DriftFinding =
  | {
      kind: "LINE";
      lineIndex: number;
      productId: string | null;
      shown: number;
      now: number;
      unitChanged?: true;
    }
  | { kind: "TOTAL"; shownTotal: number; nowTotal: number };

const cents = (n: number): number => Math.round(roundMoney(n) * 100);

const sameUnit = (a: number | null | undefined, b: number | null | undefined) =>
  (a ?? null) === (b ?? null);
const sameLabel = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Per-line drift first; the order-level total only when NO line flagged (tax or a promotion moved). A quote line past the
 * server's lines (the controller refuses these, so unreachable) is ignored, never a throw.
 */
export function judgeOfflineDrift(
  server: ReadonlyArray<ServerLine>,
  serverTotal: number,
  quote: OfflineQuote,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const q of quote.lines) {
    const s = server[q.index];
    if (!s || s.override) continue;
    const priceMoved = cents(s.unitPrice) !== cents(q.unitPrice);
    const unitMoved =
      !sameUnit(s.unitsPerBox, q.unitsPerBox) || !sameLabel(s.unitLabel, q.unitLabel);
    if (!priceMoved && !unitMoved) continue;
    findings.push({
      kind: "LINE",
      lineIndex: q.index,
      productId: s.productId,
      shown: roundMoney(q.unitPrice),
      now: roundMoney(s.unitPrice),
      ...(unitMoved ? { unitChanged: true as const } : {}),
    });
  }
  if (findings.length === 0 && cents(serverTotal) !== cents(quote.total)) {
    findings.push({
      kind: "TOTAL",
      shownTotal: roundMoney(quote.total),
      nowTotal: roundMoney(serverTotal),
    });
  }
  return findings;
}

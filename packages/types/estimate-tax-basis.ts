/**
 * H5 (owner ruling 2026-10-13, SA): converting an estimate RE-TAKES the current tax basis (today's tenant rate, the
 * customer's exempt flag today, and the regulated levy of each product's category at the sale), so the invoice can
 * carry a different tax than the quote. The convert response reports the difference as `taxBasis`; the sentence the
 * operator sees is built HERE from those numbers - never from a server string - and shared by web and mobile so the
 * two surfaces cannot drift (same pattern as `read-only-copy.ts`).
 *
 * Pure: no React, no DOM, no network.
 */

export interface EstimateTaxBasis {
  /** The REGULAR tax the quote carried (a quote never carries a levy). */
  quotedTax: number;
  /** The regular tax the invoice was issued with. */
  currentTax: number;
  /** The regulated-category levy the invoice was issued with (computed at conversion; 0 when none). */
  currentLevy?: number;
  /** The invoice's whole tax: regular + levy. */
  invoiceTax?: number;
  /** currentTax - quotedTax, to the cent. */
  delta: number;
  /** The regular tax moved, or a levy was added that the quote did not carry. */
  changed: boolean;
  quotedRate: number;
  currentRate: number;
}

const isMoney = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const usd = (n: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);

/**
 * The fixed notice for a tax that moved between the quote and the invoice; null when nothing moved (or no usable
 * basis came, as from an older API). Two clauses, each only when it applies: the regular tax that was recalculated at
 * today's rate, and the regulated-category levy the quote did not carry.
 */
export function estimateTaxBasisNotice(basis: EstimateTaxBasis | null | undefined): string | null {
  if (!basis || basis.changed !== true) return null;
  if (!isMoney(basis.quotedTax) || !isMoney(basis.currentTax) || !isMoney(basis.delta)) return null;
  const levy = isMoney(basis.currentLevy) && basis.currentLevy > 0 ? basis.currentLevy : 0;
  const parts: string[] = [];
  if (basis.delta !== 0) {
    parts.push(
      `Tax was recalculated at today's rate: ${usd(basis.currentTax)} on the invoice, ` +
        `${usd(Math.abs(basis.delta))} ${basis.delta > 0 ? "more" : "less"} than the ${usd(basis.quotedTax)} quoted.`,
    );
  }
  if (levy > 0) {
    parts.push(`A regulated-category levy of ${usd(levy)} was added; the quote carried none.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

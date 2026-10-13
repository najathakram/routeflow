import { fmt } from "./formatting";

/**
 * H5 (owner ruling 2026-10-13): converting an estimate RE-TAKES the current tax basis (today's tenant rate and the
 * customer's exempt flag), so the invoice can carry a different tax than the quote. The convert response reports it
 * as `taxBasis`; the sentence the operator sees is built HERE from those numbers - never from a server string.
 */
export interface EstimateTaxBasis {
  /** The REGULAR tax the quote carried. */
  quotedTax: number;
  /** The regular tax the invoice was issued with. */
  currentTax: number;
  /** currentTax - quotedTax, to the cent. */
  delta: number;
  /** delta is not zero. */
  changed: boolean;
  quotedRate: number;
  currentRate: number;
}

const isMoney = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The fixed notice for a tax that moved between the quote and the invoice; null when it did not (or no basis came). */
export function estimateTaxBasisNotice(basis: EstimateTaxBasis | null | undefined): string | null {
  if (!basis || basis.changed !== true) return null;
  if (!isMoney(basis.quotedTax) || !isMoney(basis.currentTax) || !isMoney(basis.delta)) return null;
  if (basis.delta === 0) return null;
  const more = basis.delta > 0;
  return (
    `Tax was recalculated at today's rate: ${fmt(basis.currentTax)} on the invoice, ` +
    `${fmt(Math.abs(basis.delta))} ${more ? "more" : "less"} than the ${fmt(basis.quotedTax)} quoted.`
  );
}

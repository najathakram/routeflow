import { roundMoney } from "./pricing";

/** A Return's frozen credit split: item net, plain tax, and category (levy) tax. */
export interface FrozenSplit {
  net: number;
  tax: number;
  categoryTax: number;
}

/**
 * Re-freezes a Return's credit split at a REDUCED approved gross (SA-980: the driver-cap hold
 * approval may approve less than the held credit). The ONE helper for that scaling.
 *
 * Rounding rule: `tax` and `categoryTax` are each scaled by `approvedGross / frozenGross` and
 * rounded to cents ({@link roundMoney}); `net` is NOT scaled but derived as
 * `approvedGross - tax - categoryTax`, so the three parts always sum to `approvedGross` to the
 * cent and any rounding remainder lands in `net`. An approval at the full frozen gross (or a
 * frozen gross of 0, which has nothing to scale) returns the split unchanged.
 */
export function scaleFrozenSplit(split: FrozenSplit, approvedGross: number): FrozenSplit {
  const approved = roundMoney(approvedGross);
  const frozen = roundMoney(split.net + split.tax + split.categoryTax);
  if (frozen === approved) return { ...split };
  if (!(frozen > 0)) return { net: approved, tax: 0, categoryTax: 0 };
  const ratio = approved / frozen;
  const tax = roundMoney(split.tax * ratio);
  const categoryTax = roundMoney(split.categoryTax * ratio);
  return { net: roundMoney(approved - tax - categoryTax), tax, categoryTax };
}

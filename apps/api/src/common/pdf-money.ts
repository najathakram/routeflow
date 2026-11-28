import { roundMoney } from "@routeflow/pricing";

/**
 * The ONE api document money text ("$5,500.00"): rounded through roundMoney first, en-US grouping, two decimals. A
 * negative prints "-$1,234.50"; a caller that wants the size only passes the absolute value. Pure, no clock, no zone.
 * pdf-money.sites.spec.ts keeps every PDF renderer on it.
 */
export function fmtPdfMoney(n: number): string {
  const r = roundMoney(n);
  const text = Math.abs(r).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return r < 0 ? `-$${text}` : `$${text}`;
}

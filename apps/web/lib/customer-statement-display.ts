/**
 * B1005: a balance on the customer page is a REAL figure or an em dash. While the statement is loading, after it failed, or when
 * an older API omits the field, the tile shows "—": never a made-up $0.00 (the same rule CreditLimitPanel follows, B576). A
 * real zero from the server is still "$0.00".
 */
export const STATEMENT_UNAVAILABLE = "—";

export function statementMoney<S>(
  statement: S | undefined,
  failed: boolean,
  pick: (s: S) => number | null | undefined,
  format: (n: number) => string,
): string {
  if (failed || !statement) return STATEMENT_UNAVAILABLE;
  const n = pick(statement);
  return typeof n === "number" && Number.isFinite(n) ? format(n) : STATEMENT_UNAVAILABLE;
}

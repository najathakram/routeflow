/**
 * SA-849 / I-120: a till tender the credit gate counted did not record, and without it the customer is over their credit
 * limit (the tenant enforces it). The counter sale's receipt (`CounterSaleResponse.creditOverLimit`) and the pickup
 * hand-over (`PickupCompleteResponse.creditOverLimit`) carry the server's figures; web and mobile say it in ONE sentence,
 * each with its own money formatter. Pure, no imports (mobile resolves it by subpath).
 */
export interface CreditOverLimit {
  limit: number;
  exposure: number;
}

/** The one sentence (server figures, formatted only). */
export function creditOverLimitSentence(
  customerName: string | null | undefined,
  over: CreditOverLimit,
  money: (n: number) => string,
): string {
  const who = customerName?.trim() || "the customer";
  return `Until this payment is recorded, ${who} is over their credit limit (${money(over.exposure)} of ${money(over.limit)}).`;
}

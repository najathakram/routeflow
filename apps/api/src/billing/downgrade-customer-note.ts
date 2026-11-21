/**
 * B1371 (SA-1175 R1 K3): no plan has a seat limit, so a downgrade's only customer-facing consequence besides price and
 * add-ons is the customer allowance (`customerAllowanceOf` in addon-capacity.ts, the same sum entitlements takes).
 * These are the pieces the preview and the schedule notice share.
 */

/** The owner's exact sentence (K3/K9), or null when the tenant is within the allowance. */
export function downgradeCustomerSentence(
  used: number,
  planName: string,
  cap: number,
): string | null {
  if (used <= cap) return null;
  return (
    `You have ${used} customers. ${planName} includes ${cap}. Your current customers stay as they are. ` +
    `Once you add one past ${cap}, you have 7 days. After that, a new customer needs a Customer pack or a bigger plan.`
  );
}

/** What the "downgrade scheduled" email states beyond the dates: the price, the add-ons that start billing, the sentence. */
export interface DowngradeNoticeDetails {
  newMonthlyPrice: number | null;
  addons: { name: string; monthlyPrice: number }[];
  customerNote: string | null;
}

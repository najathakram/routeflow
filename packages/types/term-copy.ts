/**
 * SA-1304 C2 (W-1433; copy ruling 7172194631 over 7170572581): the ONE home for the yearly words.
 *
 * Every customer sentence about paying for a year (chooser, settings, add-on dialogs, reminder and receipt emails,
 * the public site, the R-1 refund messages) is built here, character for character from the ruling's list S1-S14.
 * Copy only. The module computes nothing: every builder takes figures and dates that are ALREADY formatted
 * (from the quote, the finalized invoice or the stamped subscription) and drops them into the sentence. It has no
 * import and no arithmetic; the spec scans the source for both. The yearly saving figure comes from the pricing helper
 * at the call site, never from here.
 *
 * Dark: nothing outside tests imports this module until PR-7 (labels, emails) and PR-8 (site, chooser). The dark pin
 * in apps/api/src/billing/term-copy.spec.ts lists the reviewed importers and each of those PRs changes the list.
 * Customer surfaces say "yearly"; the internal ANNUAL word never appears here.
 */

/** The policy answers (Q1-Q5) as words only. A changed answer is one field here. */
export const TERM_POLICY = {
  refundWindow: "14 days",
  trialLength: "14 days",
} as const;

/** S1: the chooser toggle. Shown only when GET plans returns `annualCheckout === true`. */
export const TERM_TOGGLE_LABELS = { monthly: "Monthly", yearly: "Yearly" } as const;

/** S2: chooser card and settings price. */
export function yearPriceLabel(yearPrice: string): string {
  return `${yearPrice} a year`;
}

/** S3: chooser confirm, before the button. */
export function yearConfirmLine(yearPrice: string, renewalDate: string): string {
  return `${yearPrice} a year, billed today. Renews on ${renewalDate}.`;
}

/** S4: under S3 and on the site card. `yearSaving` is above zero and comes from the pricing helper. */
export function yearSavingLine(yearSaving: string): string {
  return `That's ${yearSaving} less than 12 months of monthly billing.`;
}

/** S4b: replaces S4 only while the charged year is exactly ten months of the monthly price. */
export function twoMonthsFreeLine(yearSaving: string): string {
  return `2 months free: ${yearSaving} less than 12 months of monthly billing.`;
}

/** S5: the own-plan buttons and their sub-line. */
export function switchToYearlyLabel(): string {
  return "Switch to yearly billing";
}
export function switchToMonthlyLabel(): string {
  return "Switch to monthly billing";
}
export function switchStartsLine(renewalDate: string): string {
  return `Starts on ${renewalDate}.`;
}

/** S6: confirm and cancel dialog on a yearly plan. */
export function cancelYearlyLine(renewalDate: string): string {
  return `If you cancel, your plan stays active until ${renewalDate}. Nothing is refunded automatically.`;
}

/** S7: confirm, cancel dialog and site FAQ. Matches the R-1 runbook and the terms page word for word. */
export function refundWindowLine(): string {
  return `Changed your mind? Contact us within ${TERM_POLICY.refundWindow} of paying for a year and we'll refund the full yearly payment. Your plan ends when we do.`;
}

/** S8: add-on dialog on a yearly plan. `addonCharge` comes from the quote. */
export function addonYearlyAddLine(args: {
  addonName: string;
  addonCharge: string;
  renewalDate: string;
}): string {
  return `Adding ${args.addonName} now costs ${args.addonCharge} today for the rest of your year. It then renews with your plan on ${args.renewalDate}.`;
}

/** S9: add-on removal on a yearly plan. */
export function addonYearlyRemoveLine(args: { addonName: string; renewalDate: string }): string {
  return `You keep ${args.addonName} until ${args.renewalDate}. It isn't refunded.`;
}

/** S10: the 30-day and 7-day reminder emails. */
export function renewalReminderLine(renewalDate: string, yearPrice: string): string {
  return `Your plan renews on ${renewalDate} for ${yearPrice}.`;
}

/** S11: the receipt email, from a finalized invoice. */
export function yearlyReceiptLine(yearPrice: string, renewalDate: string): string {
  return `You paid ${yearPrice} for a year. Your plan renews on ${renewalDate}.`;
}

/** S12: the chooser in a trial. Ships only after BP-1 / B1406 (subscribe never enters a year). */
export const TERM_TRIAL_LINE = `When your ${TERM_POLICY.trialLength} free end, choose monthly or yearly. You're not charged until you choose.`;

/** S13: site lede, FAQ and meta. Only while every plan on sale is exactly ten months of the monthly price. */
export const TERM_SITE_LEDE = "Pay yearly and get 2 months free.";

/** S14: add-on dialog while the gate is closed (`ADDON_ANNUAL_NOT_SUPPORTED`). */
export const TERM_ADDON_BLOCKED_LINE =
  "Add-ons can't be added to a yearly plan online yet. Please contact support.";

/** R-1 message, refund done (neutral). */
export function refundDoneMessage(yearPrice: string): string {
  return `Hello, we've refunded your yearly payment of ${yearPrice} in full, as you asked, and your subscription has ended. You won't be charged again. Your bank decides when the refund shows on your statement.`;
}

/** R-1 message, outside the refund window. */
export function refundOutsideWindowMessage(renewalDate: string): string {
  return `Your yearly payment was made more than ${TERM_POLICY.refundWindow} ago, so it can't be refunded. Your plan stays active until ${renewalDate}, and you can cancel so it doesn't renew.`;
}

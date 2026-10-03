/**
 * B1018 / SA-642 (mirrors apps/web/lib/customer-credit-limit.ts): the credit-limit box of the customer form -> the value the
 * API payload carries. A typed amount is sent as a number (0 is a REAL $0 limit); on an EDIT a box that was deliberately
 * blanked (the customer HAD a limit) sends `null`, which clears it ("no limit"); a create omits the field; garbage never
 * clears and never sends.
 */
const AMOUNT = /^\d+(\.\d{1,2})?$/;

export function isCreditLimitInput(raw: string | undefined): boolean {
  const t = (raw ?? "").trim();
  return t === "" || AMOUNT.test(t);
}

export function creditLimitForSubmit(
  raw: string | undefined,
  mode: "create" | "edit",
  hadLimit: boolean,
): number | null | undefined {
  const t = (raw ?? "").trim();
  if (t === "") return mode === "edit" && hadLimit ? null : undefined;
  return AMOUNT.test(t) ? parseFloat(t) : undefined;
}

/**
 * B1018 / SA-642: the credit-limit box of the customer form -> the value the API payload carries.
 *   - a typed amount is sent as a number (0 is a REAL $0 limit, never "blank");
 *   - on an EDIT, a box that was deliberately blanked (the customer HAD a limit, the box is now empty) sends `null`, which
 *     clears the limit ("no limit"); a blank box on a customer that never had one sends nothing;
 *   - on a CREATE a blank box omits the field (null is for updates only);
 *   - garbage never clears and never sends (the form refuses it first), so a typo cannot silently remove a credit block.
 */
const AMOUNT = /^\d+(\.\d{1,2})?$/;

export function isCreditLimitInput(raw: string | undefined): boolean {
  const t = (raw ?? "").trim();
  return t === "" || AMOUNT.test(t);
}

export function creditLimitForSubmit(
  raw: string | undefined,
  mode: "create" | "update",
  hadLimit: boolean,
): number | null | undefined {
  const t = (raw ?? "").trim();
  if (t === "") return mode === "update" && hadLimit ? null : undefined;
  return AMOUNT.test(t) ? parseFloat(t) : undefined;
}

/**
 * CQ-06 review: the FIXED sentence for a 409 SELLING_RESTRICTED shown where no blocked-lines dialog is open (the counter,
 * the generic toast). It says what is wrong and the next step from the STRUCTURED `reason` of the staff body only; product
 * names, rule text and the server's `message` are never shown. A surface with its own dialog (the order builder, the
 * order page) keeps that dialog; this is the fallback so such a refusal is never the neutral conflict sentence.
 */
const GENERIC =
  "This sale includes an item that can't be sold to this customer under your selling restrictions. Remove the item or change the customer, then try again.";
const STATE_UNKNOWN =
  "We can't tell which state this customer is in, so an item with a state rule can't be sold. Choose a customer with an address on file, or remove the item, then try again.";

export function sellingRestrictedCopy(blockedLines?: unknown): string {
  const lines = Array.isArray(blockedLines)
    ? blockedLines.filter((l): l is { reason?: unknown } => !!l && typeof l === "object")
    : [];
  if (lines.length > 0 && lines.every((l) => l.reason === "INDETERMINATE_ADDRESS"))
    return STATE_UNKNOWN;
  return GENERIC;
}

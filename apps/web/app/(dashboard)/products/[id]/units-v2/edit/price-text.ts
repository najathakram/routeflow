import { validateSetPrice } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";

/**
 * K11-12: the text a price box settles to. A valid price becomes its two-decimal money text without the "$" (the box
 * draws that itself): "30" is "30.00", "1800" is "1,800.00". Validation and rounding to cents are the pricing package's
 * (`validateSetPrice`), the digits are `formatMoney`'s. Anything that is not a valid price, and a cleared box, comes
 * back exactly as typed, so a refusal keeps the user's text.
 */
export function canonicalPriceText(text: string): string {
  const checked = validateSetPrice(text);
  if (!checked.ok || checked.value == null) return text;
  return formatMoney(checked.value).replace(/^\$/, "");
}

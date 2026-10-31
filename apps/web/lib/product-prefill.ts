/**
 * W-1042: what the new-product window starts with from text the clerk typed or scanned. A code (six or more digits)
 * goes to SKU, anything else is a name. Create Order and the counter share it so the two doors never disagree.
 */
export function newProductPrefill(text: string): { name: string; sku: string } {
  const looksLikeSku = /^\d{6,}$/.test(text.trim());
  return looksLikeSku ? { name: "", sku: text.trim() } : { name: text, sku: "" };
}

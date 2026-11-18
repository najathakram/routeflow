/**
 * The ONE reader of the tenant's invoice display switches (SystemConfig, Settings > Invoicing > Invoice layout).
 * Every renderer (PDF, email, reminder, receipt, invoice detail) and the settings controller go through here;
 * invoice-layout.sites.spec.ts fails on a key string anywhere else. Absent = shown: only the string "true" hides.
 */
export const INVOICE_LAYOUT_KEYS = {
  hideOriginalPrice: "invoice.hideOriginalPrice",
  hideBarcodes: "invoice.hideBarcodes",
  hidePerPiece: "invoice.hidePerPiece",
} as const;

export type InvoiceLayout = { [K in keyof typeof INVOICE_LAYOUT_KEYS]: boolean };

export function parseInvoiceLayout(
  raw: Readonly<Record<string, string | null | undefined>>,
): InvoiceLayout {
  const on = (k: keyof typeof INVOICE_LAYOUT_KEYS) => raw[INVOICE_LAYOUT_KEYS[k]] === "true";
  return {
    hideOriginalPrice: on("hideOriginalPrice"),
    hideBarcodes: on("hideBarcodes"),
    hidePerPiece: on("hidePerPiece"),
  };
}

/** One query for every switch (`getAll("invoice.")`), never one `get` per key. */
export async function readInvoiceLayout(systemConfig: {
  getAll(prefix: string): Promise<Record<string, string>>;
}): Promise<InvoiceLayout> {
  return parseInvoiceLayout(await systemConfig.getAll("invoice."));
}

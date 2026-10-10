/**
 * Units rebuild P0a: how an invoice line's code is chosen. A tenant policy picks one mode;
 * Product.invoiceLineCode (nullable String, NOT a Prisma enum) overrides it per product,
 * null = follow the tenant policy. Const only — the resolution logic lands in a later PR.
 */
export const INVOICE_LINE_CODE_MODES = ["legacy", "smallest", "sold", "main"] as const;
export type InvoiceLineCodeMode = (typeof INVOICE_LINE_CODE_MODES)[number];

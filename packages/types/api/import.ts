// ─── CSV import column alias registry (B858/B859, FIX1 — cause-ruling.md §2.A / SA-284) ──────
//
// Single source of truth for the CANONICAL display header + alias list per importable field,
// shared between `apps/api/src/import/import-columns.ts` (which attaches parsers/gates to each
// entry) and the web help text that documents accepted column headers. apps/api may not
// value-import this package at runtime, so it keeps a mirror (import-column-aliases.ts) pinned
// deep-equal to these lists by import-column-aliases.spec.ts — the two surfaces cannot drift.
//
// No `averageCost` entry — the ledger seeds it (SA-136); an "Average Cost" column header must
// resolve to nothing (see PRODUCT_IMPORT_COLUMNS below and import-columns.spec.ts P4/P5).

export interface ImportColumnAlias {
  /** Internal field name the header resolves to (e.g. "pricePerUnit"). */
  field: string;
  /** Canonical display header shown in web help text / error messages. */
  canonical: string;
  /** All header spellings (including `canonical`) that resolve to this field. */
  aliases: string[];
}

export const PRODUCT_IMPORT_COLUMNS: ImportColumnAlias[] = [
  { field: "name", canonical: "Item Name", aliases: ["Item Name", "Name", "Product Name"] },
  { field: "sku", canonical: "SKU", aliases: ["SKU", "Item Code"] },
  { field: "barcode", canonical: "Barcode", aliases: ["Barcode", "UPC", "EAN"] },
  { field: "unit", canonical: "Unit", aliases: ["Unit", "Usage Unit", "UOM"] },
  {
    field: "pricePerUnit",
    canonical: "Rate",
    aliases: ["Rate", "Sales Rate", "Price", "Sales Price", "Selling Price"],
  },
  {
    field: "priceTier2",
    canonical: "Price Tier 2",
    aliases: ["Price Tier 2", "Tier 2 Price"],
  },
  {
    field: "priceTier3",
    canonical: "Price Tier 3",
    aliases: ["Price Tier 3", "Tier 3 Price"],
  },
  {
    field: "priceTier4",
    canonical: "Price Tier 4",
    aliases: ["Price Tier 4", "Tier 4 Price"],
  },
  {
    field: "priceTier5",
    canonical: "Price Tier 5",
    aliases: ["Price Tier 5", "Tier 5 Price"],
  },
  {
    field: "unitsPerBox",
    canonical: "Units Per Box",
    aliases: ["Units Per Box", "Pack Size", "Case Qty", "Units/Box"],
  },
  { field: "category", canonical: "Category", aliases: ["Category", "Item Category"] },
  {
    field: "description",
    canonical: "Description",
    aliases: ["Description", "Item Description"],
  },
  {
    field: "standardCost",
    canonical: "Cost",
    aliases: ["Cost", "Purchase Rate", "Standard Cost", "Purchase Price"],
  },
  { field: "msrp", canonical: "MSRP", aliases: ["MSRP", "Retail Price"] },
  { field: "isTobacco", canonical: "Tobacco", aliases: ["Tobacco", "Is Tobacco"] },
  {
    field: "reorderPoint",
    canonical: "Reorder Point",
    aliases: ["Reorder Point", "Reorder Level"],
  },
  { field: "reorderQty", canonical: "Reorder Qty", aliases: ["Reorder Qty"] },
  // SA-823 (row 655): the optional family columns. `id` is the product id from the products export (the stable key
  // a Family cell needs); `family` names the family to group the row under; `variantName` is the label it carries.
  { field: "id", canonical: "Product ID", aliases: ["Product ID", "RouteFlow ID"] },
  {
    field: "family",
    canonical: "Family",
    aliases: ["Family", "Family Name", "Family / Variant of (parent product name)"],
  },
  {
    field: "variantName",
    canonical: "Variant Name",
    aliases: ["Variant Name", "Variant", "Variant Label"],
  },
];

export const CUSTOMER_IMPORT_COLUMNS: ImportColumnAlias[] = [
  {
    field: "businessName",
    canonical: "Customer Name",
    aliases: ["Customer Name", "Display Name", "Company Name"],
  },
  { field: "zohoContactId", canonical: "Customer ID", aliases: ["Customer ID", "Contact ID"] },
  {
    field: "defaultPaymentTerms",
    canonical: "Payment Terms",
    aliases: ["Payment Terms", "Terms"],
  },
  {
    field: "pricingTier",
    canonical: "Pricing Tier",
    aliases: ["Pricing Tier", "Price Tier", "Tier"],
  },
  { field: "creditLimit", canonical: "Credit Limit", aliases: ["Credit Limit"] },
  { field: "isTaxExempt", canonical: "Tax Exempt", aliases: ["Tax Exempt"] },
  { field: "taxId", canonical: "Tax ID", aliases: ["Tax ID", "Tax Number", "EIN"] },
  {
    field: "tobaccoLicenseNo",
    canonical: "Tobacco Licence No",
    aliases: ["Tobacco Licence No", "Tobacco License No", "Tobacco Licence"],
  },
  {
    field: "tobaccoLicenseExpiry",
    canonical: "Tobacco Licence Expiry",
    aliases: ["Tobacco Licence Expiry", "Tobacco License Expiry"],
  },
  {
    field: "deliveryWindowStart",
    canonical: "Delivery Window Start",
    aliases: ["Delivery Window Start"],
  },
  {
    field: "deliveryWindowEnd",
    canonical: "Delivery Window End",
    aliases: ["Delivery Window End"],
  },
  { field: "smsConsent", canonical: "SMS Consent", aliases: ["SMS Consent"] },
  { field: "waConsent", canonical: "WhatsApp Consent", aliases: ["WhatsApp Consent"] },
];

/** SA-823 (row 655): the key a Family row matched its existing product by (`null` = a new variant is created). */
export type ImportFamilyMatchKey = "id" | "sku" | "barcode";

/** Per-row family detail on a product-import plan row (preview and apply return the same shape). */
export interface ImportFamilyRowInfo {
  matchedBy: ImportFamilyMatchKey | null;
  /** The family the row is grouped under. */
  name: string;
  /** `existing`: the family is already there. `new`: this import creates it. */
  state: "existing" | "new";
  /** The bare variant label the product will carry. */
  variantName: string;
  /** "{Family} - {Variant}", as the product reads everywhere. */
  displayName: string;
  /** The family the product leaves, when the row moves it between families. */
  movesFrom: string | null;
  /** Current stock of the matched product, shown for information (grouping moves no stock). */
  stock: number | null;
}

/** The header of a product-import preview / result for a file with Family columns. */
export interface ImportFamilySummary {
  familiesToCreate: { name: string; rows: number }[];
  /** Existing products that join a family (moves included). */
  grouped: number;
  /** New variants created under a family. */
  newVariants: number;
  moves: number;
  skipsByReason: { reason: string; count: number }[];
  /** Families this run created and then deactivated because none of their rows could be assigned (apply only). */
  deactivated: { name: string }[];
  /** Families this run created whose cleanup failed: they were NOT removed and need removing in the product editor (apply only). */
  cleanupFailed: { name: string }[];
}

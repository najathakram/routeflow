import type { ImportColumnAlias } from "@routeflow/types";

// API-side mirror of `PRODUCT_IMPORT_COLUMNS` / `CUSTOMER_IMPORT_COLUMNS` from
// `packages/types/api/import.ts`. The API must never VALUE-import `@routeflow/types` (its entry is
// raw TypeScript; `node dist/main.js` dies parsing it — common/no-runtime-workspace-imports.spec.ts),
// so the lists are mirrored here and pinned deep-equal to the shared source by
// import-column-aliases.spec.ts: edit both, or that spec goes red. No `averageCost` entry (SA-136).

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

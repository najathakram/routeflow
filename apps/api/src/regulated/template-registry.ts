/**
 * Single source of truth for report-template metadata: the per-product regulatory
 * vocabulary (item types → their legal UoM codes) and each template's column
 * superset. Pure — no Prisma, no Nest. Served to clients by
 * `GET /regulated/templates` so web and mobile stop hardcoding these lists.
 *
 * Adding a jurisdiction = adding an entry here (+ a row builder for per-sale kinds).
 */

export interface TemplateUomOption {
  code: string;
  label: string;
}
export interface TemplateItemType {
  code: string;
  label: string;
  uoms: TemplateUomOption[];
}
export interface TemplateColumn {
  key: string;
  label: string;
  align?: "right";
  /** In the template's official/default layout. Non-default columns make a report "custom". */
  default: boolean;
}
export interface ReportTemplateDef {
  key: string;
  label: string;
  kind: "per-sale" | "aggregate";
  /** null ⇒ this template needs no per-product config. */
  productConfig: { itemTypes: TemplateItemType[]; caseUomSupported: boolean } | null;
  columns: TemplateColumn[];
}

const TX_COLUMNS: TemplateColumn[] = [
  { key: "wholesalerPermit", label: "Wholesaler Permit #", default: true },
  { key: "retailerTaxpayerId", label: "Retailer Taxpayer ID", default: true },
  { key: "retailerName", label: "Retailer Name", default: true },
  { key: "retailerStreet", label: "Retailer Street Address", default: true },
  { key: "retailerCity", label: "Retailer City", default: true },
  { key: "state", label: "State", default: true },
  { key: "zip", label: "ZIP", default: true },
  { key: "retailerPermit", label: "Retailer Permit #", default: true },
  { key: "itemType", label: "Item Type", default: true },
  { key: "uom", label: "Unit of Measure", default: true },
  { key: "quantity", label: "Quantity", align: "right", default: true },
  { key: "invoiceAmount", label: "Invoice Amount", align: "right", default: true },
  // Optional extras — selecting any of these makes the layout non-official.
  { key: "itemDescription", label: "Item Description", default: false },
  { key: "invoiceNumber", label: "Invoice #", default: false },
  { key: "invoiceDate", label: "Invoice Date", default: false },
];

// Aggregate (period-bucket) templates mirror the exact column `key` values emitted
// by filing-csv.ts#buildAggregateReport for each template — see the switch there.
// Labels may differ (CA_CDTFA interpolates unitBasis at build time); projection
// matches on key only, so drift in the key values would silently break requests.
const GENERIC_COLUMNS: TemplateColumn[] = [
  { key: "period", label: "Period", default: true },
  { key: "qty", label: "Qty", align: "right", default: true },
  { key: "unitBasisQty", label: "Unit Basis Qty", align: "right", default: true },
  { key: "netSales", label: "Net Sales", align: "right", default: true },
  { key: "categoryTax", label: "Category Tax", align: "right", default: true },
];

const CA_CDTFA_COLUMNS: TemplateColumn[] = [
  { key: "period", label: "Period", default: true },
  { key: "units", label: "Units", align: "right", default: true },
  { key: "netSales", label: "Net Sales", align: "right", default: true },
  { key: "tax", label: "Excise Tax Due", align: "right", default: true },
];

const CA_ABC_COLUMNS: TemplateColumn[] = [
  { key: "period", label: "Period", default: true },
  { key: "volume", label: "Volume", align: "right", default: true },
  { key: "netSales", label: "Net Sales", align: "right", default: true },
  { key: "tax", label: "Tax", align: "right", default: true },
];

const CALRECYCLE_COLUMNS: TemplateColumn[] = [
  { key: "period", label: "Period", default: true },
  { key: "containers", label: "Containers", align: "right", default: true },
  { key: "netSales", label: "Net Sales", align: "right", default: true },
  { key: "deposit", label: "CRV Deposit", align: "right", default: true },
];

export const REPORT_TEMPLATES: ReportTemplateDef[] = [
  {
    key: "TX_COMPTROLLER",
    label: "TX Comptroller",
    kind: "per-sale",
    productConfig: {
      caseUomSupported: true,
      itemTypes: [
        {
          code: "1",
          label: "Cigarettes",
          uoms: [
            { code: "CP", label: "CP — Packs" },
            { code: "CS", label: "CS — Sticks" },
            { code: "CC", label: "CC — Cartons" },
          ],
        },
        {
          code: "2",
          label: "Cigars",
          uoms: [
            { code: "SB", label: "SB — Class B sticks" },
            { code: "SC", label: "SC — Class C sticks" },
            { code: "SD", label: "SD — Class D sticks" },
            { code: "SF", label: "SF — Class F sticks" },
          ],
        },
        {
          code: "3",
          label: "Tobacco",
          uoms: [
            { code: "WO", label: "WO — Ounces" },
            { code: "WN", label: "WN — Number (cans/packages)" },
          ],
        },
      ],
    },
    columns: TX_COLUMNS,
  },
  // Aggregate templates: no per-product config.
  {
    key: "GENERIC",
    label: "Generic",
    kind: "aggregate",
    productConfig: null,
    columns: GENERIC_COLUMNS,
  },
  {
    key: "CA_CDTFA",
    label: "CA CDTFA Excise",
    kind: "aggregate",
    productConfig: null,
    columns: CA_CDTFA_COLUMNS,
  },
  {
    key: "CA_ABC",
    label: "CA ABC Alcohol",
    kind: "aggregate",
    productConfig: null,
    columns: CA_ABC_COLUMNS,
  },
  {
    key: "CALRECYCLE",
    label: "CalRecycle CRV",
    kind: "aggregate",
    productConfig: null,
    columns: CALRECYCLE_COLUMNS,
  },
];

export function templateByKey(key: string): ReportTemplateDef | undefined {
  return REPORT_TEMPLATES.find((t) => t.key === key);
}

export function defaultColumnKeys(templateKey: string): string[] {
  return (templateByKey(templateKey)?.columns ?? []).filter((c) => c.default).map((c) => c.key);
}

export function allColumnKeys(templateKey: string): string[] {
  return (templateByKey(templateKey)?.columns ?? []).map((c) => c.key);
}

export function isValidItemType(templateKey: string, itemType: string): boolean {
  const cfg = templateByKey(templateKey)?.productConfig;
  return !!cfg?.itemTypes.some((t) => t.code === itemType);
}

/** When `itemType` is null the UoM is accepted if ANY item type allows it. */
export function isValidUom(templateKey: string, itemType: string | null, uom: string): boolean {
  const cfg = templateByKey(templateKey)?.productConfig;
  if (!cfg) return false;
  const types = itemType ? cfg.itemTypes.filter((t) => t.code === itemType) : cfg.itemTypes;
  return types.some((t) => t.uoms.some((u) => u.code === uom));
}

/** Human label for an item-type code; "" when unknown or unset. */
export function itemTypeLabel(templateKey: string, itemType: string | null): string {
  if (!itemType) return "";
  const cfg = templateByKey(templateKey)?.productConfig;
  return cfg?.itemTypes.find((t) => t.code === itemType)?.label ?? "";
}

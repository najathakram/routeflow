// Code-made synthetic fixtures for the legacy-import tests (SA-1295 A1). Every name is an
// "acme" placeholder. This builds the SHAPE of a desktop sales-lines export (counts and header
// layout only); no real file, customer, product or invoice number is read or copied here.

/** Column order of the sample shape. Index 4 is the description column. */
export const SAMPLE_DESCRIPTION_HEADER = "Item Descripton";
export const SAMPLE_HEADERS: readonly string[] = [
  "Invoice Number",
  "Customer Name",
  "Invoice Date",
  "Item Name",
  SAMPLE_DESCRIPTION_HEADER,
  "Quantity",
  "Item Price",
  "Total",
  "SKU",
];

export type SalesRow = [
  invoice: string,
  customer: string,
  date: string,
  item: string,
  description: string,
  qty: string,
  price: string,
  total: string,
  sku: string,
];

export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface SalesCsvOptions {
  /** Raw bytes put before the header (e.g. [0xa0] or a BOM). */
  lead?: number[];
  headers?: readonly string[];
  /** Record terminator; the sample shape ends records with CRLF. */
  eol?: string;
}

/** Build the bytes of a sales-lines CSV from string rows. */
export function salesCsv(rows: readonly string[][], opts: SalesCsvOptions = {}): Buffer {
  const eol = opts.eol ?? "\r\n";
  const lines = [(opts.headers ?? SAMPLE_HEADERS).map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return Buffer.concat([Buffer.from(opts.lead ?? []), Buffer.from(lines.join(eol) + eol, "utf8")]);
}

export interface SyntheticSalesFile {
  bytes: Buffer;
  /** 1-based physical line where the short row starts; null when none was built. */
  shortRowPhysicalLine: number | null;
  documentCount: number;
}

/**
 * The synthetic twin: a leading 0xA0, CRLF record ends, 170 data rows in 50 documents, 25 rows
 * with multi-line descriptions (bare LF inside quotes), 4 rows with a UTF-8 em dash, and
 * optionally one short row (8 cells instead of 9). Deterministic: no random data.
 */
export function buildSyntheticSalesFile(opts: { withShortRow: boolean }): SyntheticSalesFile {
  const rows: string[][] = [];
  const docs = 50;
  let multi = 0;
  let dashes = 0;
  for (let i = 0; i < 170; i++) {
    const doc = Math.min(docs - 1, Math.floor(i / 3.4));
    const number = String(1000 + doc);
    const day = 1 + (doc % 28);
    let description = `Acme item ${i}`;
    if (i % 7 === 0 && multi < 25) {
      description = `Acme item ${i}\nsecond line\nthird line`;
      multi++;
    }
    if ([10, 60, 110, 160].includes(i) && dashes < 4) {
      description = `${description} — acme note`;
      dashes++;
    }
    rows.push([
      number,
      "Acme Foods",
      `${1 + (doc % 12)}/${day}/2025`,
      `ACMECAT:Widget ${i % 45}`,
      description,
      "2",
      "5.00",
      "10.00",
      "",
    ]);
  }
  let shortRowIndex: number | null = null;
  if (opts.withShortRow) {
    shortRowIndex = 99;
    rows[shortRowIndex] = rows[shortRowIndex].slice(0, 8);
  }
  const bytes = salesCsv(rows, { lead: [0xa0] });
  let shortRowPhysicalLine: number | null = null;
  if (shortRowIndex !== null) {
    // header is physical line 1; each earlier row spans (1 + LF count) lines
    let line = 2;
    for (let i = 0; i < shortRowIndex; i++) line += 1 + (rows[i][4].match(/\n/g)?.length ?? 0);
    shortRowPhysicalLine = line;
  }
  return { bytes, shortRowPhysicalLine, documentCount: new Set(rows.map((r) => r[0])).size };
}

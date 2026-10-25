import type { StageRow } from "@/lib/api/migration";

/** The price text a product carries when its row had an unclosed quote: not a number, so the API skips it as bad-price. */
export const UNCLOSED_QUOTE_PRICE = "unclosed quote";

/**
 * RFC 4180 reader: quoted fields may hold commas, doubled quotes and newlines (a quote opens a field after optional
 * leading spaces). Blank lines are dropped and a leading UTF-8 BOM is ignored. (B205: the Migration Hub used a bare
 * split(","), so an Excel export's "1,234.56" shifted every later column.)
 *
 * A quote that is never closed does not eat the rest of the file: that quote is read as a literal character, the
 * parse resumes after it, and the row it sat in is reported in `badRows` (indexes into `rows`).
 */
export function splitCsvChecked(text: string): { rows: string[][]; badRows: Set<number> } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  const badRows = new Set<number>();
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let rowBad = false;
  let open: { at: number; row: string[]; cell: string } | null = null;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((c) => c.trim() !== "")) {
      if (rowBad) badRows.add(rows.length);
      rows.push(row);
    }
    row = [];
    rowBad = false;
  };
  let i = 0;
  for (;;) {
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            quoted = false;
            open = null;
          }
        } else cell += ch;
      } else if (ch === '"' && cell.trim() === "") {
        open = { at: i, row: [...row], cell };
        cell = "";
        quoted = true;
      } else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && src[i + 1] === "\n") i++;
        endRow();
      } else cell += ch;
    }
    if (!quoted || !open) break;
    // Never closed: rewind to the opening quote, keep it as text, flag the row, and read on from the next character.
    row = open.row;
    cell = open.cell + '"';
    rowBad = true;
    quoted = false;
    i = open.at + 1;
    open = null;
  }
  if (cell !== "" || row.length > 0) endRow();
  return { rows, badRows };
}

export function splitCsv(text: string): string[][] {
  return splitCsvChecked(text).rows;
}

/**
 * Products-CSV for the Migration Hub staging step. Expects a header row with name / sku / price (or pricePerUnit) /
 * unit / category columns (case-insensitive). The price is passed through as the cell text: the API normalises
 * "1,234.56" and refuses a non-number, so the browser never guesses a number. A row with an unclosed quote carries
 * UNCLOSED_QUOTE_PRICE so the API skips it instead of pricing a mangled cell.
 */
export function parseProductsCsv(text: string): StageRow[] {
  const { rows: table, badRows } = splitCsvChecked(text);
  if (table.length < 2) return [];
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iName = col("name");
  const iSku = col("sku");
  const iPrice = col("price") >= 0 ? col("price") : col("priceperunit");
  const iUnit = col("unit");
  const iCat = col("category");
  const cell = (cols: string[], i: number) => (i >= 0 ? cols[i]?.trim() : undefined);
  return table
    .slice(1)
    .map((cols, idx): StageRow => {
      const sku = cell(cols, iSku);
      return {
        entityType: "PRODUCT",
        externalId: sku || undefined,
        payload: {
          name: cell(cols, iName),
          sku,
          pricePerUnit: badRows.has(idx + 1) ? UNCLOSED_QUOTE_PRICE : cell(cols, iPrice),
          unit: cell(cols, iUnit),
          category: cell(cols, iCat),
        },
      };
    })
    .filter((r) => !!r.payload.name);
}

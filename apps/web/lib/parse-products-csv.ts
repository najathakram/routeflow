import type { StageRow } from "@/lib/api/migration";

/**
 * RFC 4180 reader: quoted fields may hold commas, doubled quotes and newlines. Blank lines are dropped and a leading
 * UTF-8 BOM is ignored. (B205: the Migration Hub used a bare split(","), so an Excel export's "1,234.56" shifted every
 * later column.)
 */
export function splitCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Products-CSV for the Migration Hub staging step. Expects a header row with name / sku / price (or pricePerUnit) /
 * unit / category columns (case-insensitive). The price is passed through as the cell text: the API normalises
 * "1,234.56" and refuses a non-number, so the browser never guesses a number.
 */
export function parseProductsCsv(text: string): StageRow[] {
  const table = splitCsv(text);
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
    .map((cols): StageRow => {
      const sku = cell(cols, iSku);
      return {
        entityType: "PRODUCT",
        externalId: sku || undefined,
        payload: {
          name: cell(cols, iName),
          sku,
          pricePerUnit: cell(cols, iPrice),
          unit: cell(cols, iUnit),
          category: cell(cols, iCat),
        },
      };
    })
    .filter((r) => !!r.payload.name);
}

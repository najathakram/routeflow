import { parseMoney, parseQuantity, type NumberParse } from "../parse/parse-money";
import { defineAdapter, type AdaptInput } from "./adapter-types";
import type { CanonicalLine, LineDefect } from "./canonical";

// The sales-lines shape of the first sample: 9 columns, one row per document line, no type,
// payment, balance, tax, due-date or status column (so linksKnown is false). The signature is the
// eight verified column names in order; the description column is one name in slot 5 whose
// spelling is NOT verified here (the design records it only as "misspelled"), so any name that is
// not one of the other eight is accepted there.

const NAMES = [
  "Invoice Number",
  "Customer Name",
  "Invoice Date",
  "Item Name",
  null, // description, spelling unverified
  "Quantity",
  "Item Price",
  "Total",
  "SKU",
] as const;

const COL = {
  number: 0,
  customer: 1,
  date: 2,
  item: 3,
  description: 4,
  quantity: 5,
  price: 6,
  total: 7,
  sku: 8,
} as const;

function blankToNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

function isoDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export const SALES_LINES_SAMPLE_ADAPTER = defineAdapter({
  key: "desktop-sales-lines-sample",
  version: 1,
  fileKind: "SALES_LINES",
  linksKnown: false,

  matches(headers) {
    if (headers.length !== NAMES.length) return false;
    const fixed = NAMES.filter((n): n is NonNullable<typeof n> => n !== null);
    return NAMES.every((name, i) =>
      name === null
        ? headers[i] !== "" && !fixed.includes(headers[i] as (typeof fixed)[number])
        : headers[i] === name,
    );
  },

  adaptRecord({ headers, cells, recordNo, physicalLine }: AdaptInput) {
    const defects: LineDefect[] = [];
    const cell = (i: number) => cells[i] ?? "";

    const read = (i: number, parser: (s: string) => NumberParse, code: LineDefect["code"]) => {
      const raw = cell(i);
      const r = parser(raw);
      if (r.ok) return r.value;
      if (r.reason !== "EMPTY") {
        defects.push({
          code,
          column: headers[i],
          message: `"${raw.trim()}" is refused (${r.reason}).`,
        });
      }
      return null;
    };

    const rawDate = cell(COL.date);
    const issueDate = rawDate.trim() === "" ? null : isoDate(rawDate);
    if (rawDate.trim() !== "" && issueDate === null) {
      defects.push({
        code: "BAD_DATE",
        column: headers[COL.date],
        message: `"${rawDate.trim()}" is not a month/day/year date.`,
      });
    }

    const line: CanonicalLine = {
      recordNo,
      physicalLine,
      docNumber: cell(COL.number).trim(),
      customerName: cell(COL.customer).trim(),
      issueDate,
      itemName: blankToNull(cell(COL.item)),
      description: blankToNull(cell(COL.description)) === null ? null : cell(COL.description),
      quantity: read(COL.quantity, parseQuantity, "BAD_QUANTITY"),
      unitPrice: read(COL.price, parseMoney, "BAD_MONEY"),
      total: read(COL.total, parseMoney, "BAD_MONEY"),
      sku: blankToNull(cell(COL.sku)),
      defects,
    };
    return { line };
  },
});

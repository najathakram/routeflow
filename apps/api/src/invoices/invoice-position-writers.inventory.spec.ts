import * as fs from "fs";
import * as path from "path";

/**
 * W-1187 (L-305 inventory): every place an InvoiceItem create payload is built stamps `position` through a helper in
 * invoice-line-position.ts. The copier-contract checker only reads literal keys, so a helper stamp is invisible to it
 * (that is why the registry says `rederived`); this pin is the guard. Per file it fixes how many create sites exist and how
 * many stamp-helper calls sit beside them, so a new create site, or a removed stamp, goes red until it is listed here.
 *
 * A site is any `.invoice.create|createMany|update|upsert(` call (whatever the receiver: tx, trx, db, this.prisma.forTenant())
 * whose argument nests `items: { create | createMany }`, or any `.invoiceItem.create|createMany(` call. Limit: the nested
 * write must sit inline in the call (all current sites do); a payload built in a variable first is not seen.
 */
const SRC = path.resolve(__dirname, "..");
const HELPERS = [
  "stampFromOrder",
  "stampInvoicePositions",
  "copyInvoicePositions",
  "stampEditedPositions",
  "nextTailPosition",
];
/** file -> create sites, and the helper calls that stamp them (one call can cover a payload used by one site). */
const WRITERS: Record<string, { creates: number; stamps: Record<string, number> }> = {
  // manual, order bills (create and update shapes), duplicate, edit, append-last (invoiceItem.create)
  "invoices/invoices.service.ts": {
    creates: 8,
    stamps: {
      stampInvoicePositions: 1,
      stampFromOrder: 4,
      stampEditedPositions: 1,
      copyInvoicePositions: 1,
      nextTailPosition: 1,
    },
  },
  "import/import.service.ts": { creates: 1, stamps: { stampInvoicePositions: 1 } },
  // the estimate convert's invoice create
  "estimates/estimates.service.ts": { creates: 1, stamps: { stampInvoicePositions: 1 } },
};
const NESTED = /\bitems:\s*\{\s*(create|createMany)\b/;
const INVOICE_CALL = /\.invoice\.(create|createMany|update|upsert)\(/g;
const ITEM_CALL = /\.invoiceItem\.(create|createMany)\(/g;

const code = (rel: string) =>
  fs
    .readFileSync(path.join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/ .*$/gm, "");
const calls = (src: string, name: string) =>
  (src.match(new RegExp(`(?<!function\\s)\\b${name}\\(`, "g")) ?? []).length;
/** Invoice calls (any receiver) whose argument nests an items create, plus every invoiceItem create call. */
const sites = (src: string) => {
  let n = (src.match(ITEM_CALL) ?? []).length;
  for (const m of src.matchAll(INVOICE_CALL)) {
    let i = m.index! + m[0].length;
    for (let depth = 1; depth && i < src.length; i++)
      depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
    if (NESTED.test(src.slice(m.index!, i))) n++;
  }
  return n;
};

describe("InvoiceItem create payloads all stamp `position` (W-1187)", () => {
  for (const [file, want] of Object.entries(WRITERS)) {
    it(`${file}: ${want.creates} create sites, each stamped by a position helper`, () => {
      const src = code(file);
      expect(sites(src)).toBe(want.creates);
      for (const h of HELPERS) expect([h, calls(src, h)]).toEqual([h, want.stamps[h] ?? 0]);
    });
  }

  it("no other file creates InvoiceItem rows (create, createMany, nested in invoice create/update/upsert)", () => {
    const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
    const files: string[] = [];
    const walk = (dir: string) =>
      fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "testing" ? undefined : walk(p);
        if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) files.push(rel(p));
      });
    walk(SRC);
    const writers = files.filter((f) => sites(code(f)) > 0);
    expect(writers.sort()).toEqual(Object.keys(WRITERS).sort());
  });
});

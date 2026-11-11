import * as fs from "fs";
import * as path from "path";

/**
 * W-1187 (L-305 inventory): every place an InvoiceItem create payload is built stamps `position` through a helper in
 * invoice-line-position.ts. The copier-contract checker only reads literal keys, so a helper stamp is invisible to it
 * (that is why the registry says `rederived`); this pin is the guard. Per file it fixes how many create sites exist and how
 * many stamp-helper calls sit beside them, so a new create site, or a removed stamp, goes red until it is listed here.
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
  // manual 596, order bills 1328 / 1700 / 2136 / 2820, duplicate 4215, edit 3288, append-last 5357
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
  // one estimate create and one invoice create (convert); only the convert is stamped
  "estimates/estimates.service.ts": { creates: 2, stamps: { stampInvoicePositions: 1 } },
};
const CREATE = /\bitems:\s*\{\s*create:|\binvoiceItem\.create\(/g;

const code = (rel: string) =>
  fs
    .readFileSync(path.join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/ .*$/gm, "");
const calls = (src: string, name: string) =>
  (src.match(new RegExp(`(?<!function\\s)\\b${name}\\(`, "g")) ?? []).length;

describe("InvoiceItem create payloads all stamp `position` (W-1187)", () => {
  for (const [file, want] of Object.entries(WRITERS)) {
    it(`${file}: ${want.creates} create sites, each stamped by a position helper`, () => {
      const src = code(file);
      expect((src.match(CREATE) ?? []).length).toBe(want.creates);
      for (const h of HELPERS) expect([h, calls(src, h)]).toEqual([h, want.stamps[h] ?? 0]);
    });
  }

  it("no other file creates an invoice with lines or an InvoiceItem row", () => {
    const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
    const files: string[] = [];
    const walk = (dir: string) =>
      fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "testing" ? undefined : walk(p);
        if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) files.push(rel(p));
      });
    walk(SRC);
    const writers = files.filter((f) =>
      /\b(tx|db)\.invoice\.create\(|\binvoiceItem\.create(Many)?\(/.test(code(f)),
    );
    expect(writers.sort()).toEqual(Object.keys(WRITERS).sort());
  });
});

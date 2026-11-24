/**
 * W-1199 (SA-1261 Y-e): a document number's year is the TENANT's calendar year (`numberYear`, common/number-year.ts),
 * never the server clock's. Class pin, so a fourteenth site cannot return: no non-test api file that calls
 * `reserveNext` or builds a `-${year}-` number prefix may read `getFullYear()` / `getUTCFullYear()`.
 *
 * Two allow-listed files, each with the EXACT number of clock-year reads it may keep (a new read in either fails):
 * the platform's own invoice (`RF-YYYY-`, numbered in the UTC year by design) and the import's calendar-day parse
 * (`importCalendarDay` reads the PARSED value's fields, never the clock). The list is exact both ways.
 */
import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";

const SRC = join(__dirname, "..");

const ALLOWED: Record<string, { reads: number; why: string }> = {
  "billing/rf-invoice/rf-invoice-number.ts": {
    reads: 1,
    why: "RouteFlow's own platform invoices (RF-YYYY-) are numbered in the UTC year, by design; no tenant zone applies.",
  },
  "import/import.service.ts": {
    reads: 1,
    why: "importCalendarDay reads the fields of a parsed import cell (a calendar day), not the server clock; the numbering year there is numberYear.",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const CLOCK_YEAR = /\bget(UTC)?FullYear\(\)/;
const MINTS_A_NUMBER = /\breserveNext\(|-\$\{\s*year\s*\}-/;

function inClass(): Map<string, number> {
  const found = new Map<string, number>();
  for (const f of walk(SRC)) {
    const text = readFileSync(f, "utf8");
    const reads = (text.match(new RegExp(CLOCK_YEAR.source, "g")) ?? []).length;
    if (reads > 0 && MINTS_A_NUMBER.test(text)) {
      found.set(relative(SRC, f).split(sep).join("/"), reads);
    }
  }
  return found;
}

describe("no server-clock year in a document number (W-1199 Y-e)", () => {
  it("only the allow-listed files read a clock year next to a number mint, and only that many times", () => {
    const over = [...inClass()].filter(([f, n]) => n > (ALLOWED[f]?.reads ?? 0));
    expect(over).toEqual([]);
  });

  it("every allow-list entry still matches the class exactly, with a reason", () => {
    const found = inClass();
    for (const [file, { reads, why }] of Object.entries(ALLOWED)) {
      expect(found.get(file)).toBe(reads);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});

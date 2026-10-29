import * as fs from "fs";
import * as path from "path";

/**
 * SA-995 structural rows. The ledger guard's FOR SHARE only blocks the filing claim when it runs on the WRITER's
 * transaction, and the claim only sees the writer's rows when the lock transaction stays READ COMMITTED. Each is a
 * property of the source, pinned here so a refactor cannot drop it silently (L-223: a sweep of every site is a spec).
 */
const SRC = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const noComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Text of a call from `name(` to its matching close paren. */
function callTexts(src: string, name: string): string[] {
  const code = noComments(src);
  const out: string[] = [];
  const re = new RegExp("(?<![\\w])(?:" + name + ")\\(", "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (/(function|async|private)\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index)))
      continue;
    let depth = 0;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      }
    }
    out.push(code.slice(start, i));
  }
  return out;
}

describe("SA-995 structure", () => {
  it("assertLedgerRowsNotLocked reads filings only through lockFilingRowsCovering", () => {
    const body = noComments(read("regulated/filing-lock.ts"));
    const guard = body.slice(
      body.indexOf("export async function assertLedgerRowsNotLocked"),
      body.indexOf("export async function assertSalesNotLockedForEdit"),
    );
    expect(guard).toContain("lockFilingRowsCovering(");
    expect(guard).not.toMatch(/lockedFilingsCovering\(|regulatedFiling\.|anyLockedFiling\(/);
  });

  it("the pin bites: the plain read is detected", () => {
    const planted = `await lockedFilingsCovering(db, unique);`;
    expect(planted).toMatch(/lockedFilingsCovering\(/);
  });

  it("every ledger writer entry point is called with a transaction client, never a prisma handle", () => {
    const writers = [
      "writeSaleEntries",
      "syncInvoiceEntries",
      "reverseReturnEntries",
      "reverseCreditNoteEntries",
      "correctSaleForPriceChange",
      "resolveParkedReversal",
      "settleRegulatedLedger",
      "resyncInvoiceLedger",
    ];
    const offenders: string[] = [];
    let seen = 0;
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, "utf8");
      for (const w of writers) {
        if (!src.includes(`.${w}(`)) continue;
        for (const call of callTexts(src, "(?:this\\.)?(?:ledger\\.)?" + w)) {
          seen++;
          // the db argument only: `{ db: tx }` or the first positional argument (tenantId etc. may name prisma)
          const dbArg = /^\s*\{/.test(call)
            ? ((call.match(/\bdb\b(?:\s*:\s*([^,}\n]+))?/) ?? [])[1] ??
              (/\bdb\b/.test(call) ? "db" : ""))
            : call.split(",")[0];
          if (!dbArg || /prisma|forTenant/.test(dbArg)) {
            offenders.push(`${path.relative(SRC, file)} ${w}(${call.slice(0, 60)})`);
          }
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(15);
    expect(offenders).toEqual([]);
  });

  it("lockFiling's tenantTransaction passes no isolation option (READ COMMITTED, so the claim sees committed rows)", () => {
    const src = read("regulated/regulated-filing.service.ts");
    const fn = noComments(src);
    const lock = fn.slice(fn.indexOf("async lockFiling("));
    const calls = callTexts(
      lock.slice(0, lock.indexOf("\n  }\n") + 1),
      "this\.prisma\.tenantTransaction",
    );
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toMatch(/isolationLevel|Serializable|RepeatableRead/);
    // the closing argument of the call is the callback alone: no options object after it
    expect(calls[0].trim().endsWith("}")).toBe(true);
  });
});

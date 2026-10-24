import * as fs from "fs";
import * as path from "path";

/**
 * SA-819 MUST 2: every `regulatedSalesLedger.create` / `createMany` / `deleteMany` in `src` calls the ledger
 * guard (`assertLedgerRowsNotLocked`, 409 LEDGER_PERIOD_LOCKED) BEFORE it. A new writer, or a guard dropped from
 * an old one, turns this red (L-223: a "single writer" claim needs a sweep of every site, so the sweep is a spec).
 *
 * The scan reads the source tree from disk (not `git grep`), so an untracked new file is covered too.
 */
const SRC = path.join(__dirname, "..");
const WRITE = /regulatedSalesLedger\??\.(createMany|create|deleteMany)\s*\(/g;
const GUARD = "assertLedgerRowsNotLocked(";
/** How many lines above a write the guard call must sit (same block, same statement run). */
const WINDOW = 4;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.(spec|test)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

interface Site {
  file: string;
  method: string;
  call: string;
  line: number;
  guarded: boolean;
}

function sites(): Site[] {
  const found: Site[] = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("regulatedSalesLedger")) continue;
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return; // a comment mentioning a write is not a write
      for (const m of l.matchAll(WRITE)) {
        let method = "?";
        for (let j = i; j >= 0; j--) {
          const d = lines[j].match(
            /^\s{2}(?:private\s+|static\s+)*(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\(/,
          );
          if (d && !["if", "for", "while", "switch", "catch"].includes(d[1])) {
            method = d[1];
            break;
          }
        }
        const above = lines.slice(Math.max(0, i - WINDOW), i + 1).join("\n");
        found.push({
          file: path.relative(SRC, file),
          method,
          call: m[1],
          line: i + 1,
          guarded: above.includes(GUARD),
        });
      }
    });
  }
  return found;
}

describe("SA-819 MUST 2: every regulated ledger writer calls the ledger guard first", () => {
  const all = sites();

  it("lists every write site in src (a new one must be added here, with its guard)", () => {
    expect(all.map((s) => `${s.file}#${s.method}.${s.call}`).sort()).toEqual(
      [
        "regulated/regulated-ledger.service.ts#writeSaleEntries.createMany",
        "regulated/regulated-ledger.service.ts#reverseInvoiceEntries.createMany",
        "regulated/regulated-ledger.service.ts#counterDocumentRows.createMany",
        "regulated/regulated-ledger.service.ts#syncInvoiceEntries.createMany",
        "regulated/regulated-ledger.service.ts#reverseReturnEntries.createMany",
        "regulated/regulated-ledger.service.ts#reverseCreditNoteEntries.createMany",
        "regulated/regulated-ledger.service.ts#correctSaleForPriceChange.createMany",
        // resolveParkedReversal: the SALE basis correction, each earlier reversal's correction, and the
        // booked chunks (SA-819 MUST 2: current bucket today, guarded for the class)
        "regulated/regulated-ledger.service.ts#resolveParkedReversal.create",
        "regulated/regulated-ledger.service.ts#resolveParkedReversal.create",
        "regulated/regulated-ledger.service.ts#resolveParkedReversal.create",
      ].sort(),
    );
  });

  it("has the guard in the lines above each write", () => {
    const unguarded = all.filter((s) => !s.guarded).map((s) => `${s.file}:${s.line} ${s.call}`);
    expect(unguarded).toEqual([]);
  });

  it("has no ledger deleteMany at all (SA-839 F1: an undo books counter-entries, never a delete)", () => {
    expect(all.filter((s) => s.call === "deleteMany")).toEqual([]);
  });
});

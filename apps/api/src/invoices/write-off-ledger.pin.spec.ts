/**
 * SA-1050 A-2 (G4, OP-7) — repo-truth pin: the bad-debt ledger has ONE writer and is append-only.
 *
 * `InvoiceWriteOffEvent` rows are a past period's bad-debt expense, and the database cannot enforce what the one writer
 * enforces by construction (the exact negative on a REINSTATE, the tenant of the LOCKED invoice, cents). So:
 *   - exactly one `invoiceWriteOffEvent.create(` in apps/api (src and scripts, non-spec): `appendWriteOffEvent`;
 *   - no `createMany`, `update`, `updateMany` or `upsert` on the model, and no raw INSERT into its table: append-only;
 *   - `invoiceWriteOffEvent.delete*` only at A-1's WIPE sites (invoice-delete-site-classes.ts);
 *   - the append function's body contains `roundMoney(` and `getTenantId(`.
 *
 * Runs in the repo-truth lane (`jest -c jest.repo-truth.config.js`).
 */
import * as fs from "fs";
import * as path from "path";
import { INVOICE_DELETE_SITE_CLASSES } from "./invoice-delete-site-classes";

const API_ROOT = path.resolve(__dirname, "..", "..");
const SCAN_ROOTS = ["src", "scripts"];
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const WRITER_FILE = "src/invoices/invoice-write-off.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name) && !/\.spec\.[tj]sx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** A source file's non-comment lines (a doc comment that names a call is not a call site). */
function codeLines(text: string): string[] {
  return text.split("\n").filter((line) => {
    const t = line.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });
}

const files = SCAN_ROOTS.flatMap((root) => walk(path.join(API_ROOT, root))).map((abs) => ({
  rel: path.relative(API_ROOT, abs).split(path.sep).join("/"),
  code: codeLines(fs.readFileSync(abs, "utf8")).join("\n"),
}));

/** Files (relative to apps/api) whose code matches `re`, with the match count. */
const matches = (re: RegExp) =>
  files.map((f) => ({ rel: f.rel, n: (f.code.match(re) ?? []).length })).filter((f) => f.n > 0);

describe("SA-1050 A-2: the write-off ledger has one writer and is append-only (repo truth)", () => {
  it("exactly one invoiceWriteOffEvent.create( in apps/api: appendWriteOffEvent", () => {
    expect(matches(/\binvoiceWriteOffEvent\.create\(/g)).toEqual([{ rel: WRITER_FILE, n: 1 }]);
  });

  it("the table is append-only: no createMany, update, updateMany, upsert or raw INSERT", () => {
    expect(
      matches(
        /\binvoiceWriteOffEvent\.(createMany|createManyAndReturn|update|updateMany|upsert)\(/g,
      ),
    ).toEqual([]);
    expect(matches(/INSERT\s+INTO\s+"?InvoiceWriteOffEvent/gi)).toEqual([]);
    expect(matches(/UPDATE\s+"?InvoiceWriteOffEvent/gi)).toEqual([]);
  });

  it("invoiceWriteOffEvent.delete* appears only at A-1's WIPE sites", () => {
    const wipeSites = Object.entries(INVOICE_DELETE_SITE_CLASSES)
      .filter(([, cls]) => cls === "WIPE")
      .map(([rel]) => rel);
    const deleters = matches(/\binvoiceWriteOffEvent\.(delete|deleteMany)\(/g).map((m) => m.rel);
    expect(deleters.sort()).toEqual(wipeSites.sort());
  });

  it("the append function's body contains roundMoney( and getTenantId(", () => {
    const text = fs.readFileSync(path.join(API_ROOT, WRITER_FILE), "utf8");
    const start = text.indexOf("export async function appendWriteOffEvent(");
    expect(start).toBeGreaterThan(-1);
    const open = text.indexOf("{", text.indexOf(")", text.indexOf("input: WriteOffEventInput")));
    let depth = 0;
    let end = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    expect(end).toBeGreaterThan(open);
    const body = text.slice(open, end + 1);
    expect(body).toContain("roundMoney(");
    expect(body).toContain("getTenantId(");
  });
});

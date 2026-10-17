import * as fs from "fs";
import * as path from "path";

/**
 * BO-07 census (L-305): every module that calls useCounterSaleGate is listed here, so a NEW reader of the gate must be
 * added on purpose, with its till-permission behaviour thought through (`showButton` / `opensAsCounter` already fold in
 * `mayUseTill`; a reader of `capability` alone does not hide anything).
 */
const WEB = path.resolve(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "coverage", "e2e", "dist"]);
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !TEST_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

const DEFINITION = "lib/api/counter-sale.ts";
const CONSUMERS: Record<string, string> = {
  "app/(dashboard)/dashboard/page.tsx":
    "header Counter sale + Invoice a customer (showButton, deniedGroups)",
  "app/(dashboard)/invoices/[id]/page.tsx": "capability only: wording, nothing hidden",
  "app/(dashboard)/layout.tsx": "sidebar, drawer and g t (showButton)",
  "app/(dashboard)/orders/_components/CounterSaleScreen.tsx":
    "the screen: no-access panel (mayUseTill)",
  "app/(dashboard)/orders/page.tsx":
    "header + New Order opening as the counter (showButton, opensAsCounter)",
  "app/(dashboard)/settings/_components/use-settings-nav.ts":
    "finder rows needing the counter (showButton)",
  "components/CommandPalette.tsx": "New counter sale action (showButton)",
};

describe("useCounterSaleGate readers (census)", () => {
  const readers = walk(WEB)
    .map((f) => path.relative(WEB, f).split(path.sep).join("/"))
    .filter((rel) => rel !== DEFINITION)
    .filter((rel) => /\buseCounterSaleGate\b/.test(fs.readFileSync(path.join(WEB, rel), "utf8")))
    .sort();

  it("is exactly the seven pinned modules", () => {
    expect(readers).toEqual(Object.keys(CONSUMERS).sort());
  });
});

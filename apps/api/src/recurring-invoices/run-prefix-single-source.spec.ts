// B1251 / SA review MUST 2: the two "already billed" lastError prefixes are declared ONCE, in
// packages/types/api/finance.ts. The api writes them, web and mobile read them; a hand-typed copy in any of the
// three would drift silently and turn an "already billed" failure into a retry that bills the cycle twice.
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SENTENCES = [
  "The invoice was created but could not be emailed",
  "The invoice was created but the run could not be finalized",
];
const CONSUMERS = [
  "apps/api/src/recurring-invoices/recurring-invoices.service.ts",
  "apps/web/lib/api/invoices.ts",
  "apps/mobile/lib/recurring-invoices-logic.ts",
];

describe("recurring run prefixes: one source", () => {
  it("finance.ts declares both sentences exactly once", () => {
    const src = read("packages/types/api/finance.ts");
    for (const s of SENTENCES) expect(src.split(`"${s}"`)).toHaveLength(2);
  });
  it.each(CONSUMERS)("%s has no copy of either sentence and imports the constants", (p) => {
    const src = read(p);
    for (const s of SENTENCES) expect(src).not.toContain(`"${s}`);
    expect(src).toMatch(/RUN_SEND_FAILED_PREFIX/);
    expect(src).toMatch(/RUN_UNFINALIZED_PREFIX/);
    expect(src).toMatch(/from "@routeflow\/types(\/api\/finance)?"/);
  });
});

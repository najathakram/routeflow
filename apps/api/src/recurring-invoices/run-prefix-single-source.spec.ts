// B1251: the two "already billed" lastError prefixes are declared in packages/types/api/finance.ts (web and mobile
// import them; their bundlers compile the package). The api cannot value-import @routeflow/types (raw TS, no build:
// node dist/main.js would crash at require), so it keeps literals, and THIS spec pins them equal to the shared values.
// A hand-typed copy that drifts would turn an "already billed" failure into a retry that bills the cycle twice.
import { readFileSync } from "fs";
import { join } from "path";
import { RUN_SEND_FAILED_PREFIX, RUN_UNFINALIZED_PREFIX } from "@routeflow/types";
import { RUN_SEND_FAILED_ERROR, RUN_UNFINALIZED_ERROR } from "./recurring-invoices.service";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SENTENCES = [
  "The invoice was created but could not be emailed",
  "The invoice was created but the run could not be finalized",
];

describe("recurring run prefixes: one shared value", () => {
  it("the api literals equal the @routeflow/types values", () => {
    expect(RUN_SEND_FAILED_ERROR).toBe(RUN_SEND_FAILED_PREFIX);
    expect(RUN_UNFINALIZED_ERROR).toBe(RUN_UNFINALIZED_PREFIX);
    expect([RUN_SEND_FAILED_PREFIX, RUN_UNFINALIZED_PREFIX]).toEqual(SENTENCES);
  });
  it.each(["apps/web/lib/api/invoices.ts", "apps/mobile/lib/recurring-invoices-logic.ts"])(
    "%s has no copy of either sentence and imports the shared constants",
    (p) => {
      const src = read(p);
      for (const s of SENTENCES) expect(src).not.toContain(`"${s}`);
      expect(src).toMatch(/RUN_SEND_FAILED_PREFIX/);
      expect(src).toMatch(/RUN_UNFINALIZED_PREFIX/);
      expect(src).toMatch(/from "@routeflow\/types(\/api\/finance)?"/);
    },
  );
});

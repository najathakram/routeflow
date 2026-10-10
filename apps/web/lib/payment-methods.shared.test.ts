import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { PAYMENT_METHOD_VALUES } from "@routeflow/types";
import { ALL_PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "./payment-methods";

// #2722 (L-072): the payment-method SET comes from @routeflow/types (PAYMENT_METHOD_VALUES, pinned to
// Prisma by the api's enum-parity.spec). No client file may hand-type a union or list of method
// literals that is not constrained by the shared PaymentMethod in the same statement.
const METHOD = "CASH|CHECK|ZELLE|ACH|CREDIT_CARD|OTHER|CREDIT_NOTE|ADVANCE";
const PAIR = new RegExp(`"(${METHOD})"\\s*[|,]\\s*(?:\\.\\.\\.[A-Z_]+,\\s*)?"(${METHOD})"`, "g");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("payment methods come from @routeflow/types (#2722)", () => {
  it("ALL_PAYMENT_METHODS is exactly the shared PaymentMethod set, and every one has a label", () => {
    expect([...ALL_PAYMENT_METHODS].sort()).toEqual([...PAYMENT_METHOD_VALUES].sort());
    for (const m of PAYMENT_METHOD_VALUES) expect(PAYMENT_METHOD_LABELS[m]).toBeTruthy();
  });

  it("no source file hand-types a payment-method union or list outside the shared type", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    for (const dir of ["app", "components", "lib"]) {
      for (const f of sources(join(root, dir))) {
        const s = readFileSync(f, "utf8");
        for (const m of s.matchAll(PAIR)) {
          const at = m.index ?? 0;
          const start = Math.max(
            s.lastIndexOf("export ", at),
            s.lastIndexOf("const ", at),
            s.lastIndexOf("type ", at),
            s.lastIndexOf(";", at),
          );
          const end = s.indexOf(";", at);
          if (!/PaymentMethod/.test(s.slice(start, end < 0 ? undefined : end))) {
            offenders.push(`${f.slice(root.length + 1)}:${s.slice(0, at).split("\n").length}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

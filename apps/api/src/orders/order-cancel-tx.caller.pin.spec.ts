import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * Row 653: `cancelOrderInTx`'s `skipDeliveryStateCheck` turns OFF the in-lock delivery-state refusal
 * (`assertCancelDeliveryStateUnderLock`: B56 delivered units, B1234 / B692 legacy rows). It is safe ONLY for the counter-sale
 * void, which undoes its own hand-over first and cancels from DELIVERED alone. A future caller passing `skip: true` with
 * PARTIALLY_DELIVERED in `fromStatuses` would sell back goods the customer already holds, and nothing pinned it.
 *
 * AST pin (a comment or a string never counts), over every production call of `cancelOrderInTx`:
 *  1. the callers are exactly the two classified below (a NEW caller fails until it is classified here);
 *  2. the only caller that sets `skipDeliveryStateCheck: true` is the counter-sale void;
 *  3. that caller's `fromStatuses` is exactly `[OrderStatus.DELIVERED]`; and no skipping caller may list PARTIALLY_DELIVERED.
 */
const SRC = path.resolve(__dirname, "..");
const CALLERS = ["orders/counter-sale/counter-sale-void.service.ts", "orders/orders.service.ts"];

type Call = { file: string; skip: boolean; fromStatuses: string[] | null };

function callsIn(file: string, source: string): Call[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Call[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : "";
      const opts = n.arguments.find(ts.isObjectLiteralExpression);
      if (name === "cancelOrderInTx" && opts) {
        const prop = (key: string) =>
          opts.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key,
          )?.initializer;
        const skip = prop("skipDeliveryStateCheck");
        const from = prop("fromStatuses");
        out.push({
          file,
          skip: skip?.kind === ts.SyntaxKind.TrueKeyword,
          fromStatuses:
            from && ts.isArrayLiteralExpression(from)
              ? from.elements.map((e) => e.getText(sf))
              : null,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const productionCalls = (): Call[] => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.ts$/.test(e.name) && !/\.(spec|db\.spec)\.ts$/.test(e.name) ? [p] : [];
    });
  return walk(SRC).flatMap((f) => {
    const src = fs.readFileSync(f, "utf8");
    return src.includes("cancelOrderInTx")
      ? callsIn(path.relative(SRC, f).split(path.sep).join("/"), src)
      : [];
  });
};

describe("cancelOrderInTx callers (row 653)", () => {
  const calls = productionCalls();

  it("the callers are exactly the two classified (office cancel, counter-sale void)", () => {
    expect([...new Set(calls.map((c) => c.file))].sort()).toEqual(CALLERS);
  });

  it("only the counter-sale void skips the in-lock delivery-state check", () => {
    expect([...new Set(calls.filter((c) => c.skip).map((c) => c.file))]).toEqual([
      "orders/counter-sale/counter-sale-void.service.ts",
    ]);
  });

  it("the skipping caller cancels from [OrderStatus.DELIVERED] alone", () => {
    const skipping = calls.filter((c) => c.skip);
    expect(skipping.length).toBeGreaterThan(0);
    for (const c of skipping) expect(c.fromStatuses).toEqual(["OrderStatus.DELIVERED"]);
  });

  it("no skipping caller may list PARTIALLY_DELIVERED (the generic rule, whoever the caller is)", () => {
    for (const c of calls.filter((x) => x.skip))
      expect((c.fromStatuses ?? []).join(",")).not.toMatch(/PARTIALLY_DELIVERED/);
  });

  describe("the matcher (positive controls on inline source)", () => {
    it("sees a skip=true caller that lists PARTIALLY_DELIVERED", () => {
      const bad = `await this.orders.cancelOrderInTx(tx, order, {
        fromStatuses: [OrderStatus.DELIVERED, OrderStatus.PARTIALLY_DELIVERED],
        skipDeliveryStateCheck: true,
      });`;
      const [c] = callsIn("x.ts", bad);
      expect(c.skip).toBe(true);
      expect(c.fromStatuses).toContain("OrderStatus.PARTIALLY_DELIVERED");
    });

    it("a comment or a string mentioning it is not a call, and skip=false is not a skip", () => {
      expect(
        callsIn(
          "x.ts",
          `// cancelOrderInTx(tx, o, { skipDeliveryStateCheck: true })\nconst s = "cancelOrderInTx";`,
        ),
      ).toEqual([]);
      const [c] = callsIn(
        "x.ts",
        `x.cancelOrderInTx(tx, o, { fromStatuses: [OrderStatus.PENDING], skipDeliveryStateCheck: false });`,
      );
      expect(c.skip).toBe(false);
    });
  });
});

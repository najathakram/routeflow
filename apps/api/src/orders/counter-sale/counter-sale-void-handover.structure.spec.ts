import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import * as ts from "typescript";

// SA-762r: the void restocks in full ONLY because it undoes the hand-over before the cancel. SA-763r: createSale's
// DELIVERED write now stamps deliveredQty = qty (markSaleDelivered -> stampDeliveredInFull, in one tx), so the void's
// reset is no longer a no-op: it is what makes a counter-sale void restock, and the units it zeroes are read first and
// handed to the cancel (bookedFloor) so a cut line is still restocked in full. This spec pins that coupling
// STRUCTURALLY (TypeScript AST: calls, arguments and their order, never a text regex); the real-DB cases "(i)", "(j)",
// "(k)" and "(l)" in counter-sale-void.db.spec.ts seed deliveredQty and prove the restock.
const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);

/** Every node under `root` for which `pick` returns a value. */
function collect<T>(root: ts.Node, pick: (n: ts.Node) => T | undefined): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node) => {
    const v = pick(n);
    if (v !== undefined) out.push(v);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}
/** The callee name of a call: `foo(..)` -> "foo", `a.b.foo(..)` -> "foo". */
const calleeName = (c: ts.CallExpression) =>
  ts.isIdentifier(c.expression)
    ? c.expression.text
    : ts.isPropertyAccessExpression(c.expression)
      ? c.expression.name.text
      : undefined;
const callsOf = (root: ts.Node, name: string) =>
  collect(root, (n) => (ts.isCallExpression(n) && calleeName(n) === name ? n : undefined));
const method = (sf: ts.SourceFile, name: string): ts.Node => {
  const found = collect(sf, (n) =>
    ts.isMethodDeclaration(n) && n.name.getText() === name ? n : undefined,
  );
  expect(found).toHaveLength(1);
  return found[0];
};
const fn = (sf: ts.SourceFile, name: string): ts.Node => {
  const found = collect(sf, (n) =>
    ts.isFunctionDeclaration(n) && n.name?.text === name ? n : undefined,
  );
  expect(found).toHaveLength(1);
  return found[0];
};
/** Identifiers or property names spelled `name` anywhere under `root` (an inline write of that column). */
const mentions = (root: ts.Node, name: string) =>
  collect(root, (n) =>
    (ts.isIdentifier(n) || ts.isPropertyAssignment(n)) &&
    (ts.isIdentifier(n) ? n.text : n.name.getText()) === name
      ? n
      : undefined,
  ).length;

describe("the counter void and the DELIVERED write (structure)", () => {
  it("createSale's DELIVERED write goes through markSaleDelivered, so the void's reset is the net", () => {
    const createSale = method(parse("../orders.service.ts"), "createSale");
    const marks = callsOf(createSale, "markSaleDelivered");
    expect(marks).toHaveLength(1);
    expect(marks[0].arguments[1].getText()).toBe("order.id");
    expect(mentions(createSale, "deliveredQty")).toBe(0); // the stamp lives in delivered-stamp.ts, not inline

    const stamp = parse("../delivered-stamp.ts");
    const markSale = fn(stamp, "markSaleDelivered");
    const tx = callsOf(markSale, "tenantTransaction");
    expect(tx).toHaveLength(1);
    const inTx = tx[0].arguments[0];
    const update = callsOf(inTx, "update").find((c) =>
      c.getText().includes("OrderStatus.DELIVERED"),
    );
    const stampCall = callsOf(inTx, "stampDeliveredInFull")[0];
    expect(update).toBeDefined();
    expect(stampCall.arguments[2].getText()).toBe('"entry"');
    expect(update!.getStart()).toBeLessThan(stampCall.getStart()); // status first, the stamp in the same tx
  });

  it("the void resets the hand-over under the order lock, after the tender voids and BEFORE the cancel unwind", () => {
    const sf = parse("counter-sale-void.service.ts");
    const body = method(sf, "voidInTx");
    const at = (name: string) => {
      const calls = callsOf(body, name);
      expect(calls).toHaveLength(1);
      return calls[0].getStart();
    };
    expect(at("lockOrderAndInvoicesInTx")).toBeLessThan(at("clearUnevidencedDelivered"));
    expect(at("voidPaymentInTx")).toBeLessThan(at("clearUnevidencedDelivered"));
    expect(at("clearUnevidencedDelivered")).toBeLessThan(at("cancelOrderInTx"));
  });

  it("the units still booked out are read BEFORE the reset and handed to the cancel as its bookedFloor (SA-763r)", () => {
    const body = method(parse("counter-sale-void.service.ts"), "voidInTx");
    const floor = callsOf(body, "unevidencedDeliveredFloor")[0];
    const clear = callsOf(body, "clearUnevidencedDelivered")[0];
    const cancel = callsOf(body, "cancelOrderInTx")[0];
    expect(floor).toBeDefined();
    expect(floor.getStart()).toBeLessThan(clear.getStart());
    const opts = cancel.arguments[2] as ts.ObjectLiteralExpression;
    const keys = opts.properties.map((p) => p.name?.getText());
    expect(keys).toContain("bookedFloor");
  });

  it("the reset leaves evidence alone: it asks the delivery-evidence reader which lines have a qualifying row", () => {
    const clear = fn(parse("../delivered-stamp.ts"), "clearUnevidencedDelivered");
    expect(callsOf(clear, "deliveredBasisByLine")).toHaveLength(1);
    expect(callsOf(clear, "hasDeliveryEvidence")).toHaveLength(1);
  });

  it("only the counter-sale void imports clearUnevidencedDelivered (the office cancel and the demotion keep the stamp)", () => {
    const SRC = join(__dirname, "..", "..");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith(".ts") && !p.endsWith(".spec.ts")) out.push(p);
      }
      return out;
    };
    const users = walk(SRC)
      .filter((p) => /clearUnevidencedDelivered/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(SRC.length + 1))
      .sort();
    expect(users).toEqual([
      "orders/counter-sale/counter-sale-void.service.ts",
      "orders/delivered-stamp.ts",
    ]);
  });
});

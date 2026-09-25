/**
 * SA-248 — no API code writes OrderItem.status other than PENDING or CANCELLED.
 *
 * The invoice -> order back-sync (`recomputeOrderFromInvoices`) rewrites every order line it touches with
 * `status: "PENDING"` (a CANCELLED line that an invoice bills is revived; see the DB pin), which is only
 * correct because delivery state lives in Order.status, OrderItem.deliveredQty and DeliveryMutation rows,
 * never in OrderItem.status (ItemStatus also has CONFIRMED / PARTIAL / DELIVERED, but nothing writes them).
 * The day a writer of one of those appears, that reset must be revisited: this spec then fails.
 *
 * AST scan of every non-spec source file: a `status:` assignment to CONFIRMED / PARTIAL / DELIVERED (string
 * literal or `ItemStatus.X`) inside an `<x>.orderItem.<create|createMany|update|updateMany|upsert>(...)` call
 * or inside a `lineItems: { ... }` nested write. `Order.status` writes (e.g. CONFIRMED on an order) are not
 * inside either and are not flagged. Limit: a status taken from a variable is not judged.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC_ROOT = path.resolve(__dirname, "..");
const FORBIDDEN = new Set(["CONFIRMED", "PARTIAL", "DELIVERED"]);
const WRITES = new Set(["create", "createMany", "update", "updateMany", "upsert"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".spec.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const statusValue = (n: ts.Expression): string | null => {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isPropertyAccessExpression(n) && n.expression.getText() === "ItemStatus")
    return n.name.text;
  return null;
};

const isOrderItemWrite = (n: ts.Node): boolean =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  WRITES.has(n.expression.name.text) &&
  ts.isPropertyAccessExpression(n.expression.expression) &&
  n.expression.expression.name.text === "orderItem";

const isLineItemsProp = (n: ts.Node): boolean =>
  ts.isPropertyAssignment(n) && n.name.getText() === "lineItems";

/** Offending `status: <forbidden>` sites in one file's text. */
export function findOrderItemStatusOffenders(text: string): string[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const bad: string[] = [];
  const visit = (n: ts.Node, inWrite: boolean) => {
    const here = inWrite || isOrderItemWrite(n) || isLineItemsProp(n);
    if (here && ts.isPropertyAssignment(n) && n.name.getText() === "status") {
      const v = statusValue(n.initializer);
      if (v && FORBIDDEN.has(v))
        bad.push(`${v} @ line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
    }
    ts.forEachChild(n, (c) => visit(c, here));
  };
  visit(sf, false);
  return bad;
}

describe("OrderItem.status is only ever written PENDING or CANCELLED (SA-248)", () => {
  it("no API source file writes CONFIRMED, PARTIAL or DELIVERED onto an OrderItem", () => {
    const offenders = walk(SRC_ROOT).flatMap((f) =>
      findOrderItemStatusOffenders(fs.readFileSync(f, "utf8")).map(
        (o) => `${path.relative(SRC_ROOT, f)}: ${o}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the scan itself sees a writer (it is not vacuous) and does not flag Order.status", () => {
    expect(
      findOrderItemStatusOffenders(
        `await tx.orderItem.update({ where: { id }, data: { status: "DELIVERED" } });`,
      ),
    ).toHaveLength(1);
    expect(
      findOrderItemStatusOffenders(
        `await db.orderItem.updateMany({ data: { status: ItemStatus.PARTIAL } });`,
      ),
    ).toHaveLength(1);
    expect(
      findOrderItemStatusOffenders(
        `await tx.order.create({ data: { lineItems: { create: [{ status: "CONFIRMED" }] } } });`,
      ),
    ).toHaveLength(1);
    expect(
      findOrderItemStatusOffenders(`await tx.order.update({ data: { status: "CONFIRMED" } });`),
    ).toHaveLength(0);
    expect(
      findOrderItemStatusOffenders(
        `await tx.orderItem.update({ data: { status: "PENDING" } }); await tx.orderItem.update({ data: { status: ItemStatus.CANCELLED } });`,
      ),
    ).toHaveLength(0);
  });

  it("the file set is non-trivial (guards against an empty walk reporting green)", () => {
    expect(walk(SRC_ROOT).length).toBeGreaterThan(300);
  });
});

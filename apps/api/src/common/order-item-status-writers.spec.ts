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
const WRITES = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
/** Keys of a nested `lineItems: { <key>: ... }` that WRITE (a `some`/`every`/`none` there is a read filter). */
const NESTED_WRITES = new Set([...WRITES, "connectOrCreate", "set"]);
/** Subtrees that are read positions, never writes. */
const READ_KEYS = new Set(["where", "select", "include", "orderBy", "cursor", "omit"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".spec.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Every forbidden status an initializer can evaluate to: unwraps (), `as`, `satisfies`, `!`, ternaries and `??`/`||`, `{ set: X }`. */
function forbiddenIn(n: ts.Node): string[] {
  if (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n)
  )
    return forbiddenIn(n.expression);
  if (ts.isConditionalExpression(n))
    return [...forbiddenIn(n.whenTrue), ...forbiddenIn(n.whenFalse)];
  if (ts.isBinaryExpression(n)) return [...forbiddenIn(n.left), ...forbiddenIn(n.right)];
  if (ts.isStringLiteralLike(n)) return FORBIDDEN.has(n.text) ? [n.text] : [];
  if (ts.isPropertyAccessExpression(n)) return FORBIDDEN.has(n.name.text) ? [n.name.text] : []; // ItemStatus.X, OrderStatus.X, Prisma.ItemStatus.X
  if (ts.isObjectLiteralExpression(n))
    return n.properties.flatMap((pr) =>
      ts.isPropertyAssignment(pr) && pr.name.getText() === "set" ? forbiddenIn(pr.initializer) : [],
    );
  return [];
}

const unwrapCallee = (n: ts.Expression): ts.Expression =>
  ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n) ? unwrapCallee(n.expression) : n;

const isOrderItemWrite = (n: ts.Node): boolean => {
  if (!ts.isCallExpression(n)) return false;
  const callee = unwrapCallee(n.expression);
  if (!ts.isPropertyAccessExpression(callee) || !WRITES.has(callee.name.text)) return false;
  const target = unwrapCallee(callee.expression);
  return ts.isPropertyAccessExpression(target) && target.name.text === "orderItem";
};

const propName = (n: ts.Node): string | null => {
  if (!ts.isPropertyAssignment(n) && !ts.isShorthandPropertyAssignment(n)) return null;
  const t = n.name.getText().replace(/^["']|["']$/g, "");
  return t;
};

/** Offending `status:` sites in one file's text. */
export function findOrderItemStatusOffenders(text: string): string[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const bad: string[] = [];
  // ctx.write: inside an orderItem write call's arguments; ctx.lineItems: inside `lineItems:`; ctx.nestedWrite:
  // ...and past a write key (create/update/...), so `lineItems: { some: { status } }` is not flagged.
  const visit = (n: ts.Node, ctx: { write: boolean; lineItems: boolean; nestedWrite: boolean }) => {
    const name = propName(n);
    if (name && READ_KEYS.has(name)) return; // a read position
    const next = { ...ctx };
    if (isOrderItemWrite(n)) next.write = true;
    if (name === "lineItems") next.lineItems = true;
    if (ctx.lineItems && name && NESTED_WRITES.has(name)) next.nestedWrite = true;
    const writing = next.write || (next.lineItems && next.nestedWrite);
    if (writing && ts.isPropertyAssignment(n) && name === "status") {
      for (const v of forbiddenIn(n.initializer))
        bad.push(`${v} @ line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
    }
    ts.forEachChild(n, (c) => visit(c, next));
  };
  visit(sf, { write: false, lineItems: false, nestedWrite: false });
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

  const offenders = (code: string) => findOrderItemStatusOffenders(code).length;

  it("the scan itself sees each writer shape (it is not vacuous)", () => {
    expect(
      offenders(`await tx.orderItem.update({ where: { id }, data: { status: "DELIVERED" } });`),
    ).toBe(1);
    expect(
      offenders(`await db.orderItem.updateMany({ data: { status: ItemStatus.PARTIAL } });`),
    ).toBe(1);
    expect(
      offenders(
        `await tx.order.create({ data: { lineItems: { create: [{ status: "CONFIRMED" }] } } });`,
      ),
    ).toBe(1);
    // wrapped / conditional / cast values
    expect(
      offenders(`await tx.orderItem.update({ data: { status: full ? "DELIVERED" : "PARTIAL" } });`),
    ).toBe(2);
    expect(
      offenders(`await tx.orderItem.update({ data: { status: "DELIVERED" as ItemStatus } });`),
    ).toBe(1);
    expect(
      offenders(`await tx.orderItem.update({ data: { status: (ItemStatus.DELIVERED) } });`),
    ).toBe(1);
    expect(
      offenders(`await tx.orderItem.update({ data: { status: OrderStatus.DELIVERED } });`),
    ).toBe(1);
    expect(offenders(`await tx.orderItem.update({ data: { status: { set: "PARTIAL" } } });`)).toBe(
      1,
    );
    // other write methods and a non-null callee
    expect(
      offenders(`await tx.orderItem.createManyAndReturn({ data: [{ status: "CONFIRMED" }] });`),
    ).toBe(1);
    expect(
      offenders(`await tx.orderItem.updateManyAndReturn({ data: { status: "DELIVERED" } });`),
    ).toBe(1);
    expect(offenders(`await tx.orderItem!.update({ data: { status: "DELIVERED" } });`)).toBe(1);
    expect(
      offenders(
        `await tx.order.update({ data: { lineItems: { updateMany: { where: {}, data: { status: "DELIVERED" } } } } });`,
      ),
    ).toBe(1);
  });

  it("...and does not flag Order.status, PENDING/CANCELLED, or read filters", () => {
    expect(offenders(`await tx.order.update({ data: { status: "CONFIRMED" } });`)).toBe(0);
    expect(
      offenders(
        `await tx.orderItem.update({ data: { status: "PENDING" } }); await tx.orderItem.update({ data: { status: ItemStatus.CANCELLED } });`,
      ),
    ).toBe(0);
    expect(
      offenders(
        `await tx.orderItem.updateMany({ where: { status: "DELIVERED" }, data: { status: "CANCELLED" } });`,
      ),
    ).toBe(0);
    expect(
      offenders(
        `await tx.order.findMany({ where: { lineItems: { some: { status: "DELIVERED" } } } });`,
      ),
    ).toBe(0);
    expect(
      offenders(
        `await tx.order.update({ where: {}, data: { lineItems: { deleteMany: { status: "DELIVERED" } } } });`,
      ),
    ).toBe(0);
  });

  it("the file set is non-trivial (guards against an empty walk reporting green)", () => {
    expect(walk(SRC_ROOT).length).toBeGreaterThan(300);
  });
});

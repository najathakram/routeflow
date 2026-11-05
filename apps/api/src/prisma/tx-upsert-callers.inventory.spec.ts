/**
 * SA-1105 Q5, K-10: the tx proxy's `upsert` does NOT scope its `where` (prisma.service.ts, the comment in
 * `_wrapTxWithTenant`): scoping it turns a NULL-`tenantId` legacy PaymentCounter row into a null upsert and a 500, so the
 * fix needs a backfill migration (the later row F05-N7). That comment claims "every tx-proxy upsert caller keys on the
 * tenant id or a compound unique". This spec makes the claim a pin.
 *
 * Every `<tx>.<model>.upsert(` in non-spec source whose receiver is a plain identifier (a transaction client:
 * `tx`, `rawTx`, ...; `this.prisma...` is the client itself, not a proxy) is listed with its `where` key classified:
 *   - tenantId                : `where: { tenantId, ... }`
 *   - compound-with-tenantId  : `where: { tenantId_<field>: { ... } }`
 *   - id-is-tenantId          : `where: { id: tenantId }` (the PaymentCounter row IS the tenant's counter)
 *   - UNSAFE                  : anything else, or a `where` the scan cannot read. UNSAFE must be 0.
 * A new caller keyed on a bare id is red until it is classified, or until F05-N7 lands.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC = path.join(__dirname, "..");
const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
          ? [path.join(dir, e.name)]
          : [],
    );

export type WhereClass = "tenantId" | "compound-with-tenantId" | "id-is-tenantId" | "UNSAFE";
export interface Caller {
  file: string;
  model: string;
  where: WhereClass;
}

const keyName = (n: ts.PropertyName): string =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : "";

/** The object literal a name is bound to by a `const x = { ... }` in the same file. */
function resolveObject(sf: ts.SourceFile, name: string): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (n: ts.Node) => {
    if (
      !found &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      found = n.initializer;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function classifyWhere(sf: ts.SourceFile, where: ts.ObjectLiteralExpression): WhereClass {
  for (const p of where.properties) {
    const name = p.name ? keyName(p.name) : ts.isShorthandPropertyAssignment(p) ? p.name.text : "";
    if (name === "tenantId") return "tenantId";
    if (name.startsWith("tenantId_")) return "compound-with-tenantId";
    if (
      name === "id" &&
      ts.isPropertyAssignment(p) &&
      /tenantId$/i.test(p.initializer.getText(sf))
    ) {
      return "id-is-tenantId";
    }
  }
  return "UNSAFE";
}

/** The `where` literal of an upsert's first argument: inline, a shorthand `where`, or a const the call was given. */
function whereOf(
  sf: ts.SourceFile,
  call: ts.CallExpression,
): ts.ObjectLiteralExpression | undefined {
  let arg: ts.ObjectLiteralExpression | undefined;
  const a0 = call.arguments[0];
  if (a0 && ts.isObjectLiteralExpression(a0)) arg = a0;
  else if (a0 && ts.isIdentifier(a0)) arg = resolveObject(sf, a0.text);
  if (!arg) return undefined;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && keyName(p.name) === "where") {
      if (ts.isObjectLiteralExpression(p.initializer)) return p.initializer;
      if (ts.isIdentifier(p.initializer)) return resolveObject(sf, p.initializer.text);
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === "where")
      return resolveObject(sf, "where");
  }
  return undefined;
}

export function scanTxUpserts(files: Array<{ file: string; text: string }>): Caller[] {
  const out: Caller[] = [];
  for (const { file, text } of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "upsert" &&
        ts.isPropertyAccessExpression(n.expression.expression) &&
        ts.isIdentifier(n.expression.expression.expression) // `tx` in `tx.<model>.upsert`, never `this.prisma.<model>`
      ) {
        const where = whereOf(sf, n);
        out.push({
          file,
          model: n.expression.expression.name.text,
          where: where ? classifyWhere(sf, where) : "UNSAFE",
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const tally = (cs: Caller[]) =>
  Object.fromEntries(
    [
      ...cs.reduce(
        (m, c) =>
          m.set(
            `${c.file} :: ${c.model} :: ${c.where}`,
            (m.get(`${c.file} :: ${c.model} :: ${c.where}`) ?? 0) + 1,
          ),
        new Map<string, number>(),
      ),
    ].sort(),
  );

/** The inventory at the base of this PR. A new caller must be added here with its class; UNSAFE is never added. */
const EXPECTED: Record<string, number> = {
  "billing/billing.service.ts :: tenantSubscription :: tenantId": 2,
  "billing/feature-config.service.ts :: tenantFeatureConfig :: compound-with-tenantId": 1,
  "billing/subscription-mutation.service.ts :: tenantSubscription :: tenantId": 1,
  "billing/tenant-addon-writer.ts :: tenantAddon :: compound-with-tenantId": 1,
  "billing/tenant-config-snapshot.service.ts :: tenantFeatureConfig :: compound-with-tenantId": 1,
  "invoices/invoices.service.ts :: paymentCounter :: id-is-tenantId": 2,
  "platform-admin/platform-admin.service.ts :: tenantSubscription :: tenantId": 3,
  "system-config/tenant-timezone.writer.ts :: tenantConfig :: tenantId": 1,
};

describe("K-10 tx-upsert caller inventory", () => {
  const callers = scanTxUpserts(
    walk(SRC)
      .filter((f) => !f.includes(`${path.sep}testing${path.sep}`))
      .map((f) => ({
        file: path.relative(SRC, f).split(path.sep).join("/"),
        text: fs.readFileSync(f, "utf8"),
      })),
  );

  it("UNSAFE = 0: every transaction-client upsert keys on the tenant id or a compound unique that includes it", () => {
    expect(callers.filter((c) => c.where === "UNSAFE")).toEqual([]);
  });

  it("the inventory is exactly the list above (a new caller is classified here, in review)", () => {
    expect(tally(callers)).toEqual(EXPECTED);
  });

  it("the scan sees the planted shapes (non-vacuous)", () => {
    const planted = scanTxUpserts([
      {
        file: "x.ts",
        text: [
          "const a = { where: { id: row.id }, create: {}, update: {} };",
          "await tx.invoice.upsert(a);",
          "await tx.order.upsert({ where: { tenantId_number: { tenantId, number } }, create: {}, update: {} });",
          "const where = { tenantId_k: { tenantId, k } };",
          "await tx.thing.upsert({ where, create: {}, update: {} });",
          "await this.prisma.thing.upsert({ where: { id } });",
        ].join("\n"),
      },
    ]);
    expect(planted).toEqual([
      { file: "x.ts", model: "invoice", where: "UNSAFE" },
      { file: "x.ts", model: "order", where: "compound-with-tenantId" },
      { file: "x.ts", model: "thing", where: "compound-with-tenantId" },
    ]);
  });
});

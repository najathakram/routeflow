/**
 * #2635 / SA-533g: SOURCE pin on reorderRunStopsInTx's lock order. The house order for this family
 * is STOP rows → RouteRun (the order completeStop/completeWithPayment and updateStopStatus take).
 * The function's FIRST statement must lock the run's stop rows in a deterministic order, the SECOND
 * must lock the RouteRun, and no other read or write may come before either. (The real-PG
 * behaviour is pinned in run-stop-reorder-lock.db.spec.ts; this pin fails fast in the default lane
 * if the statements are ever reordered.)
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

describe("reorderRunStopsInTx lock order (#2635, SA-533g)", () => {
  const src = ts.createSourceFile(
    "run-stop-reorder.ts",
    fs.readFileSync(path.join(__dirname, "run-stop-reorder.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let fn: ts.FunctionDeclaration | undefined;
  ts.forEachChild(src, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.getText(src) === "reorderRunStopsInTx") fn = n;
  });

  const statements = () => fn!.body!.statements;
  /** The raw SQL of an `await tx.$executeRaw\`…\`` statement, or null for any other statement. */
  const rawSql = (st: ts.Statement): string | null => {
    if (!ts.isExpressionStatement(st)) return null;
    const e = ts.isAwaitExpression(st.expression) ? st.expression.expression : st.expression;
    if (!ts.isTaggedTemplateExpression(e) || !e.tag.getText(src).endsWith("$executeRaw")) {
      return null;
    }
    return e.template.getText(src);
  };

  it("exists", () => {
    expect(fn?.body).toBeDefined();
  });

  it("statement 1 locks the run's stop rows, in id order, FOR UPDATE", () => {
    const sql = rawSql(statements()[0]);
    expect(sql).not.toBeNull();
    expect(sql).toMatch(
      /FROM "RouteRunStop" WHERE "routeRunId" = \$\{runId\} ORDER BY id FOR UPDATE/,
    );
  });

  it("statement 2 locks the RouteRun FOR UPDATE", () => {
    const sql = rawSql(statements()[1]);
    expect(sql).not.toBeNull();
    expect(sql).toMatch(/FROM "RouteRun" WHERE id = \$\{runId\} FOR UPDATE/);
  });

  it("no tx read or write comes before the two locks", () => {
    const lockEnd = statements()[1].getEnd();
    const early: string[] = [];
    const walk = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        /^tx\.[A-Za-z]+\.[A-Za-z]+$/.test(n.expression.getText(src)) &&
        n.getStart(src) < lockEnd
      ) {
        early.push(n.expression.getText(src));
      }
      ts.forEachChild(n, walk);
    };
    walk(fn!.body!);
    expect(early).toEqual([]);
  });
});

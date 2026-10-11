/**
 * SA-773 split N3: the pickup hand-over's change is `counterChange` (packages/pricing), the same formula the counter sale's
 * tender response, by-key read-back, Today's row and receipt use. The structural pin reads the TypeScript AST (L-205): the
 * figure `tenderFigures` serves comes from a `counterChange(...)` call, never from its own subtraction of the amount and the cash
 * taken. The behaviour table proves the served change equals `counterChange`'s for the hand-over shapes.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { counterChange } from "@routeflow/pricing";
import { tenderFigures, type InvoiceRow, type PayRow } from "./pickup-tender";

const FILE = path.join(__dirname, "pickup-tender.ts");

describe("pickup-tender: change comes from pricing's counterChange", () => {
  const sf = ts.createSourceFile(FILE, fs.readFileSync(FILE, "utf8"), ts.ScriptTarget.ES2022, true);

  const tenderFiguresFn = (): ts.FunctionDeclaration => {
    let found: ts.FunctionDeclaration | undefined;
    sf.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "tenderFigures") found = n;
    });
    if (!found) throw new Error("tenderFigures not found");
    return found;
  };

  it("imports counterChange from @routeflow/pricing and calls it inside tenderFigures", () => {
    const imported = sf.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === "@routeflow/pricing" &&
        s.importClause?.namedBindings &&
        ts.isNamedImports(s.importClause.namedBindings) &&
        s.importClause.namedBindings.elements.some(
          (e) => (e.propertyName ?? e.name).text === "counterChange",
        ),
    );
    expect(imported).toBe(true);
    const calls: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n.expression.text);
      ts.forEachChild(n, visit);
    };
    visit(tenderFiguresFn());
    expect(calls).toContain("counterChange");
  });

  it("serves no change figure of its own: nothing in tenderFigures subtracts the cash taken from the amount", () => {
    // a binary `-` whose operands mention the request's amount and the cash taken is a second change formula
    const hits: string[] = [];
    const mentions = (n: ts.Node, name: string): boolean => {
      let hit = false;
      const walk = (x: ts.Node): void => {
        if (ts.isIdentifier(x) && x.text === name) hit = true;
        if (ts.isPropertyAccessExpression(x) && x.name.text === name) hit = true;
        ts.forEachChild(x, walk);
      };
      walk(n);
      return hit;
    };
    const visit = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.MinusToken &&
        mentions(n, "amount") &&
        mentions(n, "cashTaken")
      )
        hits.push(n.getText(sf));
      ts.forEachChild(n, visit);
    };
    visit(tenderFiguresFn());
    expect(hits).toEqual([]);
  });
});

describe("pickup-tender: the served change equals counterChange for the hand-over shapes", () => {
  const HANDED_OVER = new Date("2026-10-01T12:00:00Z");
  const mine = (p: PayRow) => p.createdAt == null || new Date(p.createdAt) >= HANDED_OVER;
  const cashRow = (amount: number): PayRow => ({
    id: `p-${amount}`,
    amount,
    method: "CASH",
    status: "PAID",
    createdAt: new Date("2026-10-01T12:00:01Z"),
  });
  const invoice = (total: number, payments: PayRow[]): InvoiceRow => ({
    id: "inv-1",
    total,
    payments,
  });

  // [invoice total, cash recorded for this hand-over, cash tendered (the request's amount)]
  const shapes: Array<[number, number, number]> = [
    [70, 70, 100], // $30 back
    [70, 70, 70], // exact: no change
    [70, 70, 70.01], // a cent over
    [0.1 + 0.2, 0.3, 0.5], // float noise on the owed side
    [19.99, 19.99, 20],
    [1234.56, 1234.56, 1500],
    [100, 40, 100], // part of the cash recorded, balance still due: never change
  ];

  it.each(shapes)("total %p, cash recorded %p, tendered %p", (total, recorded, tendered) => {
    const out = tenderFigures(
      [invoice(total, [cashRow(recorded)])],
      { method: "CASH", amount: tendered },
      mine,
      undefined,
    );
    const stillDue = Math.round((total - recorded) * 100) > 0;
    const expected = counterChange({ total: recorded, nonCashApplied: 0, tendered }).change;
    if (stillDue || expected <= 0) expect(out.change).toBeUndefined();
    else expect(out.change).toBe(expected);
  });

  it("never change for a non-cash method, and none without a tendered amount", () => {
    const rows = [invoice(70, [cashRow(70)])];
    expect(
      tenderFigures(rows, { method: "CARD", amount: 100 }, mine, undefined).change,
    ).toBeUndefined();
    expect(tenderFigures(rows, { method: "CASH" }, mine, undefined).change).toBeUndefined();
  });
});

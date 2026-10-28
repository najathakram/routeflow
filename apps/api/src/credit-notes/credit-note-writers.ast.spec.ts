import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * W-913 (SA-932 §B): no credit note is ever written on the walk-in account. Every code path under apps/api/src
 * that WRITES a CreditNote row must go through `assertCreditCustomerNotWalkIn`, called BEFORE the write.
 *
 * Structural proof (TypeScript AST, no regex over source; L-205: structure, never scraped text):
 *   1. INVENTORY - every function/method that calls `creditNote.create|createMany|upsert` (or inserts into the
 *      "CreditNote" table by raw SQL) must EQUAL the table below, both ways. A NEW writer fails until it is listed
 *      here with its guard; a removed/renamed one fails until its row is dropped.
 *   2. CALL PROOF - each listed writer contains a real CallExpression to the guard, positioned before its first
 *      write (a comment, a string or a renamed method cannot satisfy it).
 *   3. CALLERS - the writers are private plumbing: only the listed callers may reach them, so a new door to a
 *      credit-note write is a conscious edit of this table (reissue and create() reach insertCreditNoteInTx; the
 *      inline capture reaches mintStandaloneInTx).
 */
const GUARD = "assertCreditCustomerNotWalkIn";

const WRITERS: Record<string, string> = {
  "credit-notes/credit-notes.service.ts::CreditNotesService.mintStandaloneInTx": GUARD,
  "credit-notes/credit-notes.service.ts::CreditNotesService.insertCreditNoteInTx": GUARD,
};

/** writer method name -> the callers allowed to reach it (key: file::Class.method). */
const CALLERS: Record<string, string[]> = {
  insertCreditNoteInTx: [
    "credit-notes/credit-notes.service.ts::CreditNotesService.create",
    "credit-notes/credit-note-reissue.service.ts::CreditNoteReissueService.reissue",
  ],
  mintStandaloneInTx: ["returns/inline-returns.service.ts::InlineReturnsService.issueCreditInTx"],
};

const WRITE_OPS = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

/** The enclosing `Class.method` (or free function) name of a node, or null. */
function unitName(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) && n.name && ts.isClassDeclaration(n.parent)) {
      return `${n.parent.name?.text ?? "<anon>"}.${n.name.getText()}`;
    }
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
  }
  return null;
}

/** `<anything>.creditNote.<write op>(...)` calls, and raw-SQL inserts into the "CreditNote" table. */
function creditNoteWrites(sf: ts.SourceFile): Array<{ node: ts.Node; pos: number }> {
  const out: Array<{ node: ts.Node; pos: number }> = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      WRITE_OPS.has(n.expression.name.text) &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      n.expression.expression.name.text === "creditNote"
    ) {
      out.push({ node: n, pos: n.getStart() });
    }
    if (
      ts.isTaggedTemplateExpression(n) &&
      /INSERT\s+INTO\s+"?CreditNote"?\b/i.test(n.template.getText())
    ) {
      out.push({ node: n, pos: n.getStart() });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Start positions of real calls named `name` (`name(...)` or `x.name(...)`) inside `node`. */
function callPositions(node: ts.Node, name: string): number[] {
  const out: number[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const callee = ts.isIdentifier(e)
        ? e.text
        : ts.isPropertyAccessExpression(e)
          ? e.name.text
          : "";
      if (callee === name) out.push(n.getStart());
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out.sort((a, b) => a - b);
}

const SRC = path.join(__dirname, "..");
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : walk(full);
    return d.name.endsWith(".ts") && !/\.(spec|test|db\.spec)\.ts$/.test(d.name) ? [full] : [];
  });
}
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const files = new Map(walk(SRC).map((f) => [rel(f), parse(f, fs.readFileSync(f, "utf8"))]));

function inventory(): Map<string, { sf: ts.SourceFile; positions: number[]; node: ts.Node }> {
  const out = new Map<string, { sf: ts.SourceFile; positions: number[]; node: ts.Node }>();
  for (const [file, sf] of files) {
    for (const w of creditNoteWrites(sf)) {
      const unit = unitName(w.node) ?? "<top level>";
      const key = `${file}::${unit}`;
      const cur = out.get(key);
      if (cur) cur.positions.push(w.pos);
      else out.set(key, { sf, positions: [w.pos], node: w.node });
    }
  }
  return out;
}

function enclosingUnit(node: ts.Node): ts.Node | null {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) return n;
  }
  return null;
}

describe("the scanner itself (so a silent no-match cannot pass the checks below)", () => {
  it("finds creditNote writes and raw inserts, ignores reads and other models", () => {
    const sf = parse(
      "x.ts",
      `class A {
         m(tx) { return tx.creditNote.create({ data: {} }); }
         n(tx) { return tx.creditNote.findMany({}); }
         o(tx) { return tx.invoice.create({ data: {} }); }
         p(tx) { return tx.creditNote.createMany({ data: [] }); }
         q(tx) { return tx.$executeRaw\`INSERT INTO "CreditNote" (id) VALUES (1)\`; }
       }`,
    );
    expect(creditNoteWrites(sf).map((w) => unitName(w.node))).toEqual(["A.m", "A.p", "A.q"]);
  });

  it("a guard in a comment or a string is not a call; a real call is, with its position", () => {
    const sf = parse(
      "x.ts",
      `class A { m(tx) { /* ${GUARD}(tx) */ const s = "${GUARD}(tx)"; ${GUARD}(tx, 1); } }`,
    );
    expect(callPositions(sf, GUARD)).toHaveLength(1);
  });

  it("the real tree yields a plausible inventory (not zero)", () => {
    expect(inventory().size).toBeGreaterThanOrEqual(2);
  });
});

describe("every CreditNote writer refuses the walk-in account first (W-913)", () => {
  it("the writers found in apps/api/src equal the guarded table, both directions", () => {
    expect([...inventory().keys()].sort()).toEqual(Object.keys(WRITERS).sort());
  });

  it.each(Object.entries(WRITERS))(
    "%s calls %s as a real call BEFORE its first CreditNote write",
    (key, guard) => {
      const found = inventory().get(key);
      expect(found).toBeDefined();
      const unit = enclosingUnit(found!.node)!;
      const calls = callPositions(unit, guard);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toBeLessThan(Math.min(...found!.positions));
    },
  );

  it.each(Object.entries(CALLERS))(
    "%s is reached only from its listed callers",
    (writerMethod, allowed) => {
      const callers = new Set<string>();
      for (const [file, sf] of files) {
        const visit = (n: ts.Node) => {
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === writerMethod
          ) {
            callers.add(`${file}::${unitName(n) ?? "<top level>"}`);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
      expect([...callers].sort()).toEqual([...allowed].sort());
    },
  );
});

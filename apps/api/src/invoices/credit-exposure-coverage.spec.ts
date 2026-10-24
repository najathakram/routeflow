/**
 * D6 / B462 — META-SPEC: the credit-exposure derivation has ONE home and every reader of it
 * goes through it (lesson L-119: both halves of one money figure derive from ONE collection).
 * Modeled on `common/no-bare-cron.spec.ts`; it never self-skips — a missing file, a missing
 * method or an empty scan FAILS, it does not pass vacuously.
 *
 *   (i)   the hard block (`assertWithinCreditLimit` in `orders/credit-limit-guard.ts`) and the operator statement
 *         (`CustomersService.getStatementForOperator`) each CALL `loadCreditExposure`, and the
 *         block issues no invoice read of its own;
 *   (ii)  the customers list (`findAll`) and its CSV export (`exportCustomers`) each read
 *         non-settled invoices INCLUDING drafts (`notIn: CREDIT_NOT_APPLICABLE`, never
 *         `CREDIT_EXPOSURE_EXCLUDED`) and sum `receivableBalance` per invoice — which itself
 *         CALLS `isUnbackedDraft`, the same predicate the hard block uses — so a draft backed by
 *         an open/delivered order still counts and only an unbacked one is dropped (D6 option B:
 *         one basis on every surface);
 *   (iii) a tree scan of `apps/api/src`: the raw settled-only literal (`notIn: ["PAID", "VOID",
 *         "WRITTEN_OFF"]`, in either spelling and any order) and the identifier form
 *         (`notIn: CREDIT_NOT_APPLICABLE`, the same trio) may appear ONLY in an explicit
 *         ALLOWLIST with a reason per entry (the identifier form: the shared reader, and the
 *         customers list + CSV, which sum `receivableBalance` and so drop unbacked drafts in JS).
 *
 * WHAT THIS DOES NOT CATCH (a reviewer must): an invoice `where` that lists DRAFT positively
 * (`status: { in: [DRAFT, SENT, …] }`), any other identifier whose members happen to equal the
 * trio, and reads outside `apps/api/src` (apps/api/scripts, root scripts, web-side derivations).
 *
 * Detection is AST-based (the TypeScript parser, not text): a comment, a string, a template or a
 * regex literal that merely MENTIONS `loadCreditExposure` / the literal can neither satisfy nor
 * trip a check, and prettier re-wrapping a call across lines cannot hide one. Each detector is
 * itself proven against synthetic sources (the "detector self-tests" block) so a detector that
 * quietly matched nothing would fail rather than report green.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC_ROOT = path.resolve(__dirname, "..");

// ─── file walk ────────────────────────────────────────────────────────────────

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

const rel = (file: string): string => path.relative(SRC_ROOT, file).replace(/\\/g, "/");

// ─── AST helpers ──────────────────────────────────────────────────────────────

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* parents */ true);
}

function parseFile(relPath: string): ts.SourceFile {
  const full = path.join(SRC_ROOT, relPath);
  // A missing fixture is a FAILURE, never a skip.
  if (!fs.existsSync(full)) throw new Error(`expected source file is missing: ${relPath}`);
  return parse(full, fs.readFileSync(full, "utf8"));
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** The one method (with a body) named `name`; throws if there are none or several. */
function methodNamed(sf: ts.SourceFile, name: string): ts.MethodDeclaration {
  const found: ts.MethodDeclaration[] = [];
  walk(sf, (n) => {
    if (ts.isMethodDeclaration(n) && n.body && n.name.getText(sf) === name) found.push(n);
  });
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one method "${name}" in ${sf.fileName}, found ${found.length}`,
    );
  }
  return found[0];
}

/** The one function declaration (with a body) named `name`; throws if there are none or several. */
function functionNamed(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found: ts.FunctionDeclaration[] = [];
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.body && n.name?.text === name) found.push(n);
  });
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one function "${name}" in ${sf.fileName}, found ${found.length}`,
    );
  }
  return found[0];
}

/** Name of a property assignment key (`status`, "status", 'status'), else undefined. */
function keyName(p: ts.PropertyAssignment): string | undefined {
  const n = p.name;
  return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : undefined;
}

function propertyAssignments(root: ts.Node, key: string): ts.PropertyAssignment[] {
  const out: ts.PropertyAssignment[] = [];
  walk(root, (n) => {
    if (ts.isPropertyAssignment(n) && keyName(n) === key) out.push(n);
  });
  return out;
}

/** True when `root` contains a real CALL of the bare identifier `fn` (comments/strings never count). */
function callsFunction(root: ts.Node, fn: string): boolean {
  let hit = false;
  walk(root, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fn) {
      hit = true;
    }
  });
  return hit;
}

/** Calls shaped `<anything>.<model>.<method>(...)`, e.g. `db.invoice.findMany(...)`. */
function callsModelMethod(root: ts.Node, model: string, method: string): boolean {
  let hit = false;
  walk(root, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const callee = n.expression;
    if (callee.name.text !== method) return;
    const receiver = callee.expression;
    if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === model) hit = true;
  });
  return hit;
}

/**
 * True when `root` holds an INVOICE `where` whose `status: { notIn: <sharedSet> }` names the
 * shared identifier. An invoice `where` is either the argument of `<x>.invoice.<method>(...)`
 * or the value of a nested `invoices: { where: ... }` relation include.
 */
function hasInvoiceWhereNotIn(root: ts.Node, sharedSet: string): boolean {
  let hit = false;
  for (const notIn of propertyAssignments(root, "notIn")) {
    if (!ts.isIdentifier(notIn.initializer) || notIn.initializer.text !== sharedSet) continue;
    const statusObj = notIn.parent; // { notIn: ... }
    const status = statusObj.parent; // status: { notIn: ... }
    if (!ts.isPropertyAssignment(status) || keyName(status) !== "status") continue;
    const whereValue = status.parent; // the object literal that holds `status`
    const where = whereValue.parent; // where: { status: ... }
    if (!ts.isPropertyAssignment(where) || keyName(where) !== "where") continue;
    const owner = where.parent; // the object literal that holds `where`
    const holder = owner.parent;
    const isInvoiceCall =
      ts.isCallExpression(holder) &&
      ts.isPropertyAccessExpression(holder.expression) &&
      ts.isPropertyAccessExpression(holder.expression.expression) &&
      holder.expression.expression.name.text === "invoice";
    const isInvoicesRelation = ts.isPropertyAssignment(holder) && keyName(holder) === "invoices";
    if (isInvoiceCall || isInvoicesRelation) hit = true;
  }
  return hit;
}

// ─── the raw settled-only literal ─────────────────────────────────────────────

const SETTLED_TRIO = ["PAID", "VOID", "WRITTEN_OFF"];

/** "PAID" → PAID, InvoiceStatus.PAID → PAID, anything else → undefined. */
function statusMember(e: ts.Expression): string | undefined {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    return e.expression.text === "InvoiceStatus" ? e.name.text : undefined;
  }
  return undefined;
}

/**
 * Line numbers of every `notIn: [...]` under `root` whose array is EXACTLY the settled trio —
 * either spelling, any order, multi-line. An array that also carries DRAFT (or anything else) is
 * not the literal.
 */
function rawSettledLiteralLines(root: ts.Node): number[] {
  const sf = root.getSourceFile();
  const lines: number[] = [];
  for (const notIn of propertyAssignments(root, "notIn")) {
    const init = notIn.initializer;
    if (!ts.isArrayLiteralExpression(init)) continue;
    const members = init.elements.map(statusMember);
    if (members.some((m) => m === undefined)) continue;
    const set = new Set(members as string[]);
    if (set.size === SETTLED_TRIO.length && SETTLED_TRIO.every((m) => set.has(m))) {
      lines.push(sf.getLineAndCharacterOfPosition(notIn.getStart(sf)).line + 1);
    }
  }
  return lines;
}

/** Exported status sets whose members are EXACTLY the settled trio (= DRAFT-inclusive when used as `notIn`). */
const TRIO_SET_IDENTIFIERS = ["CREDIT_NOT_APPLICABLE"];

/** Line numbers of every `notIn: <trio-set identifier>` under `root`. */
function trioIdentifierLines(root: ts.Node): number[] {
  const sf = root.getSourceFile();
  const lines: number[] = [];
  for (const notIn of propertyAssignments(root, "notIn")) {
    const init = notIn.initializer;
    if (ts.isIdentifier(init) && TRIO_SET_IDENTIFIERS.includes(init.text)) {
      lines.push(sf.getLineAndCharacterOfPosition(notIn.getStart(sf)).line + 1);
    }
  }
  return lines;
}

/**
 * The identifier form's sanctioned homes: the shared reader, and the customers list + CSV. All of
 * them deliberately fetch every non-settled invoice (drafts included) and then decide per draft
 * through `receivableBalance` (→ `isUnbackedDraft`) — a SQL-side draft exclusion would drop drafts
 * that an open/delivered order backs (D6 option B).
 */
const IDENTIFIER_FORM_ALLOWLIST: Record<string, { hits: number; reason: string }> = {
  "invoices/credit-exposure.ts": {
    hits: 1,
    reason:
      "the ONE reader: fetches every non-settled invoice incl. DRAFT, then computeCreditExposure " +
      "splits counted vs pending",
  },
  "customers/customers.service.ts": {
    hits: 2,
    reason:
      "list receivables (findAll) + CSV export (exportCustomers): read non-settled invoices incl. " +
      "DRAFT and sum receivableBalance per invoice (which drops unbacked drafts in JS through " +
      "isUnbackedDraft, the same predicate as the hard block) — a backed draft still counts by " +
      "balance",
  },
};

/**
 * The ONLY places the raw settled-only literal may appear. `hits` is exact: a second occurrence in
 * an allow-listed file fails too, and an entry whose literal disappears fails (no stale allowances).
 */
const ALLOWLIST: Record<string, { hits: number; reason: string }> = {
  "invoices/invoices.service.ts": {
    hits: 1,
    reason:
      "bulk price edit (scope ALL_CUSTOMER_SINCE): DRAFT invoices are VALID edit targets there — " +
      "the operator is repricing every not-yet-settled invoice of the customer, not measuring " +
      "receivables or credit exposure",
  },
};

// ─── the specs ────────────────────────────────────────────────────────────────

describe("credit-exposure coverage (D6 / B462, L-119)", () => {
  describe("(i) the hard block and the operator statement both read through loadCreditExposure", () => {
    it("the credit-limit guard (orders/credit-limit-guard.ts) calls loadCreditExposure and issues no invoice read of its own", () => {
      const fn = functionNamed(
        parseFile("orders/credit-limit-guard.ts"),
        "assertWithinCreditLimit",
      );
      expect(callsFunction(fn, "loadCreditExposure")).toBe(true);
      // One collection, one reader (L-119): the block must not grow a second invoice/order
      // derivation next to the shared one — via ANY read shape, not just findMany.
      for (const model of ["invoice", "order"]) {
        for (const read of [
          "findMany",
          "findFirst",
          "findUnique",
          "aggregate",
          "groupBy",
          "count",
        ]) {
          expect({ model, read, hit: callsModelMethod(fn, model, read) }).toEqual({
            model,
            read,
            hit: false,
          });
        }
      }
    });

    it("OrdersService has no guard of its own: every pre-existing credit call site calls the imported guard function", () => {
      const sf = parseFile("orders/orders.service.ts");
      // the guard has ONE home (credit-limit-guard.ts) — a private copy in the service would be a fork
      expect(() => methodNamed(sf, "assertWithinCreditLimit")).toThrow(/found 0/);
      for (const name of [
        "updateOrderItems",
        "approveChangeRequestAtStop",
        "assertCreditForProjectedOrder",
      ]) {
        const method = methodNamed(sf, name);
        expect({ name, calls: callsFunction(method, "assertWithinCreditLimit") }).toEqual({
          name,
          calls: true,
        });
        expect(callsFunction(method, "loadCreditExposure")).toBe(false);
      }
    });

    it("the operator statement (CustomersService.getStatementForOperator -> buildOperatorStatement) calls loadCreditExposure", () => {
      // The body moved verbatim to customers/customer-statement.ts (size headroom); the service method
      // delegates to it, so both halves are pinned.
      const method = methodNamed(
        parseFile("customers/customers.service.ts"),
        "getStatementForOperator",
      );
      expect(callsFunction(method, "buildOperatorStatement")).toBe(true);
      const builder = functionNamed(
        parseFile("customers/customer-statement.ts"),
        "buildOperatorStatement",
      );
      expect(callsFunction(builder, "loadCreditExposure")).toBe(true);
    });

    it("the shared module exports the reader, the pure core and the draft predicate", () => {
      const sf = parseFile("invoices/credit-exposure.ts");
      const exported = new Set<string>();
      walk(sf, (n) => {
        if (
          (ts.isFunctionDeclaration(n) || ts.isVariableStatement(n)) &&
          n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          if (ts.isFunctionDeclaration(n) && n.name) exported.add(n.name.text);
          if (ts.isVariableStatement(n)) {
            for (const d of n.declarationList.declarations) exported.add(d.name.getText(sf));
          }
        }
      });
      for (const name of [
        "computeCreditExposure",
        "loadCreditExposure",
        "isUnbackedDraft",
        "receivableBalance",
        "RECEIVABLE_INVOICE_SELECT",
        "OPEN_ORDER_STATUSES",
      ]) {
        expect({ name, exported: exported.has(name) }).toEqual({ name, exported: true });
      }
    });
  });

  describe("(ii) the customers list and CSV sum receivableBalance, which calls isUnbackedDraft (D6 option B)", () => {
    it("receivableBalance calls isUnbackedDraft — the one draft decision behind the list and the CSV", () => {
      const fn = functionNamed(parseFile("invoices/credit-exposure.ts"), "receivableBalance");
      expect(callsFunction(fn, "isUnbackedDraft")).toBe(true);
    });

    it.each(["findAll", "exportCustomers"])(
      "CustomersService.%s reads non-settled invoices (drafts included) and calls receivableBalance",
      (name) => {
        const method = methodNamed(parseFile("customers/customers.service.ts"), name);
        // The DB read must bring drafts back so the JS predicate can judge each one's order...
        expect(hasInvoiceWhereNotIn(method, "CREDIT_NOT_APPLICABLE")).toBe(true);
        // ...and it must NOT drop every DRAFT in SQL (that is the retired option-A basis, under
        // which a draft behind a DELIVERED order would silently leave the receivable).
        expect(hasInvoiceWhereNotIn(method, "CREDIT_EXPOSURE_EXCLUDED")).toBe(false);
        // The one shared per-invoice basis, called — not re-implemented.
        expect(callsFunction(method, "receivableBalance")).toBe(true);
        // ...and no raw settled-only literal of its own.
        expect(rawSettledLiteralLines(method)).toEqual([]);
      },
    );
  });

  describe("(iii) the raw settled-only literal appears only where allow-listed", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const hitsByFile = new Map<string, number[]>();
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      // Cheap prefilter: the literal cannot exist without its third member. The walked-file
      // count below is asserted BEFORE this filter, so an empty scan still fails loudly.
      if (!text.includes("WRITTEN_OFF")) continue;
      const lines = rawSettledLiteralLines(parse(file, text));
      if (lines.length > 0) hitsByFile.set(rel(file), lines);
    }

    it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
      expect(files.length).toBeGreaterThan(100);
    });

    it("finds the literal where it legitimately lives (a detector matching nothing would report green)", () => {
      expect(hitsByFile.size).toBeGreaterThan(0);
    });

    it("every allow-listed file really exists, still holds exactly the declared literal, and carries a reason", () => {
      for (const [file, entry] of Object.entries(ALLOWLIST)) {
        expect({ file, exists: fs.existsSync(path.join(SRC_ROOT, file)) }).toEqual({
          file,
          exists: true,
        });
        expect({ file, hits: hitsByFile.get(file)?.length ?? 0 }).toEqual({
          file,
          hits: entry.hits,
        });
        expect(entry.reason.length).toBeGreaterThan(20);
      }
    });

    it("no other file carries a DRAFT-inclusive open-invoice literal (read through loadCreditExposure / isUnbackedDraft, or allow-list with a reason)", () => {
      const offenders = [...hitsByFile.entries()]
        .filter(([file]) => !(file in ALLOWLIST))
        .map(([file, lines]) => `${file}:${lines.join(",")}`);
      expect(offenders).toEqual([]);
    });
  });

  describe("(iii-b) the identifier form of the settled trio appears only where allow-listed", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const identHits = new Map<string, number[]>();
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      if (!TRIO_SET_IDENTIFIERS.some((id) => text.includes(id))) continue;
      const lines = trioIdentifierLines(parse(file, text));
      if (lines.length > 0) identHits.set(rel(file), lines);
    }

    it("finds the sanctioned use (a detector matching nothing would report green) with the exact declared hit count", () => {
      for (const [file, entry] of Object.entries(IDENTIFIER_FORM_ALLOWLIST)) {
        expect({ file, hits: identHits.get(file)?.length ?? 0 }).toEqual({
          file,
          hits: entry.hits,
        });
        expect(entry.reason.length).toBeGreaterThan(20);
      }
    });

    it("no other file filters invoices with `notIn: CREDIT_NOT_APPLICABLE` (DRAFT-inclusive) — read through loadCreditExposure / isUnbackedDraft, or allow-list with a reason", () => {
      const offenders = [...identHits.entries()]
        .filter(([file]) => !(file in IDENTIFIER_FORM_ALLOWLIST))
        .map(([file, lines]) => `${file}:${lines.join(",")}`);
      expect(offenders).toEqual([]);
    });
  });

  describe("detector self-tests (a detector that matches nothing must FAIL, not pass)", () => {
    it("trioIdentifierLines flags the identifier form and nothing else", () => {
      const lines = (code: string) => trioIdentifierLines(parse("fixture.ts", code));
      expect(lines("const w = { status: { notIn: CREDIT_NOT_APPLICABLE } };")).toHaveLength(1);
      expect(lines("const w = { status: { notIn: CREDIT_EXPOSURE_EXCLUDED } };")).toEqual([]);
      expect(lines("const w = { status: { notIn: KPI_SUMMARY_EXCLUDED } };")).toEqual([]);
      expect(lines("// notIn: CREDIT_NOT_APPLICABLE\nconst w = 1;")).toEqual([]);
    });

    const src = (code: string) => parse("fixture.ts", code);
    const firstMethod = (code: string, name: string) => methodNamed(src(code), name);

    it("callsFunction: a real call counts; a comment, a string and a mere reference do not", () => {
      const called = firstMethod(
        "class A { async m(db: any) { const r = await loadCreditExposure(db, 'c'); return r; } }",
        "m",
      );
      const commentOnly = firstMethod(
        "class A { async m() { /* loadCreditExposure(db) */ // loadCreditExposure(db)\n return 1; } }",
        "m",
      );
      const stringOnly = firstMethod(
        "class A { async m() { return 'loadCreditExposure(db)' + `loadCreditExposure(db)`; } }",
        "m",
      );
      const referenceOnly = firstMethod(
        "class A { async m() { const f = loadCreditExposure; return f; } }",
        "m",
      );
      expect(callsFunction(called, "loadCreditExposure")).toBe(true);
      expect(callsFunction(commentOnly, "loadCreditExposure")).toBe(false);
      expect(callsFunction(stringOnly, "loadCreditExposure")).toBe(false);
      expect(callsFunction(referenceOnly, "loadCreditExposure")).toBe(false);
    });

    it('callsFunction "isUnbackedDraft": a real call (incl. inside a loop/callback) counts; a comment, a string, a reference and a method of the same name do not', () => {
      const inLoop = firstMethod(
        "class A { m(rows: any[]) { for (const inv of rows) { if (isUnbackedDraft(inv)) continue; } } }",
        "m",
      );
      const inCallback = firstMethod(
        "class A { m(rows: any[]) { return rows.reduce((s, inv) => (isUnbackedDraft(inv) ? s : s + 1), 0); } }",
        "m",
      );
      const commentOnly = firstMethod(
        "class A { m() { /* isUnbackedDraft(inv) */ // isUnbackedDraft(inv)\n return 1; } }",
        "m",
      );
      const stringOnly = firstMethod("class A { m() { return 'isUnbackedDraft(inv)'; } }", "m");
      const referenceOnly = firstMethod(
        "class A { m() { const f = isUnbackedDraft; return f; } }",
        "m",
      );
      const otherReceiver = firstMethod(
        "class A { m(x: any, inv: any) { return x.isUnbackedDraft(inv); } }",
        "m",
      );
      expect(callsFunction(inLoop, "isUnbackedDraft")).toBe(true);
      expect(callsFunction(inCallback, "isUnbackedDraft")).toBe(true);
      expect(callsFunction(commentOnly, "isUnbackedDraft")).toBe(false);
      expect(callsFunction(stringOnly, "isUnbackedDraft")).toBe(false);
      expect(callsFunction(referenceOnly, "isUnbackedDraft")).toBe(false);
      expect(callsFunction(otherReceiver, "isUnbackedDraft")).toBe(false);
    });

    it("callsModelMethod: flags <x>.invoice.findMany, ignores other models and comments", () => {
      const inline = firstMethod(
        "class A { async m(db: any) { return db.invoice.findMany({}); } }",
        "m",
      );
      const chained = firstMethod(
        "class A { async m() { return this.prisma.forTenant().invoice.findMany({}); } }",
        "m",
      );
      const other = firstMethod(
        "class A { async m(db: any) { // db.invoice.findMany({})\n return db.customer.findMany({}); } }",
        "m",
      );
      expect(callsModelMethod(inline, "invoice", "findMany")).toBe(true);
      expect(callsModelMethod(chained, "invoice", "findMany")).toBe(true);
      expect(callsModelMethod(other, "invoice", "findMany")).toBe(false);
    });

    it("hasInvoiceWhereNotIn: matches an invoice call and a nested invoices relation, not another model", () => {
      const listShape = firstMethod(
        `class A { async m() { return this.prisma.forTenant().invoice.findMany({
          where: { customerId: { in: ids }, status: { notIn: CREDIT_EXPOSURE_EXCLUDED } },
        }); } }`,
        "m",
      );
      const csvShape = firstMethod(
        `class A { async m() { return this.prisma.forTenant().customer.findMany({
          include: { invoices: { where: { status: { notIn: CREDIT_EXPOSURE_EXCLUDED } } } },
        }); } }`,
        "m",
      );
      const wrongModel = firstMethod(
        `class A { async m() { return this.prisma.forTenant().order.findMany({
          where: { status: { notIn: CREDIT_EXPOSURE_EXCLUDED } },
        }); } }`,
        "m",
      );
      const wrongSet = firstMethod(
        `class A { async m() { return this.prisma.forTenant().invoice.findMany({
          where: { status: { notIn: KPI_SUMMARY_EXCLUDED } },
        }); } }`,
        "m",
      );
      const rawLiteral = firstMethod(
        `class A { async m() { return this.prisma.forTenant().invoice.findMany({
          where: { status: { notIn: ["PAID", "VOID", "WRITTEN_OFF"] } },
        }); } }`,
        "m",
      );
      const commentOnly = firstMethod(
        `class A { async m() { // status: { notIn: CREDIT_EXPOSURE_EXCLUDED }
          return this.prisma.forTenant().invoice.findMany({ where: {} }); } }`,
        "m",
      );
      expect(hasInvoiceWhereNotIn(listShape, "CREDIT_EXPOSURE_EXCLUDED")).toBe(true);
      expect(hasInvoiceWhereNotIn(csvShape, "CREDIT_EXPOSURE_EXCLUDED")).toBe(true);
      expect(hasInvoiceWhereNotIn(wrongModel, "CREDIT_EXPOSURE_EXCLUDED")).toBe(false);
      expect(hasInvoiceWhereNotIn(wrongSet, "CREDIT_EXPOSURE_EXCLUDED")).toBe(false);
      expect(hasInvoiceWhereNotIn(rawLiteral, "CREDIT_EXPOSURE_EXCLUDED")).toBe(false);
      expect(hasInvoiceWhereNotIn(commentOnly, "CREDIT_EXPOSURE_EXCLUDED")).toBe(false);

      // The identifier the list/CSV actually use under option B: the detector must tell the
      // DRAFT-inclusive read (CREDIT_NOT_APPLICABLE) from the retired DRAFT-dropping one.
      const optionB = firstMethod(
        `class A { async m() { return this.prisma.forTenant().invoice.findMany({
          where: { customerId: { in: ids }, status: { notIn: CREDIT_NOT_APPLICABLE } },
        }); } }`,
        "m",
      );
      const optionBCsv = firstMethod(
        `class A { async m() { return this.prisma.forTenant().customer.findMany({
          include: { invoices: { where: { status: { notIn: CREDIT_NOT_APPLICABLE } } } },
        }); } }`,
        "m",
      );
      expect(hasInvoiceWhereNotIn(optionB, "CREDIT_NOT_APPLICABLE")).toBe(true);
      expect(hasInvoiceWhereNotIn(optionBCsv, "CREDIT_NOT_APPLICABLE")).toBe(true);
      expect(hasInvoiceWhereNotIn(optionB, "CREDIT_EXPOSURE_EXCLUDED")).toBe(false);
      expect(hasInvoiceWhereNotIn(listShape, "CREDIT_NOT_APPLICABLE")).toBe(false);
    });

    it("rawSettledLiteralLines: catches both spellings, any order, multi-line; spares DRAFT-carrying and shared sets", () => {
      const flagged = [
        'const w = { status: { notIn: ["PAID", "VOID", "WRITTEN_OFF"] } };',
        "const w = { status: { notIn: [InvoiceStatus.PAID, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF] } };",
        'const w = { status: { notIn: ["WRITTEN_OFF", "PAID", "VOID"] } };',
        'const w = { status: { notIn: ["PAID", InvoiceStatus.VOID, "WRITTEN_OFF"] } };',
        "const w = { status: {\n  notIn: [\n    InvoiceStatus.PAID,\n    InvoiceStatus.VOID,\n    InvoiceStatus.WRITTEN_OFF,\n  ],\n} };",
        "const w = { status: { 'notIn': [`PAID`, `VOID`, `WRITTEN_OFF`] } };",
      ];
      for (const code of flagged) {
        expect({ code, lines: rawSettledLiteralLines(src(code)).length }).toEqual({
          code,
          lines: 1,
        });
      }
      const clean = [
        'const w = { status: { notIn: ["PAID", "VOID", "WRITTEN_OFF", "DRAFT"] } };',
        "const w = { status: { notIn: CREDIT_EXPOSURE_EXCLUDED } };",
        'const w = { status: { notIn: ["VOID"] } };',
        'const w = { status: { in: ["PAID", "VOID", "WRITTEN_OFF"] } };',
        '// notIn: ["PAID", "VOID", "WRITTEN_OFF"]\nconst s = \'notIn: ["PAID", "VOID", "WRITTEN_OFF"]\';',
      ];
      for (const code of clean) {
        expect({ code, lines: rawSettledLiteralLines(src(code)) }).toEqual({ code, lines: [] });
      }
    });

    it("methodNamed: a missing method or a missing file is a failure, never a skip", () => {
      expect(() => methodNamed(src("class A { other() {} }"), "assertWithinCreditLimit")).toThrow(
        /found 0/,
      );
      expect(() => parseFile("does-not-exist/nowhere.ts")).toThrow(/missing/);
    });

    it("functionNamed: finds a declaration; a missing one (or a bare arrow const) is a failure, never a skip", () => {
      expect(functionNamed(src("export function f() { return 1; }"), "f").name?.text).toBe("f");
      expect(() => functionNamed(src("export const f = () => 1;"), "f")).toThrow(/found 0/);
    });
  });
});

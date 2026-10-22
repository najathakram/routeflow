import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * #2255 / SA-404a (b1): voidInvoice's in-lock re-check of cash/check/card money is only as good as
 * this invariant — every InvoicePayment writer UPDATES the Invoice row in the same transaction. Under
 * Serializable, void's UPDATE of an Invoice row a concurrent committed tx also updated raises 40001,
 * and the retry re-reads fresh ⇒ 400. A payment INSERT that never touches the row would be invisible
 * to void's older snapshot, so the invariant is pinned here instead of trusted.
 *
 *   TOUCHES — the method creates the payment through a transaction client and, in the same method,
 *             calls `<that client>.invoice.update` / `.updateMany` / `.create` (AST-checked below; SA-424 F1(a):
 *             creating the invoice in the same tx covers the payment the same way an update does).
 *   EXEMPT  — does not meet that shape; the reason is recorded and owned by a ruling.
 *
 * Same technique as selling-restrictions/sellable-writers-coverage.spec.ts: the inventory must EQUAL
 * this table both ways — a NEW payment writer fails until it is classified, and a TOUCHES row whose
 * method stops updating the invoice goes red.
 */
type Row = { kind: "TOUCHES" } | { kind: "EXEMPT"; why: string };
const T: Row = { kind: "TOUCHES" };
const X = (why: string): Row => ({ kind: "EXEMPT", why });

/** Shrink-only (SA-404b, the sellable/unit-line writers pattern): lower it when an EXEMPT row goes. */
const EXEMPT_BASELINE = 0; // #2262 / SA-424: the import writers moved to TOUCHES (was 2)

const TABLE: Record<string, Row> = {
  "bookkeeping/bookkeeping.service.ts::BookkeepingService.recordPayment": T,
  "credit-notes/credit-notes.service.ts::CreditNotesService.applyCreditInTx": T,
  "customers/customers.service.ts::CustomersService.applyAdvancePaymentToInvoiceLocked": T,
  "invoices/invoices.service.ts::InvoicesService.recordDeliveryPaymentInTx": T,
  // SA-824: recordPayment / recordStandalonePayment are the Idempotency-Key entry points; the bodies are these.
  "invoices/invoices.service.ts::InvoicesService.writeInvoicePayment": T,
  "invoices/invoices.service.ts::InvoicesService.writeStandalonePayment": T,
  // #2262 / SA-424: the bulk import now writes payments and the Invoice row in one tx.
  "import/import.service.ts::ImportService.importInvoices": T,
  "import/import.service.ts::ImportService.importPayments": T,
};

const SRC = path.resolve(__dirname, "..");
const WRITE = /\.invoicePayment\.(create|createMany|upsert)$/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
    return /\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)
      ? [p]
      : [];
  });
}

interface Site {
  key: string;
  /** Per payment write: its receiver, and whether a same-receiver Invoice update COVERS it. */
  writes: Array<{ receiver: string; covered: boolean }>;
}

/**
 * The nodes on `node`'s path to `stop` that sit in ONE branch of a condition, loop or catch — the
 * places a statement can be skipped. SA-404d R2: an Invoice update only covers a payment create when
 * every such branch the update sits in also holds the create (walks the ancestor chain), so an
 * update nested under `if (status === "PAID")` can never be a false green for the create above it.
 */
function branchChildren(node: ts.Node, stop: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  for (let n: ts.Node = node; n && n !== stop; n = n.parent) {
    const p = n.parent;
    if (!p) break;
    const inBranch =
      (ts.isIfStatement(p) && (n === p.thenStatement || n === p.elseStatement)) ||
      (ts.isConditionalExpression(p) && (n === p.whenTrue || n === p.whenFalse)) ||
      ts.isCaseClause(p) ||
      ts.isDefaultClause(p) ||
      ts.isCatchClause(p) ||
      ((ts.isForStatement(p) ||
        ts.isForOfStatement(p) ||
        ts.isForInStatement(p) ||
        ts.isWhileStatement(p) ||
        ts.isDoStatement(p)) &&
        n === (p as any).statement) ||
      (ts.isBinaryExpression(p) &&
        n === p.right &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(p.operatorToken.kind));
    if (inBranch) out.push(n);
  }
  return out;
}

function isAncestorOrSelf(a: ts.Node, n: ts.Node): boolean {
  for (let x: ts.Node | undefined = n; x; x = x.parent) if (x === a) return true;
  return false;
}

function inventory(): Site[] {
  const out: Site[] = [];
  for (const file of files(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("invoicePayment")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const visitMethod = (owner: string, m: ts.Node, name: string) => {
      const creates: Array<{ node: ts.Node; receiver: string }> = [];
      const updates: Array<{ node: ts.Node; receiver: string }> = [];
      const walk = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const callee = n.expression.getText(sf).replace(/\s+/g, "");
          const c = callee.match(/^(.*)\.invoicePayment\.(create|createMany|upsert)$/);
          if (c && WRITE.test(callee)) creates.push({ node: n, receiver: c[1] });
          const u = callee.match(/^(.*)\.invoice\.(update|updateMany|create)$/); // SA-424 F1(a)
          if (u) updates.push({ node: n, receiver: u[1] });
        }
        ts.forEachChild(n, walk);
      };
      walk(m);
      if (!creates.length) return;
      const writes = creates.map((c) => ({
        receiver: c.receiver,
        covered: updates.some(
          (u) =>
            u.receiver === c.receiver &&
            branchChildren(u.node, m).every((branch) => isAncestorOrSelf(branch, c.node)),
        ),
      }));
      out.push({ key: `${rel}::${owner}.${name}`, writes });
    };
    const visit = (n: ts.Node) => {
      if (ts.isClassDeclaration(n) && n.name) {
        for (const mem of n.members)
          if ((ts.isMethodDeclaration(mem) || ts.isPropertyDeclaration(mem)) && mem.name)
            visitMethod(n.name.text, mem, mem.name.getText(sf));
        return;
      }
      if (ts.isFunctionDeclaration(n) && n.name) return visitMethod("<fn>", n, n.name.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Positive control source: the R2 false green (update only under a condition the create isn't under). */
const CONDITIONAL_ONLY = `class X { async m(tx: any, s: string) {
  await tx.invoicePayment.create({ data: {} });
  if (s === "PAID") { await tx.invoice.update({ where: { id: "i" }, data: {} }); }
} }`;
const UNCONDITIONAL = `class X { async m(tx: any, s: string) {
  await tx.invoicePayment.create({ data: {} });
  const data = s === "PAID" ? { status: "PAID" } : { updatedAt: new Date() };
  await tx.invoice.update({ where: { id: "i" }, data });
} }`;

/** SA-424 F1(a) controls: an invoice CREATE on the same client covers under the same branch rule. */
const CREATE_SAME_TX = `class X { async m(tx: any, s: string) {
  await tx.invoice.create({ data: {} });
  if (s === "PAID") { await tx.invoicePayment.create({ data: {} }); }
} }`;
const CREATE_ONLY_CONDITIONAL = `class X { async m(tx: any, s: string) {
  await tx.invoicePayment.create({ data: {} });
  if (s === "NEW") { await tx.invoice.create({ data: {} }); }
} }`;
const CREATE_OTHER_CLIENT = `class X { prisma: any; async m(tx: any) {
  await this.prisma.invoice.create({ data: {} });
  await tx.invoicePayment.create({ data: {} });
} }`;

/** Whether the lone create in `src` is covered — the same rule the inventory applies. */
function coveredIn(src: string): boolean {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true);
  const m = (sf.statements[0] as ts.ClassDeclaration).members[0];
  const creates: ts.Node[] = [];
  const updates: ts.Node[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const t = n.expression.getText(sf);
      if (t === "tx.invoicePayment.create") creates.push(n);
      if (t === "tx.invoice.update" || t === "tx.invoice.create") updates.push(n);
    }
    ts.forEachChild(n, walk);
  };
  walk(m);
  return updates.some((u) => branchChildren(u, m).every((b) => isAncestorOrSelf(b, creates[0])));
}

describe("InvoicePayment writers update the Invoice row in the same transaction (SA-404a b1)", () => {
  const sites = inventory();

  it("the inventory equals the table, both ways", () => {
    expect(sites.map((s) => s.key)).toEqual(Object.keys(TABLE).sort());
  });

  it("EXEMPT rows are count-pinned and shrink-only, each with a written reason", () => {
    const exempt = Object.values(TABLE).filter(
      (r): r is { kind: "EXEMPT"; why: string } => r.kind === "EXEMPT",
    );
    expect(exempt).toHaveLength(EXEMPT_BASELINE);
    for (const r of exempt) expect(r.why.length).toBeGreaterThan(40);
  });

  it("positive control: an update only under a condition the create isn't under does NOT cover it (SA-404d R2)", () => {
    expect(coveredIn(CONDITIONAL_ONLY)).toBe(false);
    // Conservative by design: an if/else pair of updates does not count — compute the data under the
    // condition and write ONE unconditional update (the recordStandalonePayment shape).
    expect(coveredIn(UNCONDITIONAL)).toBe(true);
  });

  it("SA-424 F1(a) controls: a same-client invoice CREATE covers; a conditional or other-client one does not", () => {
    expect(coveredIn(CREATE_SAME_TX)).toBe(true);
    expect(coveredIn(CREATE_ONLY_CONDITIONAL)).toBe(false);
    expect(coveredIn(CREATE_OTHER_CLIENT)).toBe(false);
  });

  it.each(Object.entries(TABLE).filter(([, r]) => r.kind === "TOUCHES"))(
    "%s: every payment write is covered by an unconditional same-tx Invoice update",
    (key) => {
      const site = sites.find((s) => s.key === key)!;
      for (const w of site.writes) {
        expect(w.receiver).not.toMatch(/this\.prisma/); // a transaction client, not the pool
        expect(w.covered).toBe(true);
      }
    },
  );
});

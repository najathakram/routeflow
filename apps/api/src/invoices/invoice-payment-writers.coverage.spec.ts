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
 *             calls `<that client>.invoice.update` / `.updateMany` (AST-checked below).
 *   EXEMPT  — does not meet that shape; the reason is recorded and owned by a ruling.
 *
 * Same technique as selling-restrictions/sellable-writers-coverage.spec.ts: the inventory must EQUAL
 * this table both ways — a NEW payment writer fails until it is classified, and a TOUCHES row whose
 * method stops updating the invoice goes red.
 */
type Row = { kind: "TOUCHES" } | { kind: "EXEMPT"; why: string };
const T: Row = { kind: "TOUCHES" };
const X = (why: string): Row => ({ kind: "EXEMPT", why });

const TABLE: Record<string, Row> = {
  "bookkeeping/bookkeeping.service.ts::BookkeepingService.recordPayment": T,
  "credit-notes/credit-notes.service.ts::CreditNotesService.applyCreditInTx": T,
  "customers/customers.service.ts::CustomersService.applyAdvancePaymentToInvoiceLocked": T,
  "invoices/invoices.service.ts::InvoicesService.recordDeliveryPaymentInTx": T,
  "invoices/invoices.service.ts::InvoicesService.recordPayment": T,
  "invoices/invoices.service.ts::InvoicesService.recordStandalonePayment": T,
  // Operator-run bulk Zoho import: payments written through the pool, no transaction, no Invoice
  // update in the same statement set. The exception is owned by the SA (SA-404a b1 follow-up).
  "import/import.service.ts::ImportService.importInvoices": X(
    "SA-404a b1: bulk import writes synthetic payments outside a tx — exception pending an SA ruling",
  ),
  "import/import.service.ts::ImportService.importPayments": X(
    "SA-404a b1: bulk import writes payments outside a tx — exception pending an SA ruling",
  ),
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
  receivers: string[]; // the client each payment write goes through (`tx`, `this.prisma.forTenant()`)
  invoiceUpdateReceivers: string[];
}

function inventory(): Site[] {
  const out: Site[] = [];
  for (const file of files(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("invoicePayment")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const visitMethod = (owner: string, m: ts.Node, name: string) => {
      const receivers: string[] = [];
      const invoiceUpdateReceivers: string[] = [];
      const walk = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const callee = n.expression.getText(sf).replace(/\s+/g, "");
          const m1 = callee.match(/^(.*)\.invoicePayment\.(create|createMany|upsert)$/);
          if (m1 && WRITE.test(callee)) receivers.push(m1[1]);
          const m2 = callee.match(/^(.*)\.invoice\.(update|updateMany)$/);
          if (m2) invoiceUpdateReceivers.push(m2[1]);
        }
        ts.forEachChild(n, walk);
      };
      walk(m);
      if (receivers.length)
        out.push({ key: `${rel}::${owner}.${name}`, receivers, invoiceUpdateReceivers });
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

describe("InvoicePayment writers update the Invoice row in the same transaction (SA-404a b1)", () => {
  const sites = inventory();

  it("the inventory equals the table, both ways", () => {
    expect(sites.map((s) => s.key)).toEqual(Object.keys(TABLE).sort());
  });

  it.each(Object.entries(TABLE).filter(([, r]) => r.kind === "TOUCHES"))(
    "%s writes through a tx client that also updates the Invoice",
    (key) => {
      const site = sites.find((s) => s.key === key)!;
      for (const recv of site.receivers) {
        expect(recv).not.toMatch(/this\.prisma/); // a transaction client, not the pool
        expect(site.invoiceUpdateReceivers).toContain(recv);
      }
    },
  );
});

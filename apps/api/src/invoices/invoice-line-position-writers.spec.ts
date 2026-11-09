import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * W-1187 (D1, D6, P2 invoice half): the invoice follows its order, so EVERY writer that creates an InvoiceItem stamps a
 * `position`. A line with no position drops the whole invoice back to the A-Z fallback (invoiceLinesInOrder) and a
 * partial stamping prints a different order on the screen than on the PDF. Structure, not text (TypeScript AST,
 * comments cannot satisfy it):
 *
 *   W1  every site that creates InvoiceItem rows (an `invoiceItem.create(` call, or an `items: { create }` inside an
 *       `invoice.create` / `invoice.update` / `invoice.upsert`) sits in a function that stamps positions through
 *       `stampInvoicePositions(` or `rankInvoiceLines(`, or names `position` in its data. The NUMBER of sites is
 *       pinned, so a new writer fails here until it is placed on purpose.
 *   W2  the three writers the copier contract lists as NOT copiers (`create`, `update`, `setCheckStatus`) are pinned by
 *       name: the contract's column check never sees them, so this is the only thing that forces `position` on them.
 *       (`position` for the NSF fee comes from `nextTailPosition`, unit-tested in invoice-line-position.spec.ts.)
 *   W3  the helpers are the ONLY place that calls the A-Z comparator: every other reader asks for the shown order.
 */
const SRC = path.resolve(__dirname, "..");

function sources(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "testing" ? [] : sources(p);
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name) ? [p] : [];
  });
}

const parsed = sources().map((file) => ({
  file: path.relative(SRC, file).replace(/\\/g, "/"),
  sf: ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
}));

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

const propName = (p: ts.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;

/** The class method or top-level function a node sits in (the unit a stamp call must share). */
function owner(node: ts.Node): ts.Node | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) return n;
  }
  return undefined;
}

const nameOf = (n: ts.Node | undefined): string =>
  n && (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name
    ? n.name.getText()
    : "<top level>";

const STAMPS =
  /\b(?:stampInvoicePositions|stampFromOrder|stampEditedPositions|rankInvoiceLines|copyInvoicePositions)\(/;

interface Site {
  file: string;
  line: number;
  fn: string;
  stamps: boolean;
}

function invoiceItemWriters(): Site[] {
  const found: Site[] = [];
  for (const { file, sf } of parsed) {
    walk(sf, (n) => {
      // (a) `<x>.invoiceItem.create(...)`
      if (ts.isCallExpression(n) && /\binvoiceItem\.create$/.test(n.expression.getText(sf))) {
        const o = owner(n);
        const dataArg = n.arguments[0]?.getText(sf) ?? "";
        found.push({
          file,
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          fn: nameOf(o),
          stamps: /\bposition\b/.test(dataArg) || (!!o && STAMPS.test(o.getText(sf))),
        });
      }
      // (b) `items: { create: ... }` under an invoice create / update / upsert
      if (
        ts.isPropertyAssignment(n) &&
        propName(n) === "items" &&
        ts.isObjectLiteralExpression(n.initializer) &&
        n.initializer.properties.some((p) => propName(p) === "create")
      ) {
        let call: ts.Node | undefined = n.parent;
        while (call && !ts.isCallExpression(call)) call = call.parent;
        if (
          !call ||
          !/\binvoice\.(create|update|upsert)$/.test(
            (call as ts.CallExpression).expression.getText(sf),
          )
        )
          return;
        const o = owner(n);
        found.push({
          file,
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          fn: nameOf(o),
          stamps: !!o && STAMPS.test(o.getText(sf)),
        });
      }
    });
  }
  return found;
}

/** Every InvoiceItem-creating site in the API. A new one fails here until it stamps a position and the count moves. */
const INVOICE_ITEM_WRITER_SITES = 10;

describe("W1: every InvoiceItem create stamps a position", () => {
  const sites = invoiceItemWriters();

  it("the number of InvoiceItem-creating sites is the known one", () => {
    expect(sites).toHaveLength(INVOICE_ITEM_WRITER_SITES);
  });

  it("each sits in a function that stamps positions", () => {
    expect(sites.filter((s) => !s.stamps).map((s) => `${s.file}:${s.line} (${s.fn})`)).toEqual([]);
  });

  it("the writers are the ones the ruling names", () => {
    expect(
      sites
        .map((s) => `${s.file}::${s.fn}`)
        .sort()
        .filter((v, i, a) => a.indexOf(v) === i),
    ).toEqual(
      [
        "estimates/estimates.service.ts::convertToInvoice",
        "import/import.service.ts::importInvoices",
        "invoices/invoices.service.ts::create",
        "invoices/invoices.service.ts::createSplitInvoices",
        "invoices/invoices.service.ts::createPartialFromOrder",
        "invoices/invoices.service.ts::duplicate",
        "invoices/invoices.service.ts::reconcileOrderDraftInvoiceLocked",
        "invoices/invoices.service.ts::rebuildSiblingDrafts",
        "invoices/invoices.service.ts::setCheckStatus",
        "invoices/invoices.service.ts::update",
      ].sort(),
    );
  });
});

describe("W2: the writers the copier contract lists as not-copiers are pinned by name", () => {
  const text = fs.readFileSync(path.join(SRC, "invoices/invoices.service.ts"), "utf8");
  const body = (name: string): string => {
    const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
    let out = "";
    walk(sf, (n) => {
      if (ts.isMethodDeclaration(n) && n.name.getText() === name && n.body)
        out = n.body.getText(sf);
    });
    return out;
  };

  it.each(["create", "update", "setCheckStatus"])("InvoicesService.%s stamps position", (name) => {
    const b = body(name);
    expect(b.length).toBeGreaterThan(0);
    expect(STAMPS.test(b) || /\bposition\b/.test(b)).toBe(true);
  });

  it("the NSF fee lands LAST: its position comes from nextTailPosition (the invoice's max + 1)", () => {
    expect(body("setCheckStatus")).toMatch(/position:\s*await nextTailPosition\(/);
  });
});

describe("W3: the A-Z comparator has one caller", () => {
  it("only invoice-line-position.ts (the legacy fallback) calls sortInvoiceLines", () => {
    const callers = parsed
      .filter(({ file }) => file !== "invoices/invoice-line-order.ts")
      .filter(({ sf }) =>
        /\bsortInvoiceLines\(/.test(sf.getText().replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")),
      )
      .map(({ file }) => file);
    expect(callers).toEqual(["invoices/invoice-line-position.ts"]);
  });
});

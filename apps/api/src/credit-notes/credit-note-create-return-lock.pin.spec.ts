import fs from "node:fs";
import path from "node:path";

/**
 * SA-893 R7 (row 631 PR-1): `CreditNotesService.create` writes its Return's link (`tx.return.updateMany`, an implicit row
 * lock on an existing Return) when a caller passes `internal.returnId`. Its caller `ReturnsService#processRefund` does so
 * AFTER its claim transaction committed, so no Return is held: the create took Order -> Invoice -> Return, the inverse of
 * every return path (Return -> Order -> Invoice, `ROW_LOCK_ORDER`), and deadlocked against an inline issueCredit. The
 * create now locks that Return FOR UPDATE as its transaction's FIRST row lock. Every caller is count-pinned, so a new
 * caller that passes a returnId is classified before it ships.
 */
const SRC = path.resolve(__dirname, "..");
const strip = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "testing" ? [] : walk(p);
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name) ? [p] : [];
  });
const HEAD =
  /^(?:(?:export )?(?:async )?function (\w+)\b[^\n]*|  (?:private |public |protected |static )*(?:async )?(\w+)\((?:[^\n]*\{[ \t]*|[ \t]*))$/gm;

/** `file#method` -> does that call pass a returnId (the call's text up to its closing `);`). */
function createCallers(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const file of walk(SRC)) {
    const src = strip(fs.readFileSync(file, "utf8"));
    const call = /\b(?:creditNotesService|creditNotes)\.create\(/g;
    let m: RegExpExecArray | null;
    while ((m = call.exec(src))) {
      let name = "?";
      HEAD.lastIndex = 0;
      let h: RegExpExecArray | null;
      while ((h = HEAD.exec(src)) && h.index < m.index) name = h[1] ?? h[2];
      const text = src.slice(m.index, src.indexOf(");", m.index));
      out[`${path.relative(SRC, file).split(path.sep).join("/")}#${name}`] = /\breturnId\b/.test(
        text,
      );
    }
  }
  return out;
}

describe("SA-893 R7: a credit note that links a Return locks that Return first", () => {
  it("every CreditNotesService.create caller is classified (count-pinned): only processRefund passes a returnId", () => {
    expect(createCallers()).toEqual({
      "credit-notes/credit-notes.controller.ts#create": false,
      "returns/returns.service.ts#processRefund": true, // after its claim committed: NO Return held
    });
  });

  it("create() locks internal.returnId's Return FOR UPDATE before any Order or Invoice lock in its transaction", () => {
    const src = strip(
      fs.readFileSync(path.join(SRC, "credit-notes/credit-notes.service.ts"), "utf8"),
    );
    const start = src.indexOf("cn = await this.prisma.tenantTransaction(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("isolationLevel", start));
    const returnLock = body.search(
      /if \(internal\.returnId\)[\s\S]{0,200}FROM "Return"[^`]*FOR UPDATE/,
    );
    const orderPool = body.indexOf("lockOrderPoolRows(");
    const invoiceLock = body.search(/FROM "Invoice"[^`]*FOR UPDATE/);
    const link = body.indexOf("tx.return.updateMany(");
    expect(returnLock).toBeGreaterThan(-1);
    expect(returnLock).toBeLessThan(orderPool);
    expect(returnLock).toBeLessThan(invoiceLock);
    expect(link).toBeGreaterThan(returnLock);
  });
});

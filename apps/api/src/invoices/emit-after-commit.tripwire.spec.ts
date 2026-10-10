import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * #2175 (SA-487 (5)): no realtime emit is made LEXICALLY inside a transaction callback in
 * invoices.service.ts or credit-notes.service.ts. A `gateway.emit*` call inside the function
 * handed to `tenantTransaction` / `$transaction` / `withAfterCommit` would reach clients before the
 * commit (and survive a rollback). Inside a tx the only allowed form is the queued
 * `after.defer(this.gateway).emit*`, flushed by withAfterCommit after the commit
 * (common/after-commit.ts). Credit notes already emit outside the tx (B343); this pins that.
 */
const SRC = path.resolve(__dirname, "..");
const TX_OPENERS = /(^|\.)(tenantTransaction|\$transaction|withAfterCommit)$/;
const DIRECT_EMIT = /(^|\.)gateway\.emit\w+$/;

/** Every direct `gateway.emit*` call that sits inside a tx-opener's function argument. */
function emitsInsideTx(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node, inTx: boolean): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (inTx && DIRECT_EMIT.test(callee)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${fileName}:${line + 1} ${callee}`);
      }
      if (TX_OPENERS.test(callee)) {
        visit(node.expression, inTx);
        for (const arg of node.arguments)
          visit(arg, inTx || ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, inTx));
  };
  visit(sf, false);
  return hits;
}

describe("#2175 tripwire: no gateway.emit* inside a transaction callback", () => {
  it("controls: the scanner flags an in-tx emit and passes the queued and post-commit forms", () => {
    const flagged = [
      "this.prisma.tenantTransaction(async (tx) => { this.gateway.emitInvoiceUpdated(t, p); });",
      "this.prisma.$transaction(async (tx) => { if (x) { this.gateway.emitCreditNoteVoided(t, p); } });",
      "withAfterCommit(this.prisma, async (tx, after) => { this.gateway.emitInvoiceUpdated(t, p); });",
      "this.prisma.tenantTransaction(function (tx) { return this.gateway.emitX(); });",
    ];
    for (const src of flagged) expect(emitsInsideTx("control.ts", src)).toHaveLength(1);
    const clean = [
      "withAfterCommit(this.prisma, async (tx, after) => { after.defer(this.gateway).emitInvoiceUpdated(t, p); });",
      "const r = await this.prisma.tenantTransaction(async (tx) => r0); this.gateway.emitInvoiceUpdated(t, p);",
      "this.gateway.emitCreditNoteCreated(t, p);",
    ];
    for (const src of clean) expect(emitsInsideTx("control.ts", src)).toEqual([]);
  });

  it.each([
    "invoices/invoices.service.ts",
    "invoices/payment-void-tx.ts",
    "credit-notes/credit-notes.service.ts",
  ])("%s has no direct emit inside a transaction callback", (rel) => {
    expect(emitsInsideTx(rel, fs.readFileSync(path.join(SRC, rel), "utf8"))).toEqual([]);
  });

  it("never passes vacuously: the queued sites exist, and credit notes still emit (after the tx)", () => {
    const inv = fs.readFileSync(path.join(SRC, "invoices/invoices.service.ts"), "utf8");
    const cn = fs.readFileSync(path.join(SRC, "credit-notes/credit-notes.service.ts"), "utf8");
    // recordPayment, updatePayment, deletePayment, deleteInvoice, setCheckStatus x2, recordDeliveryPaymentInTx
    // (voidPayment's emit moved verbatim to payment-void-tx.ts, SA-762r: voidPaymentInTx, queued on the caller's after)
    const voidTx = fs.readFileSync(path.join(SRC, "invoices/payment-void-tx.ts"), "utf8");
    expect(inv.match(/after\.defer\(this\.gateway\)\.emitInvoiceUpdated\(/g)).toHaveLength(7);
    expect(voidTx.match(/after\.defer\(deps\.gateway\)\.emitInvoiceUpdated\(/g)).toHaveLength(1);
    expect(inv.match(/withAfterCommit\(this\.prisma, async \(tx, after\) =>/g)).toHaveLength(5);
    expect(cn.match(/this\.gateway\.emitCreditNote\w+\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

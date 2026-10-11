/**
 * SA-773 structural pin (L-205: read through the TypeScript AST, never a text match on the source): every value-giver reads the
 * ONE refundable remainder under its locks BEFORE its claim or mint, and the set of value-givers is closed. A new writer of a
 * credit note or of a REFUNDED return fails here until somebody decides how it reads the remainder.
 *
 * The behavioural proof (the read happens after the locks, the 409 body) is in returns-refundable-remainder.spec.ts and
 * credit-notes.refundable-remainder.spec.ts; this pin is the inventory that keeps those two from silently becoming three.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC = path.resolve(__dirname, "..");

interface FnFacts {
  name: string;
  /** every called name (the last identifier of the callee) with its source position */
  calls: Array<{ name: string; pos: number }>;
  /** `<x>.return.updateMany|update` calls whose `data` sets status: "REFUNDED" */
  refundedWrites: number[];
  /** `<x>.return.updateMany|update` calls, any data */
  returnWrites: number[];
  /** `<x>.creditNote.create|createMany` calls */
  creditNoteWrites: number[];
}

const propChain = (e: ts.Expression): string[] => {
  const out: string[] = [];
  let cur: ts.Expression = e;
  while (ts.isPropertyAccessExpression(cur)) {
    out.unshift(cur.name.text);
    cur = cur.expression;
  }
  if (ts.isIdentifier(cur)) out.unshift(cur.text);
  else if (cur.kind === ts.SyntaxKind.ThisKeyword) out.unshift("this");
  return out;
};

/**
 * A return write that can set status REFUNDED: its source mentions REFUNDED anywhere (a literal, a constant named for it), or its
 * `data` is not a plain object literal with a literal status (an identifier, a spread, a call: it could carry anything). The
 * heuristic over-reports on purpose: an over-reported writer must be classified in the inventory below, never silently skipped.
 */
const hasRefundedStatus = (call: ts.CallExpression, sf: ts.SourceFile): boolean => {
  const arg = call.arguments[0];
  if (!arg) return false;
  if (arg.getText(sf).includes("REFUNDED")) return true;
  if (!ts.isObjectLiteralExpression(arg)) return true;
  const data = arg.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "data",
  );
  if (!data) return arg.properties.some((p) => ts.isSpreadAssignment(p));
  if (!ts.isObjectLiteralExpression(data.initializer)) return true;
  return data.initializer.properties.some(
    (p) => ts.isSpreadAssignment(p) || (ts.isPropertyAssignment(p) && !ts.isIdentifier(p.name)),
  );
};

/** Facts per named function / method of a source file (a call belongs to its nearest named enclosing declaration). */
function factsOf(rel: string): Map<string, FnFacts> {
  const file = path.join(SRC, rel);
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const out = new Map<string, FnFacts>();
  const visit = (node: ts.Node, fn: FnFacts | null): void => {
    let current = fn;
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      current = {
        name: node.name.text,
        calls: [],
        refundedWrites: [],
        returnWrites: [],
        creditNoteWrites: [],
      };
      out.set(`${node.name.text}`, current);
    }
    if (ts.isCallExpression(node) && current) {
      const chain = propChain(node.expression);
      const callee = chain[chain.length - 1];
      if (callee) current.calls.push({ name: callee, pos: node.getStart(sf) });
      const owner = chain[chain.length - 2];
      if (owner === "return" && (callee === "updateMany" || callee === "update")) {
        current.returnWrites.push(node.getStart(sf));
        if (hasRefundedStatus(node, sf)) current.refundedWrites.push(node.getStart(sf));
      }
      if (owner === "creditNote" && (callee === "create" || callee === "createMany"))
        current.creditNoteWrites.push(node.getStart(sf));
    }
    ts.forEachChild(node, (c) => visit(c, current));
  };
  visit(sf, null);
  return out;
}

const firstPos = (f: FnFacts, name: string): number => {
  const hit = f.calls.find((c) => c.name === name);
  return hit ? hit.pos : -1;
};
const positions = (f: FnFacts, name: string): number[] =>
  f.calls.filter((c) => c.name === name).map((c) => c.pos);

function walkSources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "dist"].includes(e.name)) walkSources(full, out);
    } else if (e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("SA-773: every value-giver reads the refundable remainder under its locks, before its claim or mint", () => {
  const returnsSvc = factsOf("returns/returns.service.ts");
  const inlineSvc = factsOf("returns/inline-returns.service.ts");
  const creditSvc = factsOf("credit-notes/credit-notes.service.ts");
  const reissueSvc = factsOf("credit-notes/credit-note-reissue.service.ts");
  const guard = factsOf("returns/refund-remainder-guard.ts");

  it("the STANDARD refund claim (store credit and recorded) checks the remainder before its RECEIVED -> REFUNDED claim", () => {
    const claim = returnsSvc.get("claimRefund")!;
    const check = firstPos(claim, "assertStandardRefundWithinRemainder");
    expect(check).toBeGreaterThan(-1);
    expect(claim.returnWrites.length).toBeGreaterThan(0);
    for (const write of claim.returnWrites) expect(check).toBeLessThan(write);
    // and after the three row locks it takes (the lock helpers are called before the check)
    expect(firstPos(claim, "lockRefundOrders")).toBeGreaterThan(-1);
    expect(firstPos(claim, "lockRefundOrders")).toBeLessThan(check);
    expect(firstPos(claim, "lockRefundInvoices")).toBeLessThan(check);
  });

  it("the refund preview (findOne's refundEstimate) reads the remainder through the preview helper, only for a return that can be refunded", () => {
    const findOne = returnsSvc.get("findOne")!;
    expect(firstPos(findOne, "previewStandardRefund")).toBeGreaterThan(-1);
    // priceReturn itself stays pure and synchronous (the list prices a page without a query per row); the quote reads
    // selectedGoodsRemainder on the split-payment branch, so that helper has no caller here by design
    const priceReturn = returnsSvc.get("priceReturn")!;
    expect(
      priceReturn.calls.some((c) =>
        ["findMany", "findFirst", "refundableRemainder"].includes(c.name),
      ),
    ).toBe(false);
  });

  it.each(["refund", "storeCreditInstead"])(
    "the inline %s() checks the remainder after its locks and before its claim",
    (method) => {
      const fn = inlineSvc.get(method)!;
      const check = firstPos(fn, "assertInlineReturnWithinRemainder");
      expect(check).toBeGreaterThan(-1);
      expect(firstPos(fn, "lockRefundOrders")).toBeLessThan(check);
      expect(firstPos(fn, "lockRefundInvoices")).toBeLessThan(check);
      const claims = fn.returnWrites;
      expect(claims.length).toBeGreaterThan(0);
      for (const write of claims) expect(check).toBeLessThan(write);
    },
  );

  it("an inline capture that is not held asks the remainder before it creates the return or numbers it, and the order-create path goes through that capture before it mints", () => {
    const capture = inlineSvc.get("captureInTx")!;
    const check = firstPos(capture, "assertInlineReturnWithinRemainder");
    expect(check).toBeGreaterThan(-1);
    // after the source Orders are locked and the per-line headroom ran (which also writes the source invoice rows)
    expect(firstPos(capture, "lockRefundOrders")).toBeLessThan(check);
    expect(firstPos(capture, "assertWithinLineHeadroom")).toBeLessThan(check);
    // before the number is burned and before the return row exists
    expect(check).toBeLessThan(firstPos(capture, "reserveNext"));
    for (const create of capture.calls.filter((c) => c.name === "create"))
      expect(check).toBeLessThan(create.pos);
    const orderCreate = inlineSvc.get("captureAndIssueInTx")!;
    expect(firstPos(orderCreate, "captureInTx")).toBeGreaterThan(-1);
    expect(firstPos(orderCreate, "captureInTx")).toBeLessThan(
      firstPos(orderCreate, "issueCreditInTx"),
    );
  });

  it("a standalone credit note asks the remainder at BOTH exits of validateAndBuildCnItems, and create() and the reissue validate before they insert", () => {
    const validate = creditSvc.get("validateAndBuildCnItems")!;
    expect(positions(validate, "assertWithinRemainder")).toHaveLength(2);
    const asks = creditSvc.get("assertWithinRemainder")!;
    expect(firstPos(asks, "assertCreditWithinRemainder")).toBeGreaterThan(-1);

    const create = creditSvc.get("create")!;
    const reissue =
      reissueSvc.get("reissue") ??
      [...reissueSvc.values()].find((f) => positions(f, "insertCreditNoteInTx").length > 0)!;
    for (const fn of [create, reissue]) {
      const inserts = positions(fn, "insertCreditNoteInTx");
      expect(inserts.length).toBeGreaterThan(0);
      for (const insert of inserts) {
        const validations = positions(fn, "validateAndBuildCnItems").filter((p) => p < insert);
        expect(validations.length).toBeGreaterThan(0);
      }
    }
  });

  it("each guard reads the ONE remainder and then asserts it", () => {
    for (const name of [
      "assertInlineReturnWithinRemainder",
      "assertStandardRefundWithinRemainder",
      "assertCreditWithinRemainder",
    ]) {
      const fn = guard.get(name)!;
      expect(firstPos(fn, "refundableRemainder")).toBeGreaterThan(-1);
      expect(firstPos(fn, "assertWithinRefundable")).toBeGreaterThan(
        firstPos(fn, "refundableRemainder"),
      );
    }
  });

  // ─── the CALLERS of the value-giving helpers are a closed set, each with its remainder check ────────────

  /** Every function in apps/api/src that calls `helper(...)` (any receiver), as file::function. */
  const callersOf = (helper: string): string[] => {
    const out: string[] = [];
    for (const file of walkSources(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      if (!fs.readFileSync(file, "utf8").includes(helper)) continue;
      for (const f of factsOf(rel).values())
        if (f.calls.some((c) => c.name === helper) && f.name !== helper)
          out.push(`${rel}::${f.name}`);
    }
    return out.sort();
  };

  it("insertCreditNoteInTx is called by create() and the reissue only, each validating (the remainder included) before it inserts", () => {
    expect(callersOf("insertCreditNoteInTx")).toEqual([
      "credit-notes/credit-note-reissue.service.ts::reissue",
      "credit-notes/credit-notes.service.ts::create",
    ]);
  });

  it("mintStandaloneInTx is called by issueCreditInTx only, and issueCreditInTx by exactly the four classified callers, each with its check", () => {
    expect(callersOf("mintStandaloneInTx")).toEqual([
      "returns/inline-returns.service.ts::issueCreditInTx",
    ]);
    expect(callersOf("issueCreditInTx")).toEqual([
      "returns/inline-returns.service.ts::approve",
      "returns/inline-returns.service.ts::captureAndIssueInTx",
      "returns/inline-returns.service.ts::issueCredit",
      "returns/inline-returns.service.ts::storeCreditInstead",
    ]);
    const issue = (fn: string) => inlineSvc.get(fn)!;
    // approve() and storeCreditInstead() ask the remainder themselves, before they mint
    for (const fn of ["approve", "storeCreditInstead"]) {
      const f = issue(fn);
      expect(firstPos(f, "assertInlineReturnWithinRemainder")).toBeGreaterThan(-1);
      expect(firstPos(f, "assertInlineReturnWithinRemainder")).toBeLessThan(
        firstPos(f, "issueCreditInTx"),
      );
    }
    // approve() also asks it before it restocks or reverses the ledger
    expect(firstPos(issue("approve"), "assertInlineReturnWithinRemainder")).toBeLessThan(
      firstPos(issue("approve"), "restockReturnItems"),
    );
    // captureAndIssueInTx runs the capture (which asks it) before it mints
    expect(firstPos(issue("captureAndIssueInTx"), "captureInTx")).toBeLessThan(
      firstPos(issue("captureAndIssueInTx"), "issueCreditInTx"),
    );
    // issueCredit() is the one TRANSITIONAL unchecked caller (the immediate issue after a checked capture; see its comment): it must
    // stay the only one, and never grow a second way in
    expect(firstPos(issue("issueCredit"), "assertInlineReturnWithinRemainder")).toBe(-1);
  });

  // ─── the inventory is closed ─────────────────────────────────────────────

  /** Every function in apps/api/src that writes a credit note row, by file::function. */
  const creditNoteWriters = (): string[] => {
    const out: string[] = [];
    for (const file of walkSources(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      if (!fs.readFileSync(file, "utf8").includes("creditNote")) continue;
      for (const f of factsOf(rel).values())
        if (f.creditNoteWrites.length > 0) out.push(`${rel}::${f.name}`);
    }
    return out.sort();
  };
  const refundedWriters = (): string[] => {
    const out: string[] = [];
    for (const file of walkSources(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      if (!fs.readFileSync(file, "utf8").includes("REFUNDED")) continue;
      for (const f of factsOf(rel).values())
        if (f.refundedWrites.length > 0) out.push(`${rel}::${f.name}`);
    }
    return out.sort();
  };

  it("the only writers of a credit note row are the two mint helpers (create/reissue go through insertCreditNoteInTx)", () => {
    expect(creditNoteWriters()).toEqual([
      // create() and the reissue: both validate (the remainder included) before this insert, pinned above
      "credit-notes/credit-notes.service.ts::insertCreditNoteInTx",
      // the inline store-credit mint: runs under the Return row lock after a capture that asked the remainder (or a held one
      // approve() releases); storeCreditInstead() asks it explicitly (all pinned above)
      "credit-notes/credit-notes.service.ts::mintStandaloneInTx",
    ]);
  });

  it("the only return writers that can set status REFUNDED are the three claims; the other over-reported writers set something else", () => {
    expect(refundedWriters()).toEqual(
      [
        // the STANDARD claim (store credit and recorded): pinned above
        // the store credit mint: its callers are captureAndIssueInTx / issueCredit (right after a capture that asked the remainder,
        // pinned above) and approve() (a HELD return was never credited: it reserves its goods in the remainder, so a later
        // value-giver is refused, and the capture it came from was held, not checked)
        "returns/inline-returns.service.ts::issueCreditInTx",
        // the inline cash refund: pinned above
        "returns/inline-returns.service.ts::refund",
        "returns/returns.service.ts::claimRefund",
        // over-reported by the broad heuristic, each reviewed: none of them sets REFUNDED
        "returns/refund-tender.ts::setRefundTender", // writes the tender column of an already-resolved return
        "returns/returns.service.ts::cancel", // the CAS to CANCELLED (a REFUNDED return cannot be cancelled)
        "returns/returns.service.ts::processRefund", // the compensation: REFUNDED back to RECEIVED when the mint failed
      ].sort(),
    );
  });
});

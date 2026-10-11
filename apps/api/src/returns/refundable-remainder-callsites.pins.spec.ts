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
import { Prisma } from "@prisma/client";

const SRC = path.resolve(__dirname, "..");

interface FnFacts {
  name: string;
  /** every called name (the last identifier of the callee) with its source position */
  calls: Array<{ name: string; pos: number }>;
  /** `<x>.return.updateMany|update` calls whose `data` sets status: "REFUNDED" */
  refundedWrites: number[];
  /** `<x>.return.updateMany|update` calls, any data */
  returnWrites: number[];
  /** `<x>.creditNote.create|createMany` calls (and any other write that creates a credit note row or its items) */
  creditNoteWrites: number[];
  /** an object-literal property / assignment that can set `ledgerReversedByReturn` (the flag that skips the remainder) */
  remainderSkips: number[];
  /** a `creditNotes.create(dto, <not an object literal, or with a spread>)`: its internal options cannot be read */
  opaqueMintOptions: number[];
}

/** Property names an expression chain walks through: `a.b.c`, `a["b"].c`, and `this`; a trailing `.call/.apply/.bind` is dropped. */
const propChain = (e: ts.Expression): string[] => {
  const out: string[] = [];
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      out.unshift(cur.name.text);
      cur = cur.expression;
    } else if (
      ts.isElementAccessExpression(cur) &&
      ts.isStringLiteralLike(cur.argumentExpression)
    ) {
      out.unshift(cur.argumentExpression.text);
      cur = cur.expression;
    } else if (
      ts.isNonNullExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      // `(tx.creditNote as any).create(...)`, `<any>tx.creditNote`, `tx.creditNote satisfies X`: a cast changes nothing
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
    } else break;
  }
  if (ts.isIdentifier(cur)) out.unshift(cur.text);
  else if (cur.kind === ts.SyntaxKind.ThisKeyword) out.unshift("this");
  while (out.length > 2 && ["call", "apply", "bind"].includes(out[out.length - 1])) out.pop();
  return out;
};

/** Every Prisma write verb: a model's create/update/upsert family. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
/** A credit note row is VALUE only when created; an update/void gives nothing back, so only the creating verbs count for it. */
const CREATING = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);
type Model = "creditNote" | "creditNoteItem" | "return";
const MODELS: Model[] = ["creditNote", "creditNoteItem", "return"];

/**
 * The relation field names through which a NESTED write reaches a credit note or a return (`customer.update({ data: {
 * creditNotes: { create } } })`), from Prisma's own datamodel so a new relation is picked up without anybody editing this pin.
 */
const relationNames = (target: string): Set<string> => {
  const out = new Set<string>();
  for (const m of Prisma.dmmf.datamodel.models)
    for (const f of m.fields) if (f.kind === "object" && f.type === target) out.add(f.name);
  return out;
};
const TO_CREDIT_NOTE = relationNames("CreditNote"); // creditNotes, creditNote
const TO_RETURN = relationNames("Return"); // returns, return
/** Nested verbs that create a row (a value-bearing write when the row is a credit note / a return). */
const NESTED_CREATING = new Set(["create", "createMany", "connectOrCreate", "upsert"]);
const NESTED_UPDATING = new Set(["update", "updateMany", "upsert"]);

/**
 * A return write that can set status REFUNDED: its source mentions REFUNDED anywhere (a literal, a constant named for it), or its
 * `data` is not a plain object literal with a literal status (an identifier, a spread, a call: it could carry anything). The
 * heuristic over-reports on purpose: an over-reported writer must be classified in the inventory below, never silently skipped.
 */
const hasRefundedStatus = (arg: ts.Expression | undefined, sf: ts.SourceFile): boolean => {
  if (!arg) return false;
  if (arg.getText(sf).includes("REFUNDED")) return true;
  if (!ts.isObjectLiteralExpression(arg)) return true;
  const data = arg.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "data",
  );
  if (!data) return arg.properties.some((p) => ts.isSpreadAssignment(p));
  if (!ts.isObjectLiteralExpression(data.initializer)) return true;
  // a spread, a shorthand `status`, or a `status` that is not a string literal (a constant, a call) could carry REFUNDED
  return data.initializer.properties.some(
    (p) =>
      ts.isSpreadAssignment(p) ||
      (ts.isShorthandPropertyAssignment(p) && p.name.text === "status") ||
      (ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === "status" &&
        !ts.isStringLiteralLike(p.initializer)),
  );
};

/** The name a function-like node is known by: a method / function name, or the property / variable an arrow is assigned to. */
const nameOfFunction = (node: ts.Node): string | null => {
  if (
    (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  )
    return node.name.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const p = node.parent;
    if (
      (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isVariableDeclaration(p)) &&
      ts.isIdentifier(p.name)
    )
      return p.name.text;
  }
  return null;
};

/**
 * Facts per named function of a source file (a call belongs to its nearest named enclosing declaration; code outside any is
 * "<module>"). Writers are found through plain calls, element access, .call/.bind, type casts (`(tx.creditNote as any)`), a model
 * alias (`const m = tx.creditNote; m.create()`), destructured verbs (`const { create } = tx.creditNote`), NESTED relation writes
 * (`customer.update({ data: { creditNotes: { create } } })`), and raw INSERT / UPDATE statements on the tables wherever the SQL
 * text sits (a tagged template, `Prisma.sql`, `Prisma.raw`, a string handed to `$executeRawUnsafe`, a string held in a variable).
 */
function factsOfSource(text: string, fileName = "fixture.ts"): Map<string, FnFacts> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const out = new Map<string, FnFacts>();
  const fresh = (name: string): FnFacts => {
    const f = out.get(name) ?? {
      name,
      calls: [],
      refundedWrites: [],
      returnWrites: [],
      creditNoteWrites: [],
      remainderSkips: [],
      opaqueMintOptions: [],
    };
    out.set(name, f);
    return f;
  };
  // pre-pass: model aliases (`const m = <x>.creditNote`, `const m = tx.creditNote as any`)
  const aliases = new Map<string, Model>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const last = propChain(node.initializer).pop();
      if (last && (MODELS as string[]).includes(last)) aliases.set(node.name.text, last as Model);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const record = (
    f: FnFacts,
    model: Model,
    verb: string,
    pos: number,
    refunded: boolean | ts.Expression | undefined,
  ): void => {
    if (model === "creditNote" || model === "creditNoteItem") {
      // a credit note row is value only when created; its items are value when created OR changed (an item's amount feeds the
      // per-line headroom of the same remainder)
      if (CREATING.has(verb) || model === "creditNoteItem") f.creditNoteWrites.push(pos);
    } else {
      f.returnWrites.push(pos);
      const isRefunded =
        typeof refunded === "boolean"
          ? refunded
          : refunded === undefined || hasRefundedStatus(refunded, sf);
      if (isRefunded) f.refundedWrites.push(pos);
    }
  };
  const propName = (p: ts.PropertyName): string | null =>
    ts.isIdentifier(p) || ts.isStringLiteralLike(p) ? p.text : null;
  /** The value-bearing writes nested inside a write call's argument: `{ data: { creditNotes: { create: … } } }`. */
  const nestedWrites = (arg: ts.Expression, model: Model | null, f: FnFacts): void => {
    const walk = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node)) {
        const name = propName(node.name);
        const value = node.initializer;
        if (name && ts.isObjectLiteralExpression(value)) {
          const verbs = value.properties
            .map((pr) => (ts.isPropertyAssignment(pr) ? propName(pr.name) : null))
            .filter((v): v is string => !!v);
          const toCreditNote =
            TO_CREDIT_NOTE.has(name) ||
            // a credit note's own items: `creditNote.update({ data: { items: { create } } })` adds lines to an existing note
            (name === "items" && model === "creditNote");
          if (toCreditNote && verbs.some((v) => NESTED_CREATING.has(v)))
            f.creditNoteWrites.push(node.getStart(sf));
          if (TO_RETURN.has(name)) {
            for (const pr of value.properties) {
              if (!ts.isPropertyAssignment(pr)) continue;
              const verb = propName(pr.name);
              if (!verb) continue;
              if (NESTED_CREATING.has(verb)) record(f, "return", verb, pr.getStart(sf), true);
              else if (NESTED_UPDATING.has(verb))
                record(f, "return", verb, pr.getStart(sf), pr.initializer);
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(arg);
  };
  const visit = (node: ts.Node, fn: FnFacts): void => {
    let current = fn;
    const name = nameOfFunction(node);
    if (name) current = fresh(name);
    if (ts.isCallExpression(node)) {
      const chain = propChain(node.expression);
      const callee = chain[chain.length - 1];
      if (callee) current.calls.push({ name: callee, pos: node.getStart(sf) });
      const owner = chain[chain.length - 2];
      const model = (MODELS as string[]).includes(owner ?? "")
        ? (owner as Model)
        : (aliases.get(owner ?? "") ?? null);
      if (model && callee && WRITE_METHODS.has(callee))
        record(current, model, callee, node.getStart(sf), node.arguments[0]);
      // a NESTED relation write through ANY model's write verb (`tx.customer.update({ data: { creditNotes: { create } } })`)
      if (callee && WRITE_METHODS.has(callee) && node.arguments[0])
        nestedWrites(node.arguments[0], model, current);
      // the credit note service's mint: its internal options must be readable here (see remainderSkips)
      if (
        callee === "create" &&
        /^credit_?notes?(service)?$/i.test(owner ?? "") &&
        node.arguments.length >= 2
      ) {
        if (!readableOptions(node.arguments[1])) current.opaqueMintOptions.push(node.getStart(sf));
      }
    }
    // a tagged template is a call too (`tx.$executeRaw\`UPDATE ...\``): its tag joins the call list at its position
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = propChain(node.tag).pop();
      if (tag) current.calls.push({ name: tag, pos: node.getStart(sf) });
    }
    // raw SQL, wherever its text sits: every string / template literal that names a write on the tables
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const sql = ts.isStringLiteralLike(node) ? node.text : node.getText(sf);
      rawWrite(current, sql, node.getStart(sf));
    }
    // destructured verbs: const { create } = tx.creditNote
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const last = propChain(node.initializer).pop();
      const model = (MODELS as string[]).includes(last ?? "")
        ? (last as Model)
        : aliases.get(last ?? "");
      if (model)
        for (const e of node.name.elements) {
          const verb = (e.propertyName ?? e.name).getText(sf);
          if (WRITE_METHODS.has(verb)) record(current, model, verb, node.getStart(sf), undefined);
        }
    }
    // the flag that skips the remainder: `{ ledgerReversedByReturn: x }`, a shorthand, `opts.ledgerReversedByReturn = x`,
    // `opts["ledgerReversedByReturn"] = x` (a literal `false` skips nothing)
    if (
      (ts.isPropertyAssignment(node) &&
        propName(node.name) === SKIP_FLAG &&
        node.initializer.kind !== ts.SyntaxKind.FalseKeyword) ||
      (ts.isShorthandPropertyAssignment(node) && node.name.text === SKIP_FLAG) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        propChain(node.left).pop() === SKIP_FLAG &&
        node.right.kind !== ts.SyntaxKind.FalseKeyword)
    )
      current.remainderSkips.push(node.getStart(sf));
    ts.forEachChild(node, (c) => visit(c, current));
  };
  const rawWrite = (f: FnFacts, text: string, pos: number): void => {
    if (RAW_WRITE.creditNote.test(text) || RAW_WRITE.creditNoteItem.test(text))
      record(f, "creditNote", "create", pos, undefined);
    if (RAW_WRITE.return.test(text)) record(f, "return", "update", pos, true);
  };
  visit(sf, fresh("<module>"));
  return out;
}

/** The flag a `creditNotes.create(dto, { ledgerReversedByReturn })` caller sets so the mint skips the remainder check. */
const SKIP_FLAG = "ledgerReversedByReturn";
/**
 * An options argument whose every property the scan can see: an object literal whose spreads are themselves object literals,
 * or a conditional of such (`...(x ? { a } : {})`); a variable, a call or a spread of one is opaque.
 */
const readableOptions = (e: ts.Expression): boolean => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isConditionalExpression(e))
    return readableOptions(e.whenTrue) && readableOptions(e.whenFalse);
  if (!ts.isObjectLiteralExpression(e)) return false;
  return e.properties.every((pr) => !ts.isSpreadAssignment(pr) || readableOptions(pr.expression));
};
/** A raw statement that writes one of the tables, with or without the schema qualifier or the identifier quotes. */
const rawStatement = (verbs: string, table: string): RegExp =>
  new RegExp(`(?:${verbs})\\s+(?:"?public"?\\.)?"?${table}"?(?![A-Za-z0-9_])`, "i");
const RAW_WRITE = {
  creditNote: rawStatement("INSERT\\s+INTO|UPDATE", "CreditNote"),
  creditNoteItem: rawStatement("INSERT\\s+INTO|UPDATE", "CreditNoteItem"),
  return: rawStatement("INSERT\\s+INTO|UPDATE", "Return"),
};

function factsOf(rel: string): Map<string, FnFacts> {
  const file = path.join(SRC, rel);
  return factsOfSource(fs.readFileSync(file, "utf8"), file);
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
    // SA-773 follow-up (D): the LATE Order lock (the chunk Orders only the pricing under the locks found) is taken before the
    // first invoice-row write, which is the headroom check's raw UPDATE of each source invoice, and before every write of
    // the capture itself. A lock statement after that write is how a credit note's Order-then-invoice order gets crossed.
    const locks = positions(capture, "lockRefundOrders");
    expect(locks).toHaveLength(2); // the first statement (carrying + preflight sources) and the late one
    const lateLock = Math.max(...locks);
    const headroom = firstPos(capture, "assertWithinLineHeadroom");
    expect(headroom).toBeGreaterThan(-1);
    expect(lateLock).toBeLessThan(headroom);
    for (const write of capture.calls.filter((c) =>
      ["create", "createMany", "update", "updateMany", "upsert", "$executeRaw"].includes(c.name),
    ))
      expect(lateLock).toBeLessThan(write.pos);
    // the headroom check is where the invoice write lives (so the order above is not vacuous): it still issues its raw UPDATE
    expect(
      positions(inlineSvc.get("assertWithinLineHeadroom")!, "$executeRaw").length,
    ).toBeGreaterThan(0);
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
    // approve(), storeCreditInstead() and issueCredit() (the replay re-issue) ask the remainder themselves, before they mint
    for (const fn of ["approve", "storeCreditInstead", "issueCredit"]) {
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
  });

  // ─── the inventory is closed ─────────────────────────────────────────────

  /** Every function in apps/api/src that writes a credit note row, by file::function. */
  const creditNoteWriters = (): string[] => {
    const out: string[] = [];
    for (const file of walkSources(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      for (const f of factsOf(rel).values())
        if (f.creditNoteWrites.length > 0) out.push(`${rel}::${f.name}`);
    }
    return out.sort();
  };
  const refundedWriters = (): string[] => {
    const out: string[] = [];
    for (const file of walkSources(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      for (const f of factsOf(rel).values())
        if (f.refundedWrites.length > 0) out.push(`${rel}::${f.name}`);
    }
    return out.sort();
  };

  /** Every function in apps/api/src with a fact list, by file::function. */
  const factHolders = (pick: (f: FnFacts) => number[]): string[] => {
    const out: string[] = [];
    for (const file of walkSources(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      for (const f of factsOf(rel).values()) if (pick(f).length > 0) out.push(`${rel}::${f.name}`);
    }
    return out.sort();
  };

  it("ONLY processRefund passes ledgerReversedByReturn (the flag that makes the mint skip the remainder), and every creditNotes.create call passes its options as a readable object literal", () => {
    // credit-notes.service.ts's create() takes the flag as a TYPE member and reads it; no other function sets it. Any new caller
    // that passes it skips the remainder check of its credit note: it must be a return's own refund mint, whose claim asked
    // the remainder first (pinned above), and that is decided here, not by whoever adds the call.
    expect(factHolders((f) => f.remainderSkips)).toEqual([
      "returns/returns.service.ts::processRefund",
    ]);
    // an options argument that is a variable or carries a spread could smuggle the flag past the scan above
    expect(factHolders((f) => f.opaqueMintOptions)).toEqual([]);
  });

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
        "returns/inline-returns.service.ts::captureInTx", // CREATES the return RECEIVED (held or not); never REFUNDED
        "returns/returns.service.ts::cancel", // the CAS to CANCELLED (a REFUNDED return cannot be cancelled)
        "returns/returns.service.ts::processRefund", // the compensation: REFUNDED back to RECEIVED when the mint failed
      ].sort(),
    );
  });
});

describe("SA-773 pin helper: each shape of write the inventory must see turns it red (in-memory fixtures)", () => {
  const facts = (body: string, header = ""): FnFacts =>
    factsOfSource(`${header}\nasync function writer(tx: any, internal: any) {\n${body}\n}`).get(
      "writer",
    )!;
  const writesCreditNote = (body: string) => facts(body).creditNoteWrites.length > 0;
  const writesRefunded = (body: string) => facts(body).refundedWrites.length > 0;

  it("the plain calls the pin always saw (control)", () => {
    expect(writesCreditNote(`await tx.creditNote.create({ data: {} });`)).toBe(true);
    expect(
      writesRefunded(`await tx.return.update({ where: {}, data: { status: "REFUNDED" } });`),
    ).toBe(true);
  });

  it("a cast does not hide the writer: (tx.creditNote as any).create, <any>tx.return, satisfies, and an as-cast alias", () => {
    expect(writesCreditNote(`await (tx.creditNote as any).create({ data: {} });`)).toBe(true);
    expect(writesCreditNote(`await (<any>tx.creditNote).createMany({ data: [] });`)).toBe(true);
    expect(writesCreditNote(`await ((tx.creditNote satisfies object) as any).create({});`)).toBe(
      true,
    );
    expect(writesCreditNote(`const m = tx.creditNote as any;\nawait m.create({ data: {} });`)).toBe(
      true,
    );
    expect(
      writesRefunded(
        `await (tx.return as any).update({ where: {}, data: { status: "REFUNDED" } });`,
      ),
    ).toBe(true);
    expect(writesCreditNote(`const { create } = tx.creditNote as any;\nawait create({});`)).toBe(
      true,
    );
  });

  it("a NESTED relation write is a writer: customer.update({ data: { creditNotes: { create } } }), an order's nested returns", () => {
    expect(
      writesCreditNote(
        `await tx.customer.update({ where: { id: "c" }, data: { creditNotes: { create: { amount: 5 } } } });`,
      ),
    ).toBe(true);
    expect(
      writesCreditNote(
        `await tx.invoice.update({ where: { id: "i" }, data: { creditNotes: { createMany: { data: [] } } } });`,
      ),
    ).toBe(true);
    expect(
      writesCreditNote(
        `await tx.invoicePayment.create({ data: { creditNote: { create: { amount: 5 } } } });`,
      ),
    ).toBe(true);
    expect(
      writesCreditNote(
        `await tx.creditNote.update({ where: { id: "n" }, data: { items: { create: [] } } });`,
      ),
    ).toBe(true);
    expect(
      writesRefunded(
        `await tx.order.update({ where: { id: "o" }, data: { returns: { update: { where: { id: "r" }, data: { status: "REFUNDED" } } } } });`,
      ),
    ).toBe(true);
    expect(
      writesRefunded(
        `await tx.customer.update({ where: { id: "c" }, data: { returns: { create: { orderId: "o" } } } });`,
      ),
    ).toBe(true);
  });

  it("raw SQL that writes the tables is a writer, however it is wrapped", () => {
    const sqlHeader = `import { Prisma } from "@prisma/client";`;
    const raw = (body: string) => facts(body, sqlHeader);
    expect(
      raw(`await tx.$executeRaw(Prisma.sql\`INSERT INTO "CreditNote" (id) VALUES (\${1})\`);`)
        .creditNoteWrites.length,
    ).toBeGreaterThan(0);
    expect(
      raw(`await tx.$executeRaw\`INSERT INTO "CreditNoteItem" (id) VALUES (\${1})\`;`)
        .creditNoteWrites.length,
    ).toBeGreaterThan(0);
    expect(
      raw(`await tx.$executeRawUnsafe('INSERT INTO "public"."CreditNote" (id) VALUES (1)');`)
        .creditNoteWrites.length,
    ).toBeGreaterThan(0);
    expect(
      raw(`const q = Prisma.raw("UPDATE CreditNote SET amount = 1");\nawait tx.$executeRaw(q);`)
        .creditNoteWrites.length,
    ).toBeGreaterThan(0);
    expect(
      raw(`await tx.$executeRaw(Prisma.sql\`UPDATE "Return" SET status = 'REFUNDED'\`);`)
        .refundedWrites.length,
    ).toBeGreaterThan(0);
    expect(
      raw(`await tx.$queryRaw\`UPDATE "Return" SET status = 'REFUNDED' RETURNING id\`;`)
        .refundedWrites.length,
    ).toBeGreaterThan(0);
  });

  it("reads and neighbours stay green: a find, a non-credit nested create, a SELECT, the ApplyBlock and ReturnItem tables", () => {
    const f = facts(`
      await tx.creditNote.findMany({ where: {} });
      await tx.return.findFirst({ where: {} });
      await tx.customer.update({ where: { id: "c" }, data: { notes: { create: { text: "x" } } } });
      await tx.invoice.update({ where: { id: "i" }, data: { creditNotes: { connect: { id: "n" } } } });
      await tx.$executeRaw\`SELECT id FROM "CreditNote" WHERE id = \${1} FOR UPDATE\`;
      await tx.$executeRaw\`INSERT INTO "CreditNoteApplyBlock" (id) VALUES (\${1})\`;
      await tx.$executeRaw\`UPDATE "ReturnItem" SET qty = 1\`;
    `);
    expect(f.creditNoteWrites).toEqual([]);
    expect(f.refundedWrites).toEqual([]);
    expect(f.returnWrites).toEqual([]);
  });

  it("the remainder-skip flag is seen in a literal, a shorthand, an assignment and a computed-string key; false skips nothing", () => {
    const skips = (body: string) => facts(body).remainderSkips.length;
    expect(skips(`await tx.creditNotes.create({}, { ledgerReversedByReturn: true });`)).toBe(1);
    expect(
      skips(
        `const ledgerReversedByReturn = true;\nawait svc.create({}, { ledgerReversedByReturn });`,
      ),
    ).toBe(1);
    expect(skips(`internal.ledgerReversedByReturn = true;`)).toBe(1);
    expect(skips(`internal["ledgerReversedByReturn"] = flag;`)).toBe(1);
    expect(skips(`await svc.create({}, { "ledgerReversedByReturn": cond });`)).toBe(1);
    expect(skips(`await svc.create({}, { ledgerReversedByReturn: false });`)).toBe(0);
    expect(skips(`await svc.create({}, { pooledRefund: [] });`)).toBe(0);
  });

  it("a creditNotes.create whose options are a variable or carry a spread is opaque", () => {
    const opaque = (body: string) => facts(body).opaqueMintOptions.length;
    expect(opaque(`await this.creditNotes.create(dto, opts);`)).toBe(1);
    expect(opaque(`await this.creditNotes.create(dto, { ...base, returnId });`)).toBe(1);
    expect(opaque(`await this.creditNotes.create(dto, { returnId });`)).toBe(0);
    expect(opaque(`await this.creditNotes.create(dto, { returnId, ...(p ? { p } : {}) });`)).toBe(
      0,
    );
    expect(opaque(`await this.creditNotes.create(dto, { returnId, ...(p ? other : {}) });`)).toBe(
      1,
    );
    expect(opaque(`await this.creditNotes.create(dto);`)).toBe(0);
  });
});

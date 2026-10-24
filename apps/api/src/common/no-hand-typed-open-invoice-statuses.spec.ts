/**
 * Row 326 — no web or mobile source file hand-types the OPEN invoice status set.
 *
 * "Open" (SENT, VIEWED, PARTIAL, OVERDUE: issued and not settled) has ONE home for web and mobile,
 * `OPEN_INVOICE_STATUS_VALUES` in `packages/types/api/enums.ts` (the API's twin is pinned set-equal by
 * invoices/open-invoice-statuses-pin.spec.ts). Eight client sites each typed their own copy of it
 * (`["SENT", "VIEWED", "PARTIAL", "OVERDUE"]`, or a `status === "SENT" || ...` chain), so a status added to
 * the open set would have been missed by every copy. This spec fails on a new copy.
 *
 * Mechanism (L-205: never a regex over the source text): the TypeScript compiler API parses every
 * production file under apps/web (app, components, lib, hooks) and apps/mobile (app, components, lib) and
 * collects, per file, every string-literal GROUP that reads as a set of statuses:
 *   - an array literal (so `new Set([...])`, `[...] as const` and `.includes` receivers are all seen),
 *   - an `||` chain of `x === "STATUS"` comparisons,
 *   - a run of `case "STATUS":` clauses that fall through to one body.
 * A group that holds at least THREE of the four open statuses is a copy (a superset of the open set, or
 * the open set less one) unless it is allow-listed below WITH a reason. The open set itself is read from
 * `enums.ts` with the same parser, never typed here a second time (L-072).
 *
 * Runs in the `test:repo-truth` lane (jest.repo-truth.config.js) and the API lane: it only reads files.
 */
import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const ENUMS_FILE = join(REPO_ROOT, "packages", "types", "api", "enums.ts");

/** Directories scanned (repo-relative). Test files, mocks and fixtures inside them are skipped. */
const SCAN_ROOTS = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/web/hooks",
  "apps/mobile/app",
  "apps/mobile/components",
  "apps/mobile/lib",
];

/** A group with at least this many of the open statuses is a copy of the open set. */
const MIN_OPEN_MEMBERS = 3;

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".expo",
  "dist",
  "e2e",
  "__tests__",
  "__mocks__",
]);
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;

/**
 * file -> the allow-listed groups in it. Each entry names the exact member set it excuses (sorted, comma
 * joined) and WHY that set is not "the open set". An entry that no longer matches a group fails: the list
 * may only shrink.
 */
const ALLOWED: Array<{ file: string; members: string; reason: string }> = [
  {
    file: "apps/web/app/(dashboard)/invoices/[id]/page.tsx",
    members: "OVERDUE,SENT,VIEWED",
    reason:
      "Revert to Draft is offered on SENT/VIEWED/OVERDUE with no payment rows; PARTIAL is excluded on purpose (it has a payment row by definition)",
  },
  {
    file: "apps/mobile/lib/invoices-logic.ts",
    members: "OVERDUE,SENT,VIEWED",
    reason: "canRevertToDraft mirrors web's Revert to Draft gate: PARTIAL is excluded on purpose",
  },
  {
    file: "apps/web/app/(dashboard)/finance/reports/page.tsx",
    members: ",DRAFT,OVERDUE,PAID,PARTIAL,SENT,VOID",
    reason:
      "the invoice report's status filter chips: a list of every status to FILTER by (with the empty All chip), not an openness test",
  },
];

/** The open set, read from the shared enums file (the single source), never re-typed. */
function readOpenSet(): string[] {
  const sf = ts.createSourceFile(
    ENUMS_FILE,
    readFileSync(ENUMS_FILE, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let found: string[] | null = null;
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "OPEN_INVOICE_STATUS_VALUES" &&
      n.initializer
    ) {
      let init: ts.Expression = n.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
      if (ts.isArrayLiteralExpression(init)) {
        found = init.elements.flatMap((e) => (ts.isStringLiteral(e) ? [e.text] : []));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found)
    throw new Error("OPEN_INVOICE_STATUS_VALUES not found in packages/types/api/enums.ts");
  return found;
}

interface OpenSetCopy {
  line: number;
  kind: "array" | "chain" | "case";
  /** Sorted, comma-joined string literals of the group (the allow-list key). */
  members: string;
}

/** Peel `as`/`satisfies`/parens so `"SENT" as InvoiceStatus` reads as the literal. */
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isParenthesizedExpression(x)) {
    x = x.expression;
  }
  return x;
}

function literalOf(e: ts.Expression): string | null {
  const x = unwrap(e);
  return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null;
}

const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken]);

/** The string literals compared with `===` across one `||` chain (its leaves). */
function chainLiterals(e: ts.Expression, out: Set<string>): void {
  const x = unwrap(e);
  if (!ts.isBinaryExpression(x)) return;
  if (x.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    chainLiterals(x.left, out);
    chainLiterals(x.right, out);
  } else if (EQUALITY.has(x.operatorToken.kind)) {
    const lit = literalOf(x.right) ?? literalOf(x.left);
    if (lit !== null) out.add(lit);
  }
}

/**
 * Every string-literal group in `sourceText` that holds at least `minOpen` of `openSet`. Exported shape is
 * pure (no file IO) so the red proofs below can feed it an in-memory fixture.
 */
function findOpenSetCopies(
  fileName: string,
  sourceText: string,
  openSet: readonly string[],
  minOpen = MIN_OPEN_MEMBERS,
): OpenSetCopy[] {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const open = new Set(openSet);
  const copies: OpenSetCopy[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const record = (n: ts.Node, k: OpenSetCopy["kind"], group: Iterable<string>) => {
    const members = [...new Set(group)].sort();
    if (members.filter((m) => open.has(m)).length >= minOpen) {
      copies.push({ line: lineOf(n), kind: k, members: members.join(",") });
    }
  };

  const visit = (n: ts.Node): void => {
    if (ts.isArrayLiteralExpression(n)) {
      record(
        n,
        "array",
        n.elements.flatMap((e) => {
          const l = literalOf(e);
          return l === null ? [] : [l];
        }),
      );
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
      // only the OUTERMOST `||` of a chain, so one chain is one group
      !(
        ts.isBinaryExpression(unwrapParent(n)) &&
        (unwrapParent(n) as ts.BinaryExpression).operatorToken.kind === ts.SyntaxKind.BarBarToken
      )
    ) {
      const lits = new Set<string>();
      chainLiterals(n, lits);
      record(n, "chain", lits);
    } else if (ts.isCaseBlock(n)) {
      let run: string[] = [];
      let first: ts.Node | null = null;
      for (const clause of n.clauses) {
        if (ts.isCaseClause(clause)) {
          const l = literalOf(clause.expression);
          if (l !== null) {
            run.push(l);
            first ??= clause;
          }
        }
        // a clause with a body (or `default`) closes the fall-through run
        if (clause.statements.length > 0 || ts.isDefaultClause(clause)) {
          if (first) record(first, "case", run);
          run = [];
          first = null;
        }
      }
      if (first) record(first, "case", run);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return copies;
}

/** The nearest non-parenthesis parent of `n`. */
function unwrapParent(n: ts.Node): ts.Node {
  let p = n.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  return p;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (/\.[cm]?[jt]sx?$/.test(e.name) && !SKIP_FILE.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const OPEN = readOpenSet();

describe("row 326 — no web/mobile file hand-types the open invoice status set", () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));
  const rel = (f: string) => relative(REPO_ROOT, f).split(sep).join("/");

  it("reads the open set from the shared enums file (the scan has something to compare against)", () => {
    expect([...OPEN].sort()).toEqual(["OVERDUE", "PARTIAL", "SENT", "VIEWED"]);
  });

  it("scans a real file set (zero candidates is an error, never a pass: L-202)", () => {
    expect(files.length).toBeGreaterThan(300);
    const names = new Set(files.map(rel));
    expect(names).toContain("apps/mobile/lib/invoices-logic.ts");
    expect(names).toContain("apps/web/lib/open-invoice-status.ts");
    expect(names).toContain("apps/web/app/(dashboard)/invoices/page.tsx");
  });

  it("every copy of the open set is allow-listed with a reason (and every allow-list row still holds)", () => {
    const unexcused: string[] = [];
    const used = new Set<number>();
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      // cheap prefilter: only parse a file that names at least three open statuses at all
      if (OPEN.filter((s) => text.includes(s)).length < MIN_OPEN_MEMBERS) continue;
      for (const c of findOpenSetCopies(f, text, OPEN)) {
        const idx = ALLOWED.findIndex((a) => a.file === rel(f) && a.members === c.members);
        if (idx >= 0) used.add(idx);
        else unexcused.push(`${rel(f)}:${c.line} ${c.kind} {${c.members}}`);
      }
    }
    // Use isOpenInvoiceStatus (apps/web/lib/open-invoice-status.ts, apps/mobile/lib/invoices-logic.ts) or
    // OPEN_INVOICE_STATUS_VALUES from @routeflow/types; list a group here only if it is NOT the open set.
    expect(unexcused).toEqual([]);
    const stale = ALLOWED.filter((_, i) => !used.has(i)).map((a) => `${a.file} {${a.members}}`);
    expect(stale).toEqual([]);
  });

  it("every allow-list row carries a reason", () => {
    for (const a of ALLOWED) expect(a.reason.trim().length).toBeGreaterThan(20);
  });
});

describe("row 326 — the detector goes RED on a re-introduced hand-typed list (in-memory fixtures)", () => {
  const find = (src: string, name = "fixture.tsx") => findOpenSetCopies(name, src, OPEN);

  it.each([
    ["an array const", `const A = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"];`],
    ["a reordered array", `const A = ["OVERDUE", "PARTIAL", "VIEWED", "SENT"];`],
    ["a typed array", `const A: InvoiceStatus[] = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"];`],
    ["an as-const array", `const A = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] as const;`],
    ["a Set", `const A = new Set(["SENT", "VIEWED", "PARTIAL", "OVERDUE"]);`],
    ["an inline includes", `if (["SENT", "VIEWED", "PARTIAL", "OVERDUE"].includes(s)) {}`],
    ["a superset array", `const A = ["DRAFT", "SENT", "VIEWED", "PARTIAL", "OVERDUE"];`],
    ["three of four", `const A = ["SENT", "VIEWED", "OVERDUE"];`],
    [
      "an || chain",
      `const ok = s === "SENT" || s === "VIEWED" || s === "PARTIAL" || s === "OVERDUE";`,
    ],
    [
      "a parenthesised || chain",
      `const ok = (status === "SENT" || status === "VIEWED") || (status === "PARTIAL" || status === "OVERDUE");`,
    ],
    [
      "a fall-through switch",
      `function f(s: string) { switch (s) { case "SENT": case "VIEWED": case "PARTIAL": case "OVERDUE": return 1; default: return 0; } }`,
    ],
  ])("flags %s", (_name, src) => {
    expect(find(src).length).toBeGreaterThanOrEqual(1);
  });

  it("reports one group per || chain, with its line and sorted members", () => {
    const hits = find(`\n\nconst ok = s === "VIEWED" || s === "SENT" || s === "OVERDUE";`);
    expect(hits).toEqual([{ line: 3, kind: "chain", members: "OVERDUE,SENT,VIEWED" }]);
  });

  it.each([
    ["the shared list", `const A = [...OPEN_INVOICE_STATUS_VALUES];`],
    ["the helper", `const ok = isOpenInvoiceStatus(inv.status);`],
    ["two of four (a PO status test)", `const ok = s === "SENT" || s === "PARTIAL";`],
    ["a PO status list", `const A = ["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED"];`],
    [
      "a status-to-label switch",
      `switch (s) { case "PAID": return 1; case "SENT": return 2; case "VIEWED": return 3; case "OVERDUE": return 4; }`,
    ],
    ["unrelated strings", `const A = ["a", "b", "c", "d"];`],
  ])("does not flag %s", (_name, src) => {
    expect(find(src)).toEqual([]);
  });
});

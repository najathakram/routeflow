/**
 * SA-1049 PR-2 (I-170, class L-072) — no source file hand-types a mirror of a Prisma enum.
 *
 * A hand-typed copy of an enum's values (an array, a union type, an object's keys, a TS `enum`, an `||` chain
 * of comparisons, a fall-through `case` run) goes stale the day the enum gains a value; three real bugs shipped
 * that way. The shared home is `packages/types/api/enums.ts` (`X_VALUES` + a derived type), pinned set-equal to
 * Prisma by enum-parity.spec.ts. This spec finds the copies that still exist and fails on a new one.
 *
 * Mechanism (L-205, modelled on no-hand-typed-open-invoice-statuses.spec.ts: the TypeScript compiler API, never a
 * regex over the source): read every enum from `@prisma/client` at run time (none is typed here), parse each
 * production file under the scan roots, collect its string-literal groups, and attribute a group G to the enum E
 * it mirrors: G holds >= 3 of E's values and those are at least half of G; the E with the highest Jaccard
 * |G∩E| / |G∪E| wins, a tie goes to the name that sorts first. Enums with fewer than 3 values are outside the pin.
 *
 * Exempt by construction: an object literal declared `Record<T, …>` (or `satisfies Record<T, …>`) with T imported
 * from `@routeflow/types` or `@prisma/client`, because the compiler already guards it. Nothing else is exempt.
 *
 * The allow-list (no-hand-typed-enum-mirrors.allow.ts) is exact both ways and may only shrink: B3-B8 lower the
 * `pending:` rows to zero by area.
 */
import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";
import * as PrismaClient from "@prisma/client";
import { ALLOWED, WHY } from "./no-hand-typed-enum-mirrors.allow";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const SCAN_ROOTS = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/web/hooks",
  "apps/mobile/app",
  "apps/mobile/components",
  "apps/mobile/lib",
  "apps/mobile/store",
  "apps/mobile/hooks",
  "apps/api/src",
  "packages/types",
];
/** The shared mirrors themselves, and the two files holding the other value tables, are the source, not copies. */
const SKIP_FILES = new Set([
  "packages/types/api/enums.ts",
  "packages/types/api/onboarding.ts",
  "packages/types/api/features.ts",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".expo",
  "dist",
  "e2e",
  "__tests__",
  "__mocks__",
  "__fixtures__",
  "fixtures",
]);
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const SHARED_MODULE = /^(@routeflow\/types(\/.*)?|@prisma\/client)$/;
const MIN_MEMBERS = 3;

type Kind = "array" | "union" | "object" | "enum" | "chain" | "case";
interface Group {
  line: number;
  kind: Kind;
  members: string[];
  /** a `Record<SharedType, …>` object literal: compiler-guarded */
  exempt: boolean;
}
export interface Mirror {
  line: number;
  kind: Kind;
  enumName: string;
  members: string[];
}

/** Every Prisma enum with at least MIN_MEMBERS values, read from the generated client, never typed here. */
function readEnums(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [name, values] of Object.entries(
    (PrismaClient as unknown as { $Enums: Record<string, Record<string, string>> }).$Enums,
  )) {
    const set = new Set(Object.values(values));
    if (set.size >= MIN_MEMBERS) out.set(name, set);
  }
  return out;
}
const ENUMS = readEnums();

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isParenthesizedExpression(x)) {
    x = x.expression;
  }
  return x;
}
const literalOf = (e: ts.Expression): string | null => {
  const x = unwrap(e);
  return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null;
};
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken]);

function chainLiterals(e: ts.Expression, out: string[]): void {
  const x = unwrap(e);
  if (!ts.isBinaryExpression(x)) return;
  if (x.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    chainLiterals(x.left, out);
    chainLiterals(x.right, out);
  } else if (EQUALITY.has(x.operatorToken.kind)) {
    const lit = literalOf(x.right) ?? literalOf(x.left);
    if (lit !== null) out.push(lit);
  }
}

/** `Record<T, …>` where T is a type name imported from a shared module. */
function isSharedRecord(t: ts.TypeNode | undefined, shared: Set<string>): boolean {
  if (!t || !ts.isTypeReferenceNode(t) || !ts.isIdentifier(t.typeName)) return false;
  if (t.typeName.text !== "Record" || !t.typeArguments?.length) return false;
  const k = t.typeArguments[0];
  return ts.isTypeReferenceNode(k) && ts.isIdentifier(k.typeName) && shared.has(k.typeName.text);
}

function sharedImports(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    if (!SHARED_MODULE.test(s.moduleSpecifier.text)) continue;
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamedImports(b)) b.elements.forEach((el) => names.add(el.name.text));
  }
  return names;
}

/** Every string-literal group of the six kinds in one source text. Pure (no file IO) so fixtures can feed it. */
export function findGroups(fileName: string, sourceText: string): Group[] {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const shared = sharedImports(sf);
  const groups: Group[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (n: ts.Node, k: Kind, members: string[], exempt = false) =>
    groups.push({ line: lineOf(n), kind: k, members: [...new Set(members)], exempt });
  const strings = (xs: readonly ts.Expression[]) =>
    xs.flatMap((e) => {
      const l = literalOf(e);
      return l === null ? [] : [l];
    });
  const parentOf = (n: ts.Node) => {
    let p = n.parent;
    while (p && ts.isParenthesizedExpression(p)) p = p.parent;
    return p;
  };

  const visit = (n: ts.Node): void => {
    if (ts.isArrayLiteralExpression(n)) {
      add(n, "array", strings(n.elements));
    } else if (ts.isUnionTypeNode(n) && !ts.isUnionTypeNode(n.parent)) {
      add(
        n,
        "union",
        n.types.flatMap((t) =>
          ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? [t.literal.text] : [],
        ),
      );
    } else if (ts.isObjectLiteralExpression(n)) {
      const p = parentOf(n);
      const declared =
        (ts.isVariableDeclaration(p) && isSharedRecord(p.type, shared)) ||
        (ts.isSatisfiesExpression(p) && isSharedRecord(p.type, shared));
      add(
        n,
        "object",
        n.properties.flatMap((pr) =>
          pr.name && (ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name))
            ? [pr.name.text]
            : [],
        ),
        declared,
      );
    } else if (ts.isEnumDeclaration(n)) {
      add(
        n,
        "enum",
        n.members.flatMap((m) =>
          m.initializer && ts.isStringLiteral(m.initializer) ? [m.initializer.text] : [],
        ),
      );
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
      // only the OUTERMOST `||` of a chain, so one chain is one group
      !(
        ts.isBinaryExpression(parentOf(n)) &&
        (parentOf(n) as ts.BinaryExpression).operatorToken.kind === ts.SyntaxKind.BarBarToken
      )
    ) {
      const lits: string[] = [];
      chainLiterals(n, lits);
      add(n, "chain", lits);
    } else if (ts.isCaseBlock(n)) {
      let run: string[] = [];
      let first: ts.Node | null = null;
      for (const c of n.clauses) {
        if (ts.isCaseClause(c)) {
          const l = literalOf(c.expression);
          if (l !== null) {
            run.push(l);
            first ??= c;
          }
        }
        // a clause with a body (or `default`) closes the fall-through run
        if (c.statements.length > 0 || ts.isDefaultClause(c)) {
          if (first) add(first, "case", run);
          run = [];
          first = null;
        }
      }
      if (first) add(first, "case", run);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return groups;
}

/** The enum a group mirrors, or null: >= 3 shared values making up at least half of the group. */
export function attribute(members: string[], enums = ENUMS): string | null {
  let best: { name: string; score: number } | null = null;
  const g = new Set(members);
  for (const [name, values] of enums) {
    let inter = 0;
    for (const m of g) if (values.has(m)) inter++;
    if (inter < MIN_MEMBERS || inter * 2 < g.size) continue;
    const score = inter / (g.size + values.size - inter);
    if (!best || score > best.score || (score === best.score && name < best.name)) {
      best = { name, score };
    }
  }
  return best?.name ?? null;
}

export function findMirrors(fileName: string, sourceText: string, enums = ENUMS): Mirror[] {
  return findGroups(fileName, sourceText).flatMap((g) => {
    const e = g.exempt ? null : attribute(g.members, enums);
    return e ? [{ line: g.line, kind: g.kind, enumName: e, members: g.members }] : [];
  });
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

/** Cheap prefilter: parse a file only if its quoted strings name >= 3 values of some enum. */
const valueIndex = new Map<string, string[]>();
for (const [name, values] of ENUMS) {
  for (const v of values) valueIndex.set(v, [...(valueIndex.get(v) ?? []), name]);
}
function mayMirror(text: string): boolean {
  const hits = new Map<string, Set<string>>();
  for (const m of text.matchAll(/["'`]([^"'`\n]{1,64})["'`]/g)) {
    for (const name of valueIndex.get(m[1]) ?? []) {
      const s = hits.get(name) ?? hits.set(name, new Set()).get(name)!;
      s.add(m[1]);
      if (s.size >= MIN_MEMBERS) return true;
    }
  }
  return false;
}

describe("SA-1049 PR-2 — the detector (G-1, in-memory fixtures)", () => {
  // a real enum, read at run time: the fixtures are built from its own values
  const [ENUM_NAME, VALUES] = [...ENUMS.entries()].find(([, v]) => v.size >= 4)!;
  const v = [...VALUES].slice(0, 4);
  const lits = v.map((x) => `"${x}"`);
  const find = (src: string, name = "fixture.ts") => findMirrors(name, src);

  it("flags one group of each of the six kinds over a real enum, once each", () => {
    const src = [
      `const A = [${lits.join(", ")}];`,
      `type U = ${lits.join(" | ")};`,
      `const O = { ${v.map((x) => `${x}: 1`).join(", ")} };`,
      `enum E { ${v.map((x, i) => `K${i} = "${x}"`).join(", ")} }`,
      `const ok = ${lits.map((l) => `s === ${l}`).join(" || ")};`,
      `function f(s: string) { switch (s) { ${lits.map((l) => `case ${l}:`).join(" ")} return 1; default: return 0; } }`,
    ].join("\n");
    const hits = find(src);
    expect(hits.map((h) => h.kind).sort()).toEqual(
      ["array", "case", "chain", "enum", "object", "union"].sort(),
    );
    expect(new Set(hits.map((h) => h.enumName)).size).toBe(1);
    expect(hits[0].enumName).toBe(attribute(v));
  });

  it("does not flag a Record keyed by a shared type, but does flag one keyed by literals", () => {
    const body = `{ ${v.map((x) => `${x}: 1`).join(", ")} }`;
    const shared = `import type { ${ENUM_NAME} } from "@prisma/client";\nconst R: Record<${ENUM_NAME}, number> = ${body};`;
    const satisfied = `import type { ${ENUM_NAME} } from "@routeflow/types";\nconst R = ${body} satisfies Record<${ENUM_NAME}, number>;`;
    const local = `type ${ENUM_NAME} = string;\nconst R: Record<${ENUM_NAME}, number> = ${body};`;
    const literal = `const R: Record<${lits.join(" | ")}, number> = ${body};`;
    expect(find(shared)).toEqual([]);
    expect(find(satisfied)).toEqual([]);
    expect(find(local).filter((h) => h.kind === "object")).toHaveLength(1);
    expect(find(literal).filter((h) => h.kind === "object")).toHaveLength(1);
  });

  it("applies the 3-value and half-of-the-group thresholds, and breaks ties by name", () => {
    expect(find(`const A = [${lits.slice(0, 2).join(", ")}];`)).toEqual([]);
    expect(find(`const A = [${lits.slice(0, 3).join(", ")}, "x1", "x2", "x3", "x4"];`)).toEqual([]);
    const tie = new Map([
      ["Zeta", new Set(["P", "Q", "R"])],
      ["Alpha", new Set(["P", "Q", "R"])],
    ]);
    expect(attribute(["P", "Q", "R"], tie)).toBe("Alpha");
  });

  it("reads all enums at run time and the scan has something to find (zero is an error: L-202)", () => {
    expect(ENUMS.size).toBeGreaterThan(80);
    expect(valueIndex.size).toBeGreaterThan(200);
  });
});

describe("SA-1049 PR-2 — no source file hand-types a Prisma enum (G-2)", () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r))).filter(
    (f) => !SKIP_FILES.has(relative(REPO_ROOT, f).split(sep).join("/")),
  );
  const rel = (f: string) => relative(REPO_ROOT, f).split(sep).join("/");
  const found = new Map<string, number>();
  let total = 0;
  const started = Date.now();
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (!mayMirror(text)) continue;
    for (const m of findMirrors(f, text)) {
      const key = `${rel(f)}\t${m.enumName}`;
      found.set(key, (found.get(key) ?? 0) + 1);
      total++;
    }
  }

  it("scans a real file set and finds matches (zero files or zero matches is an error: L-202)", () => {
    expect(files.length).toBeGreaterThan(1500);
    expect(total).toBeGreaterThan(0);
    // observe and report: the pin's own definition of a match, and what it cost
    console.info(
      `enum-mirror pin: ${files.length} files, ${total} matches in ${found.size} (file, enum) pairs, ` +
        `${Date.now() - started} ms to scan`,
    );
  });

  it("every match has an allow-list row with the same count, and every row still holds", () => {
    const rows = new Map(ALLOWED.map((a) => [`${a.file}\t${a.enum}`, a]));
    expect(rows.size).toBe(ALLOWED.length); // no duplicate (file, enum) row
    const unlisted = [...found].filter(([k]) => !rows.has(k)).map(([k, n]) => `${k} x${n}`);
    // Import the shared X_VALUES / its derived type from @routeflow/types (or `Record<X, …>`), or add a row with
    // WHY and a note saying what the group selects. `pending:` rows exist only until their batch lands.
    expect(unlisted.map((s) => s.replace("\t", " mirrors "))).toEqual([]);
    const wrong = ALLOWED.filter((a) => found.get(`${a.file}\t${a.enum}`) !== a.count).map(
      (a) =>
        `${a.file} ${a.enum}: row says ${a.count}, found ${found.get(`${a.file}\t${a.enum}`) ?? 0}`,
    );
    expect(wrong).toEqual([]);
  });

  it("every row names a valid why and says what it selects", () => {
    for (const a of ALLOWED) {
      expect(WHY).toContain(a.why);
      expect(a.note.trim().length).toBeGreaterThan(10);
      expect(a.count).toBeGreaterThan(0);
    }
  });
});

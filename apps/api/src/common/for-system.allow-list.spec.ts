/**
 * SA-1105 Q3 + A-1, K-4: `prisma.forSystem(reason, fn)` is the ONE deliberate unscoped door (callback shape only; the
 * scanner matches the two-argument form, and a bracket access `["forSystem"](` is not seen). Every call site is listed here with
 * its literal reason, and the list must equal what the source holds (set-equal, both ways). A new call fails until it is
 * added HERE, which is where a reviewer reads it. Money paths stay out in slice 1 (SA-619a: billing-cron, billing.service,
 * onboarding-lifecycle, tenant-mirror and the feature-override jobs convert in PR-2, under the owner's review).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC = path.join(__dirname, "..");
const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
          ? [path.join(dir, e.name)]
          : [],
    );

/** One row per call site: the file (relative to src) and the literal reason. */
export const ALLOWED: ReadonlyArray<{ file: string; reason: string }> = [
  { file: "inventory/low-stock-digest.service.ts", reason: "low-stock digest: cross-tenant scan" },
];

export interface Found {
  file: string;
  reason: string | null; // null = not a string literal
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every `.forSystem(` call, read as `forSystem("<literal>", fn)` (the declaration has no leading dot). */
export function scanForSystem(files: Array<{ file: string; text: string }>): Found[] {
  const out: Found[] = [];
  for (const { file, text } of files) {
    for (const m of strip(text).matchAll(/\.forSystem\(\s*(?:(["'`])([^"'`]*)\1\s*,)?/g)) {
      out.push({ file, reason: m[1] && !m[2].includes("${") ? m[2] : null });
    }
  }
  return out;
}

const key = (f: Found) => `${f.file} :: ${f.reason}`;

describe("K-4 forSystem allow-list", () => {
  it("the call sites in the source are set-equal to the allow-list, each with a literal reason of 12+ characters", () => {
    const files = walk(SRC).map((f) => ({
      file: path.relative(SRC, f).split(path.sep).join("/"),
      text: fs.readFileSync(f, "utf8"),
    }));
    const found = scanForSystem(files);
    expect(found.map(key).sort()).toEqual(ALLOWED.map(key).sort());
    for (const f of found) expect((f.reason ?? "").length).toBeGreaterThanOrEqual(12);
  });

  it("self-test: an unlisted call is reported", () => {
    const found = scanForSystem([
      {
        file: "x/new-job.ts",
        text: 'await this.prisma.forSystem("a brand new unlisted sweep", async (db) => db.order.findMany());',
      },
    ]);
    expect(found).toEqual([{ file: "x/new-job.ts", reason: "a brand new unlisted sweep" }]);
    const unlisted = found.map(key).filter((k) => !ALLOWED.map(key).includes(k));
    expect(unlisted).toHaveLength(1);
  });

  it("self-test: a non-literal reason is reported as null, and a template with interpolation too", () => {
    const found = scanForSystem([
      { file: "x/a.ts", text: "this.prisma.forSystem(reason, async (db) => db.user.findMany());" },
      {
        file: "x/b.ts",
        text: "this.prisma.forSystem(`sweep ${name}`, async (db) => db.user.findMany());",
      },
      { file: "x/c.ts", text: 'this.prisma.forSystem("a client-returning one-argument form");' },
    ]);
    expect(found.map((f) => f.reason)).toEqual([null, null, null]);
  });

  it("self-test: the declaration and a comment are not call sites", () => {
    const found = scanForSystem([
      {
        file: "prisma/prisma.service.ts",
        text: '  forSystem<T>(reason: string, fn: (db: this) => Promise<T>) {\n  // x.forSystem("nope nope nope", fn)\n  }',
      },
    ]);
    expect(found).toEqual([]);
  });
});

/**
 * B1284 (SA-1105 A-2): `forSystem` is the ONLY door to the tenant-context kind SYSTEM. Construction: `run()` cannot name
 * SYSTEM (B4-1, a type error in prisma-tenant-context-kind.spec). Pin, for what a type cannot see (a cast, an element
 * access): every use of the name `runSystem` in non-spec source is `PrismaService.forSystem`, and no `.run(` call passes
 * the string literal "SYSTEM".
 */
export interface SystemDoorScan {
  /** `file::Class.method` of every use of the name `runSystem` that is not its definition. */
  runSystemUses: string[];
  /** `file` of every `.run(` call that passes the string literal "SYSTEM". */
  runWithSystem: string[];
}

/** `Class.method` (or `<top>`) enclosing a node. */
function enclosing(n: ts.Node): string {
  let cls = "";
  let fn = "";
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (!fn && (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name) {
      fn = p.name.getText();
    }
    if (ts.isClassDeclaration(p) && p.name) {
      cls = p.name.text;
      break;
    }
  }
  return cls || fn ? `${cls}.${fn}` : "<top>";
}

export function scanSystemDoor(files: Array<{ file: string; text: string }>): SystemDoorScan {
  const out: SystemDoorScan = { runSystemUses: [], runWithSystem: [] };
  for (const { file, text } of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      const isName =
        (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
        n.text === "runSystem";
      const isDefinition = isName && ts.isMethodDeclaration(n.parent) && n.parent.name === n;
      if (isName && !isDefinition) out.runSystemUses.push(`${file}::${enclosing(n)}`);
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "run" &&
        n.arguments.some((a) => ts.isStringLiteralLike(a) && a.text === "SYSTEM")
      ) {
        out.runWithSystem.push(file);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  out.runSystemUses.sort();
  out.runWithSystem.sort();
  return out;
}

const DOOR = ["prisma/prisma.service.ts::PrismaService.forSystem"];

describe("B4-2 the SYSTEM kind has one door", () => {
  it("runSystem is used only by PrismaService.forSystem, and no .run( call names SYSTEM", () => {
    const files = walk(SRC).map((f) => ({
      file: path.relative(SRC, f).split(path.sep).join("/"),
      text: fs.readFileSync(f, "utf8"),
    }));
    const found = scanSystemDoor(files);
    expect(found.runSystemUses).toEqual(DOOR);
    expect(found.runWithSystem).toEqual([]);
  });

  it("self-test: a second producer, in any spelling, is reported", () => {
    const found = scanSystemDoor([
      {
        file: "x/second-door.ts",
        text: [
          "class Job {",
          "  a() { return this.ctx.runSystem('sneaky reason here', () => 1); }",
          "  b() { return (this.ctx as any)['runSystem']('sneaky reason here', () => 1); }",
          "  c() { return this.ctx.run(null, () => 1, 'SYSTEM'); }",
          "}",
        ].join("\n"),
      },
      {
        file: "tenant/tenant-context.service.ts",
        text: "class TenantContextService { runSystem<T>(reason: string, fn: () => T): T { return fn(); } }",
      },
    ]);
    expect(found.runSystemUses).toEqual(["x/second-door.ts::Job.a", "x/second-door.ts::Job.b"]);
    expect(found.runWithSystem).toEqual(["x/second-door.ts"]);
  });
});

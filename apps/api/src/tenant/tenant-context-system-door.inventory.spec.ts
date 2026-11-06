/**
 * B1284 (SA-1105 A-1 G4: "one door, one shape, with the kind set by the door"). The tenant-context kind SYSTEM silences
 * the dark tenant guard for a whole body, so it must have exactly one producer: `prisma.forSystem(reason, fn)`, which
 * holds the literal reason and the allow-list row (`common/for-system.allow-list.spec`). The door is
 * `TenantContextService.runSystem`; `run()`'s tenantless parameter cannot name SYSTEM (D-1, a compile row).
 *
 * This spec is the second layer, for what a type cannot see (a cast, an `as any`, an element access):
 *   - every use of the name `runSystem` in non-spec source (identifier or string literal) sits in `forSystem`, or is the
 *     definition itself;
 *   - no `.run(` call anywhere carries the string literal "SYSTEM" as an argument.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { TenantContextService } from "./tenant-context.service";

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

describe("B1284 forSystem is the only door to the SYSTEM tenant-context kind", () => {
  const files = walk(SRC).map((f) => ({
    file: path.relative(SRC, f).split(path.sep).join("/"),
    text: fs.readFileSync(f, "utf8"),
  }));

  it("D-4: `runSystem` is used only by PrismaService.forSystem, and no `.run(` call names SYSTEM", () => {
    const found = scanSystemDoor(files);
    expect(found.runSystemUses).toEqual(DOOR);
    expect(found.runWithSystem).toEqual([]);
  });

  it("D-5 self-test: a second producer, in any spelling, is reported", () => {
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

  it("D-1: run() cannot name SYSTEM (compile row)", () => {
    const ctx = new TenantContextService();
    // @ts-expect-error SYSTEM is produced only by runSystem
    ctx.run(null, () => 1, "SYSTEM");
  });

  it("D-2: runSystem sets SYSTEM with a null tenant, and restores the outer kind after return and after a throw", () => {
    const ctx = new TenantContextService();
    expect(ctx.kind()).toBe("NONE");
    const inside = ctx.runSystem("a long enough reason", () => [ctx.kind(), ctx.getOrNull()]);
    expect(inside).toEqual(["SYSTEM", null]);
    expect(ctx.kind()).toBe("NONE");
    expect(() =>
      ctx.runSystem("a long enough reason", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(ctx.kind()).toBe("NONE");
    expect(ctx.run(null, () => ctx.kind(), "SUPER_ADMIN")).toBe("SUPER_ADMIN");
  });
});

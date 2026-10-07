import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * B1224 guard. The api targets ES2023 (class-field define semantics), so a DTO property declared
 * WITHOUT any decorator and WITHOUT `declare` is emitted as an own `undefined` property on every
 * class-transformer instance; the global ValidationPipe (whitelist + forbidNonWhitelisted) then
 * rejects it as "property X should not exist". Type-only fields must be `declare x?: T;`.
 *
 * Scope: every `*.dto.ts` under apps/api/src. Only classes that have at least one decorated
 * property are inspected (a class with none is a plain response/shape class, not a validated
 * request DTO). Static members and accessors are ignored; inherited members are checked in the
 * class that declares them (each file is scanned, so a base DTO is covered where it lives).
 */
const SRC_ROOT = path.resolve(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(p, out);
    } else if (e.name.endsWith(".dto.ts")) out.push(p);
  }
  return out;
}

export function findUndecoratedDtoProperties(source: string, file = "x.dto.ts"): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node)) {
      const props = node.members.filter(ts.isPropertyDeclaration);
      const decoOf = (p: ts.PropertyDeclaration) => ts.getDecorators(p) ?? [];
      if (props.some((p) => decoOf(p).length > 0)) {
        for (const p of props) {
          const mods = ts.getModifiers(p) ?? [];
          const isStatic = mods.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
          const isDeclare = mods.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
          if (isStatic || isDeclare || decoOf(p).length > 0) continue;
          found.push(`${file}: ${node.name?.text ?? "<anon>"}.${p.name.getText(sf)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("DTO properties must be decorated or `declare`d (B1224)", () => {
  it("detector flags an undecorated field and spares declare/decorated/multi-line decorated ones", () => {
    const src = `
      class A {
        @IsString() a: string;
        @IsOptional()
        @Matches(/x/, {
          message: "m",
        })
        b?: string;
        declare c?: string;
        d?: string;
        static e = 1;
      }
      class Plain { z?: string; }
    `;
    expect(findUndecoratedDtoProperties(src)).toEqual(["x.dto.ts: A.d"]);
  });

  it("no *.dto.ts under apps/api/src declares an undecorated, non-declare property", () => {
    const offenders = walk(SRC_ROOT).flatMap((f) =>
      findUndecoratedDtoProperties(fs.readFileSync(f, "utf8"), path.relative(SRC_ROOT, f)),
    );
    expect(offenders).toEqual([]);
  });
});

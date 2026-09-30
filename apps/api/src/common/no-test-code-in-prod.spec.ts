/**
 * Static guard: no production source file imports test-only code.
 *
 * `apps/api/src/**\/testing/` holds test harnesses and fakes. They call `jest.mock` / `jest.fn` at
 * module top level, so a production module that imports one throws a ReferenceError at boot
 * outside Jest. Keeping a directory out of the build (`tsconfig.build.json` `exclude`) does NOT
 * stop that: tsc emits every file that is imported, whatever `exclude` says. The rule is therefore
 * enforced on the import edge — a non-spec file outside a `testing/` directory must not import
 * (static, re-export, dynamic `import()` or `require`) a RELATIVE specifier with a `testing`
 * path segment. A type-only import is erased at compile time and is allowed.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC_ROOT = path.resolve(__dirname, "..");
const TESTING_SEGMENT = /(^|\/)testing(\/|$)/;

function walk(dir: string, files: string[] = [], testingDirs: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      if (entry.name === "testing")
        testingDirs.push(full); // its own files may import each other
      else walk(full, files, testingDirs);
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) files.push(full);
  }
  return { files, testingDirs };
}

/** Every relative specifier naming a `testing` path segment in one source text. */
export function testingImports(text: string): string[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const check = (spec: string) => {
    if (spec.startsWith(".") && TESTING_SEGMENT.test(spec)) found.push(spec);
  };
  const visit = (n: ts.Node) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      !(ts.isImportDeclaration(n) && n.importClause?.isTypeOnly) &&
      !(ts.isExportDeclaration(n) && n.isTypeOnly)
    )
      check(n.moduleSpecifier.text);
    if (
      ts.isCallExpression(n) &&
      n.arguments.length > 0 &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      const callee = n.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      )
        check(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("production code never imports test-only code", () => {
  const { files, testingDirs } = walk(SRC_ROOT);

  it("walks a non-trivial tree and still finds the testing directories it excludes (an empty or renamed scan must not report green)", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(testingDirs.length).toBeGreaterThanOrEqual(2);
  });

  it("no non-spec file outside a testing/ directory imports one", () => {
    const violations = files.flatMap((f) =>
      testingImports(fs.readFileSync(f, "utf8")).map(
        (spec) => `${path.relative(SRC_ROOT, f)} imports ${spec}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  describe("the detector itself can fail", () => {
    it.each([
      ["a static import", `import { h } from "../testing/prisma-mock";`],
      ["a side-effect import", `import "./testing/setup";`],
      ["a value re-export", `export { h } from "../common/testing/db-spec";`],
      ["a dynamic import()", `const m = await import("../testing/prisma-mock");`],
      ["a require()", `const m = require("../testing/prisma-mock");`],
    ])("flags %s", (_label, text) => {
      expect(testingImports(text)).toHaveLength(1);
    });

    it.each([
      ["a type-only import (erased at compile time)", `import type { H } from "../testing/h";`],
      ["a type-only re-export", `export type { H } from "../testing/h";`],
      ["a package that happens to be called testing", `import { Test } from "@nestjs/testing";`],
      ["a path that merely contains the word", `import { x } from "./testing-utils";`],
      ["an ordinary relative import", `import { x } from "../common/db-locks";`],
    ])("accepts %s", (_label, text) => {
      expect(testingImports(text)).toEqual([]);
    });
  });
});

/**
 * SA-763r P-1a, the dispatch pin: the readers that gather orders for a route or a trip exclude PICKUP
 * (a counter sale or a POS-mode order is handed over at the till and never rides a run) through ONE module,
 * `orders/dispatch-path-where.ts` (`DISPATCH_PATH_WHERE`). This walks the dispatch reader folders so a NEW
 * hand-written PICKUP path literal there fails here instead of drifting from the other readers (L-167).
 *
 * Scope: the folders that decide what a route or trip loads. The module itself lives in `orders/`, outside
 * them. Specs and comments are excluded (specs carry the literal as data).
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const DISPATCH_READER_DIRS = ["routes", "trips", "route-optimization", "drivers", "route-hits"];

/** A PICKUP fulfil-path literal: the enum member, or the quoted string. */
const PICKUP_PATH_LITERAL = /FulfillPath\.PICKUP\b|["'`]PICKUP["'`]/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("dispatch readers: no PICKUP path literal outside DISPATCH_PATH_WHERE", () => {
  it("the matcher sees the enum member and the quoted string, and ignores comments and look-alikes", () => {
    expect(PICKUP_PATH_LITERAL.test("fulfillPath: { not: FulfillPath.PICKUP }")).toBe(true);
    expect(PICKUP_PATH_LITERAL.test('order.fulfillPath === "PICKUP"')).toBe(true);
    expect(PICKUP_PATH_LITERAL.test("reason: PICKUP_FULFILLMENT")).toBe(false);
    expect(PICKUP_PATH_LITERAL.test(stripComments("// FulfillPath.PICKUP in a comment"))).toBe(
      false,
    );
    expect(PICKUP_PATH_LITERAL.test(stripComments("/* FulfillPath.PICKUP */ const a = 1;"))).toBe(
      false,
    );
  });

  it("the dispatch reader folders exist and hold source files (the scan cannot pass by scanning nothing)", () => {
    for (const dir of DISPATCH_READER_DIRS) {
      expect(sourceFiles(path.join(SRC_ROOT, dir)).length).toBeGreaterThan(0);
    }
  });

  it("no source file in them writes a PICKUP path literal", () => {
    const offenders: string[] = [];
    for (const dir of DISPATCH_READER_DIRS) {
      for (const file of sourceFiles(path.join(SRC_ROOT, dir))) {
        if (PICKUP_PATH_LITERAL.test(stripComments(fs.readFileSync(file, "utf8")))) {
          offenders.push(path.relative(SRC_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** @jest-environment node */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * SA-1414 / B1444 (census pin): the shared Modal scrolls by default. Every `<Modal scroll={false}>`
 * in a web source file is listed here with its reason and
 * its exact count, and carries `// B1444: <REASON>` on the same line.
 *
 * Shrink-only. A new opt-out fails until it is added with a reason; a site that left the list
 * (its picker moved to AnchoredList, or it dropped its own height cap) fails until its row goes,
 * because the count must match exactly.
 *   CLIP       an inline `absolute ... top-full` list in the body: a scroll body would clip it.
 *   OWN-SCROLL the body already caps its own height: a default would nest two scroll boxes.
 *   LAYOUT     the dialog is a full-height or bottom-sheet layout built with class overrides.
 */

/** "file (from apps/web, forward slashes)|REASON" -> how many opt-outs it holds */
const ALLOW: Record<string, number> = {
  "app/(dashboard)/credit-notes/page.tsx|CLIP": 1,
  "app/(dashboard)/customers/[id]/StandingOrderModal.tsx|CLIP": 1,
  "app/(dashboard)/customers/[id]/page.tsx|CLIP": 2,
  "app/(dashboard)/customers/[id]/page.tsx|LAYOUT": 1,
  "app/(dashboard)/customers/_components/CustomerFormModal.tsx|CLIP": 1,
  "app/(dashboard)/estimates/EstimateFormModal.tsx|CLIP": 1,
  "app/(dashboard)/orders/_components/CounterDatePicker.tsx|LAYOUT": 1,
  "app/(dashboard)/orders/_components/CreateOrderModal.tsx|CLIP": 1,
  "app/(dashboard)/promotions/page.tsx|OWN-SCROLL": 1,
  "app/(dashboard)/routes/[id]/page.tsx|CLIP": 1,
  "app/(dashboard)/settings/restrictions/rules/[id]/_components/AddTargetsDialog.tsx|CLIP": 1,
  "app/(dashboard)/settings/restrictions/rules/_components/EditRuleDialog.tsx|OWN-SCROLL": 1,
  "app/(dashboard)/settings/restrictions/rules/_components/RuleFormDialog.tsx|CLIP": 1,
  "app/(dashboard)/vendor-bills/page.tsx|CLIP": 1,
};
const ALLOWED_TOTAL = 15;

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".jest-cache",
  "coverage",
  "e2e",
  "test-utils",
]);
const isSource = (f: string) =>
  /\.tsx$/.test(f) && !/\.(test|spec)\.tsx$/.test(f) && !f.endsWith(".d.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && e.name !== "__tests__") {
        walk(path.join(dir, e.name), out);
      }
    } else if (isSource(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

type OptOut = { line: number; reason: string | null };

/** Every `<Modal scroll={false}>` attribute in one source text (a router `{ scroll: false }` is not one). */
function scrollOptOutsIn(fileName: string, text: string): OptOut[] {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split("\n");
  const found: OptOut[] = [];
  const record = (node: ts.Node) => {
    const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line;
    const m = /\/\/\s*B1444:\s*(CLIP|OWN-SCROLL|LAYOUT)\b/.exec(lines[line] ?? "");
    found.push({ line: line + 1, reason: m ? m[1] : null });
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(src) === "scroll" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword &&
      ts.isJsxAttributes(node.parent) &&
      node.parent.parent.tagName.getText(src) === "Modal"
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

describe("Modal scroll opt-out census (B1444, SA-1414)", () => {
  const files = walk(ROOT);
  const counts: Record<string, number> = {};
  const unreasoned: string[] = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join("/");
    for (const o of scrollOptOutsIn(f, readFileSync(f, "utf8"))) {
      if (!o.reason) unreasoned.push(`${rel}:${o.line}`);
      else counts[`${rel}|${o.reason}`] = (counts[`${rel}|${o.reason}`] ?? 0) + 1;
    }
  }

  it("scans at least one source file (L-377)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("every scroll={false} carries a B1444 reason on its own line", () => {
    expect(unreasoned).toEqual([]);
  });

  it("the opt-outs are exactly the pinned list, with exact counts", () => {
    expect(counts).toEqual(ALLOW);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(ALLOWED_TOTAL);
  });

  it("the scanner sees a Modal opt-out, not scroll, scroll={true}, a Link or a router option (L-377 probe)", () => {
    const probe = [
      "const a = <Modal scroll={false} // B1444: CLIP",
      "/>;",
      "const b = router.replace(url, { scroll: false });",
      "const c = <Modal scroll />;",
      "const d = <Modal scroll={true} />;",
      "const e = <Link scroll={false} />;",
      "const f = <Modal scroll={false} />;",
    ].join("\n");
    const hits = scrollOptOutsIn("probe.tsx", probe);
    expect(hits.map((h) => h.line)).toEqual([1, 7]);
    expect(hits.map((h) => h.reason)).toEqual(["CLIP", null]);
  });
});

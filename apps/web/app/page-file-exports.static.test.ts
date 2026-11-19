/**
 * @jest-environment node
 */
// W-1235: a Next page or layout file may export only the page fields Next knows. Next writes a type
// guard per page under .next/types, and tsconfig includes it, so any other value export fails tsc
// with TS2344 once a local .next exists. CI type-checks without a .next and never sees it. This was
// hit three times (orders/[id], estimates, admin/tenants/[id]). Move helpers to a sibling module.
// Type-only exports are erased and pass Next's guard, so they are allowed here.
import * as fs from "fs";
import * as path from "path";

const APP = __dirname;

// The field list in Next 15.5's next-types-plugin guard template (page and layout).
const PAGE_FIELDS = new Set([
  "default",
  "config",
  "generateStaticParams",
  "revalidate",
  "dynamic",
  "dynamicParams",
  "fetchCache",
  "preferredRegion",
  "runtime",
  "maxDuration",
  "metadata",
  "generateMetadata",
  "viewport",
  "generateViewport",
  "experimental_ppr",
]);

const ENTRY = /^(page|layout)\.(tsx|ts|jsx|js)$/;

function entryFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : entryFiles(p);
    return ENTRY.test(e.name) ? [p] : [];
  });
}

/** Value exports of a module source that Next would reject in a page or layout file */
export function strayExports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^export\s+(.*)$/gm)) {
    const rest = m[1];
    if (/^(default\b|type\b|interface\b|declare\s+(type|interface)\b)/.test(rest)) continue;
    const decl =
      /^(?:async\s+)?(?:function\*?|const|let|var|class|enum|abstract\s+class)\s+(\w+)/.exec(rest);
    if (decl) {
      if (!PAGE_FIELDS.has(decl[1])) out.push(decl[1]);
      continue;
    }
    if (rest.startsWith("{")) {
      const close = src.indexOf("}", m.index);
      const list = src.slice(src.indexOf("{", m.index) + 1, close);
      for (const spec of list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (/^type\s/.test(spec)) continue;
        const name = spec
          .split(/\s+as\s+/)
          .pop()!
          .trim();
        if (!PAGE_FIELDS.has(name)) out.push(name);
      }
      continue;
    }
    out.push(`export ${rest.slice(0, 40)}`); // export * and any other form
  }
  return out;
}

describe("page and layout files export only Next page fields (W-1235)", () => {
  const files = entryFiles(APP);

  it("the scan finds the app's page and layout files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no page or layout file has a value export Next would reject", () => {
    const bad = files.flatMap((f) =>
      strayExports(fs.readFileSync(f, "utf8")).map((n) => `${path.relative(APP, f)}: ${n}`),
    );
    expect(bad).toEqual([]);
  });

  it("the detector flags helpers and passes page fields and types", () => {
    const src = [
      "export const dynamic = 'force-dynamic';",
      "export const metadata = {};",
      "export async function generateMetadata() {}",
      "export type Row = { id: string };",
      "export interface Handle { open(): void }",
      "export default function Page() {}",
      "export function defaultExpiryDate() {}",
      "export const FeatureOverridesSection = 1;",
      "export { helper, type T, x as revalidate };",
      "export * from './other';",
    ].join("\n");
    expect(strayExports(src)).toEqual([
      "defaultExpiryDate",
      "FeatureOverridesSection",
      "helper",
      "export * from './other';",
    ]);
  });
});

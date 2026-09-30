import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * #2717 M2 (SA-579, L-223): RecipeComponent rows of a non-DRAFT recipe are immutable, so the rows
 * may be written from exactly one place — the guarded functions of products/recipes.service.ts.
 * Any other file that writes `recipeComponent` (through the delegate, a nested write, or raw SQL)
 * fails here, and so does a recipes.service.ts that writes a component row from a function that
 * never asserts the recipe is DRAFT.
 */
const SRC_ROOT = join(__dirname, "..");
const ALLOW = new Set(["products/recipes.service.ts"]);
// #2717 M3 (SA-593): a DOCUMENT snapshot writer whose nested `components: { create }` is an
// InvoiceItemComponent write, not a RecipeComponent one; the text scan cannot tell them apart. It is
// allowed exactly N nested-write sites and NOTHING else: no `.recipeComponent.*` delegate call and no
// raw RecipeComponent SQL, so a second offending write added to the file still turns this red.
const DOCUMENT_NESTED_ALLOW: Record<string, number> = { "invoices/invoice-line-composition.ts": 1 };
const WRITES = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") out.push(...listTs(full));
    } else if (entry.endsWith(".ts") && !/\.spec\.ts$|\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const componentWrite = new RegExp(`\\.recipeComponent\\.(${WRITES.join("|")})\\(`);
const nestedWrite = /components:\s*\{\s*(create|createMany|update|upsert|delete|deleteMany|set)\b/;
const rawWrite = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?RecipeComponent"?/i;

/** Slice a source file into `name -> body` for its top-level and class-method functions. */
function functionBodies(text: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const head =
    /^ {2}(?:private |public |protected |async )*(?:async )?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\(/gm;
  const marks: Array<{ name: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = head.exec(text))) marks.push({ name: m[1], at: m.index });
  marks.forEach((mark, i) =>
    out.push({ name: mark.name, body: text.slice(mark.at, marks[i + 1]?.at ?? text.length) }),
  );
  return out;
}

const nestedCount = (text: string) =>
  (text.match(new RegExp(nestedWrite.source, "g")) ?? []).length;

/** Does this file write recipeComponent rows outside the recipe service's guarded functions? */
function offends(relPath: string, text: string): boolean {
  if (ALLOW.has(relPath)) return false;
  const nestedBudget = DOCUMENT_NESTED_ALLOW[relPath];
  if (nestedBudget !== undefined) {
    return componentWrite.test(text) || rawWrite.test(text) || nestedCount(text) > nestedBudget;
  }
  return componentWrite.test(text) || nestedWrite.test(text) || rawWrite.test(text);
}

describe("recipe component writer tripwire (SA-579)", () => {
  const files = listTs(SRC_ROOT);
  const writers = files.filter((f) => {
    const text = readFileSync(f, "utf8");
    return componentWrite.test(text) || nestedWrite.test(text) || rawWrite.test(text);
  });
  const rel = writers.map((f) => relative(SRC_ROOT, f).split("\\").join("/"));

  it("finds the recipe service (the scan is not vacuous)", () => {
    expect(rel).toContain("products/recipes.service.ts");
  });

  it("no other source file writes recipeComponent rows", () => {
    const offenders = files
      .map((f) => ({
        r: relative(SRC_ROOT, f).split("\\").join("/"),
        text: readFileSync(f, "utf8"),
      }))
      .filter(({ r, text }) => offends(r, text))
      .map(({ r }) => r);
    expect(offenders).toEqual([]);
  });

  it("the document-writer allowance is bounded: the real file uses exactly its budget", () => {
    for (const [file, budget] of Object.entries(DOCUMENT_NESTED_ALLOW)) {
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      expect({ file, nested: nestedCount(text) }).toEqual({ file, nested: budget });
      expect(offends(file, text)).toBe(false);
    }
  });

  // Negative controls (SA-593): the narrowed allowance must go red when the allowed file grows a
  // second offending write. Run the SAME predicate over in-spec fixtures.
  it.each([
    [
      "a second nested components create",
      "x({ components: { create: a } });\ny({ components: { create: b } });",
    ],
    [
      "a recipeComponent delegate call",
      "x({ components: { create: a } });\nprisma.recipeComponent.createMany({ data });",
    ],
    [
      "raw RecipeComponent SQL",
      'x({ components: { create: a } });\nINSERT INTO "RecipeComponent" VALUES (1);',
    ],
  ])("negative control: %s in the allowed document writer is an offence", (_name, text) => {
    expect(offends("invoices/invoice-line-composition.ts", text)).toBe(true);
  });

  it("negative control: the same nested write in any OTHER file is an offence", () => {
    expect(offends("orders/somewhere-else.ts", "x({ components: { create: a } });")).toBe(true);
  });

  it("every function in the recipe service that writes component rows asserts the recipe is DRAFT first", () => {
    const text = readFileSync(join(SRC_ROOT, "products", "recipes.service.ts"), "utf8");
    const writing = functionBodies(text).filter((fn) => componentWrite.test(fn.body));
    expect(writing.length).toBeGreaterThan(0);
    for (const fn of writing) {
      const guard = fn.body.search(/assertRecipeEditable\(/);
      const firstWrite = fn.body.search(componentWrite);
      expect({ fn: fn.name, guarded: guard >= 0 && guard < firstWrite }).toEqual({
        fn: fn.name,
        guarded: true,
      });
    }
  });
});

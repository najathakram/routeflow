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
    expect(rel.filter((f) => !ALLOW.has(f))).toEqual([]);
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

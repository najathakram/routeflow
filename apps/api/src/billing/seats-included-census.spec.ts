/**
 * B1371 census: there is no seat limit on any plan, so nothing may READ a plan's `seatsIncluded` to enforce,
 * cap, recommend or warn. The column stays one release (catalog publish / patch only). This walks every
 * non-spec `.ts` under `apps/api/src` and fails on any other file that names it, so a new reader (a cap, a
 * recommendation, a downgrade warning) is a red test here instead of a silent seat cut-off.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const SRC = join(__dirname, "..");

/** Files that may name `seatsIncluded`: the catalog write path and its DTO. Nothing else. */
const ALLOWED = new Set<string>([
  // publish / seed / patch of a plan definition row (the column is carried, never enforced)
  "billing/plan-catalog.service.ts",
  // the super-admin PATCH body for a plan definition
  "billing/dto/update-plan-definition.dto.ts",
]);

/** Named so a failure points at the file: these used to read it and must not again. */
const MUST_NOT_READ = [
  "billing/billing-cron.service.ts",
  "billing/entitlements.service.ts",
  "billing/subscription.service.ts",
  "billing/subscription-mutation.service.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".spec.ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("seatsIncluded census (B1371: no seat limit)", () => {
  const readers = walk(SRC)
    .filter((f) => /\bseatsIncluded\b/.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => relative(SRC, f).split(sep).join("/"))
    .sort();

  it("only the catalog write path and its DTO name seatsIncluded", () => {
    expect(readers.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });

  it.each(MUST_NOT_READ)("%s does not read seatsIncluded", (file) => {
    expect(readers).not.toContain(file);
  });

  it("every allow-list entry still exists and still names it (no stale entries)", () => {
    expect([...ALLOWED].sort()).toEqual(readers.filter((f) => ALLOWED.has(f)));
  });
});

import fs from "node:fs";
import path from "node:path";

// A script that prints through `scrubSecrets` stars out the database password wherever it occurs in the message. CI's
// password is the word "test" (db-migrations.yml: postgresql://test:test@localhost), so "non-test tenant" reaches a DB
// spec as "non-*** tenant" there and as plain text on a laptop whose password is random: green locally, red in the lane.
// A DB spec that runs such a script must therefore not assert a pattern with the bare word "test" in it; it asserts the
// refusal itself (exit code, nothing written, no id printed, a count) instead.

const API_DIR = path.resolve(__dirname, "../..");
const SRC_DIR = path.join(API_DIR, "src");
const SCRIPTS_DIR = path.join(API_DIR, "scripts");

const ASSERTS_TEST_WORD = /\b(?:toMatch|toContain|toEqual)\(.*\btest\b/;
const SCRIPT_REF = /([\w.-]+\.mjs)/g;

/** Lines of `spec` that assert a pattern holding the bare word "test"; empty when `spec` runs no scrubbing script. */
export function scrubFragileAssertions(
  spec: string,
  scriptSource: (name: string) => string | null,
): string[] {
  const names = new Set([...spec.matchAll(SCRIPT_REF)].map((m) => m[1]));
  const scrubbing = [...names].some((n) => (scriptSource(n) ?? "").includes("scrubSecrets("));
  if (!scrubbing) return [];
  return spec
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && ASSERTS_TEST_WORD.test(l))
    .map((l) => l.trim());
}

function dbSpecs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...dbSpecs(p));
    else if (e.name.endsWith(".db.spec.ts")) out.push(p);
  }
  return out;
}

const readScript = (name: string) => {
  const p = path.join(SCRIPTS_DIR, name);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
};

describe("DB specs that run a scrubbing script do not assert the word 'test' in its output", () => {
  it("the check itself: flags a pattern with 'test' for a scrubbing script, ignores the rest", () => {
    const spec = [
      `const SCRIPT = path.resolve(__dirname, "../../scripts/demo-tool.mjs");`,
      `expect(r.out).toMatch(/protected non-test tenant/);`,
      `// expect(r.out).toMatch(/a test comment/);`,
      `expect(r.out).toMatch(/env-listed 1/);`,
      `expect(r.out).toMatch(/routeflow_test/);`,
    ].join("\n");
    const scrubs = (n: string) =>
      n === "demo-tool.mjs" ? "console.error(scrubSecrets(msg, url));" : null;
    expect(scrubFragileAssertions(spec, scrubs)).toEqual([
      "expect(r.out).toMatch(/protected non-test tenant/);",
    ]);
    expect(scrubFragileAssertions(spec, () => "console.error(msg);")).toEqual([]);
    expect(scrubFragileAssertions(spec, () => null)).toEqual([]);
  });

  it("no DB spec in src/ does", () => {
    const bad: Record<string, string[]> = {};
    for (const f of dbSpecs(SRC_DIR)) {
      const hits = scrubFragileAssertions(fs.readFileSync(f, "utf8"), readScript);
      if (hits.length) bad[path.relative(API_DIR, f)] = hits;
    }
    expect(bad).toEqual({});
  });
});

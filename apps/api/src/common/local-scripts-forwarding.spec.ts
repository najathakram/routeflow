import fs from "node:fs";
import path from "node:path";

// p5 — root package.json `local:*` script contract. These scripts are the pre-PR gate's entry
// points (see CLAUDE.md's "Local hosting environment" runbook); this asserts their shape
// directly from the committed file rather than spawning them, so the case stays instant.

const ROOT_PACKAGE_JSON = path.resolve(__dirname, "../../../../package.json");

describe("root package.json local:* script contract (p5)", () => {
  const pkg = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, "utf8"));
  const scripts: Record<string, string> = pkg.scripts;

  it("local:drift forwards --local to the drift check", () => {
    expect(scripts["local:drift"]).toContain("-- --local");
  });

  it("local:test:db forwards --db --db-specs", () => {
    expect(scripts["local:test:db"]).toContain("--db --db-specs");
  });

  it("local:validate ends with npm run local:drift", () => {
    expect(scripts["local:validate"].trimEnd().replace(/"$/, "")).toMatch(/npm run local:drift$/);
  });

  it("every local:* script that sets environment goes through scripts/local-env.mjs (no VAR= prefix, no sh -c)", () => {
    const localScripts = Object.entries(scripts).filter(([name]) => name.startsWith("local:"));
    expect(localScripts.length).toBeGreaterThan(0);

    for (const [name, command] of localScripts) {
      // A script "sets environment" if it exports a shell VAR=value pair or invokes a shell
      // explicitly to do so; docker-compose-only scripts (build/up/migrate/logs/down/reset)
      // don't set env and are exempt.
      const setsEnvDirectly = /\b[A-Z][A-Z0-9_]*=/.test(command) || / sh -c /.test(command);
      if (setsEnvDirectly) {
        throw new Error(
          `local:* script "${name}" sets env directly instead of going through scripts/local-env.mjs: ${command}`,
        );
      }
      const looksLikeEnvSetter = /--db|--smoke|--db-specs/.test(command);
      if (looksLikeEnvSetter) {
        expect(command).toContain("node scripts/local-env.mjs");
      }
    }
  });
});

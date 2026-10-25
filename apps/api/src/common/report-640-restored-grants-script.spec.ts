import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ADDON_KEY_TO_REGISTRY_KEY, featureDefByKey } from "../billing/feature-registry";

// Row 640 (SA-834) — apps/api/scripts/report-640-restored-grants.mjs contract: read-only, counts
// only, fails closed without a database url, and its billable-key map mirrors the registry.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-640-restored-grants.mjs");
const source = fs.readFileSync(SCRIPT, "utf8");

const node = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, args, { cwd: API_DIR, encoding: "utf8", env, timeout: 60_000 });

describe("report-640-restored-grants.mjs", () => {
  it("fails closed with no database url, before connecting", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_PUBLIC_URL;
    expect(node([SCRIPT], env).status).toBe(2);
  });

  it("sets the session read-only and carries no write-capable SQL", () => {
    expect(source).toContain("SET default_transaction_read_only = on");
    const sql = source
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
      .join("\n");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/);
  });

  it("--self-test runs by its real path", () => {
    const r = node([SCRIPT, "--self-test"], process.env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("self-test ok");
  });

  // Row 686: the pure fold pinned by value, run through real node (the script is ESM).
  const fold = (rows: unknown[]) => {
    const code =
      `import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then(m=>` +
      `console.log(JSON.stringify(m.summarize(${JSON.stringify(rows)}))))`;
    const r = node(["--input-type=module", "-e", code], process.env);
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout.trim());
  };

  it("counts an unstamped partial restore separately (old script counted it as 0)", () => {
    const s = fold([
      { kind: "TRIAL", n: 2, hasPricedRow: false, signal: "stamped", catalogPriced: true },
      { kind: "PILOT", n: 3, hasPricedRow: false, signal: "unstamped", catalogPriced: true },
      { kind: "COMP", n: 1, hasPricedRow: false, signal: "unstamped", catalogPriced: true },
    ]);
    expect(s.restoredGrants).toBe(2);
    expect(s.nonCompWithoutPricedRow).toBe(2);
    expect(s.unstampedPossible).toEqual({
      grants: 4,
      byKind: { PILOT: 3, COMP: 1 },
      nonCompWithoutPricedRow: 3,
    });
  });

  it("does not call a grant harmful when the catalog does not price the SKU", () => {
    const s = fold([
      { kind: "TRIAL", n: 5, hasPricedRow: false, signal: "stamped", catalogPriced: false },
      { kind: "TRIAL", n: 1, hasPricedRow: false, signal: "stamped", catalogPriced: true },
    ]);
    expect(s.restoredGrants).toBe(6);
    expect(s.nonCompWithoutPricedRow).toBe(1);
  });

  it("states its limits in plain words as a limits array", () => {
    const s = fold([]);
    expect(Array.isArray(s.limits)).toBe(true);
    expect(s.limits.join(" ")).toMatch(/unstamped/i);
    expect(s.limits.join(" ")).toMatch(/includedAtPlan/);
  });

  it("matches unstamped restores via the HELD audit row and prices via AddonSku", () => {
    expect(source).toContain("CONFIG_SNAPSHOT_RESTORE_HELD");
    expect(source).toContain('"AddonSku"');
  });

  it("its billable keys are registry add-on keys carrying exactly those catalog SKUs (parity pin)", () => {
    const block = source.match(/export const BILLABLE_KEYS = \{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    const mirror = Object.fromEntries(
      [...block![1].matchAll(/(\w+):\s*"([A-Z0-9_]+)"/g)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(mirror).length).toBeGreaterThan(0);
    for (const [key, sku] of Object.entries(mirror)) {
      expect(ADDON_KEY_TO_REGISTRY_KEY[key]).toBe(key);
      expect(featureDefByKey(key)?.billing.skus).toContain(sku);
    }
  });
});

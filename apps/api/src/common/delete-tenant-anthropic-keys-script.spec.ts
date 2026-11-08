import fs from "node:fs";
import path from "node:path";

// AI limits PR-2: apps/api/scripts/delete-tenant-anthropic-keys.mjs removes stored business Claude keys. Dry run is the
// default and writes nothing; the ONE writer is the core (one transaction, an AuditLog row per delete); a non-test tenant
// or a non-local database needs --live-tenant-override and a typed phrase; a protected tenant also needs --allow-protected.
// The SQL against a real database is in `system-config/delete-anthropic-keys.db.spec.ts`.

const API_DIR = path.resolve(__dirname, "../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const cli = strip(
  fs.readFileSync(path.join(API_DIR, "scripts/delete-tenant-anthropic-keys.mjs"), "utf8"),
);
const coreFile = path.join(API_DIR, "scripts/lib/delete-anthropic-keys-core.cjs");
const coreSrc = strip(fs.readFileSync(coreFile, "utf8"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require(coreFile);

describe("delete-tenant-anthropic-keys.mjs", () => {
  it("structural: the CLI holds no SQL writer; the core's one DELETE is row-scoped and always audited, in one transaction", () => {
    expect(cli).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/);
    expect(coreSrc.match(/\bDELETE FROM\b/g)).toHaveLength(1);
    expect(coreSrc).toMatch(/WHERE id = \$1 AND "tenantId" = \$2 AND key = \$3/);
    expect(coreSrc.match(/\bINSERT INTO "AuditLog"/g)).toHaveLength(1);
    expect(coreSrc.match(/"BEGIN"/g)).toHaveLength(1);
    expect(coreSrc.match(/"COMMIT"/g)).toHaveLength(1);
    expect(coreSrc).not.toMatch(/\b(TRUNCATE|UPDATE)\b|PlatformConfig/);
  });

  it("structural: dry run returns before the gate; it uses the live-target guard and prints no value", () => {
    expect(cli.indexOf("if (!apply) return")).toBeGreaterThan(-1);
    expect(cli.indexOf("if (!apply) return")).toBeLessThan(cli.indexOf("applyGate({"));
    expect(cli).toContain("liveTenantCount(");
    expect(cli).toMatch(/const local = hostLocal && liveTenants === 0/);
    expect(cli).toContain("protectedTenantIds(");
    expect(cli).toContain("confirmProtectedOverride(");
    expect(cli).not.toMatch(/console\.(log|error)\([^)]*\$\{[^}]*\b(value|slug|secret)\b/);
    expect(/SELECT([\s\S]*?)FROM/.exec(coreSrc)?.[1]).not.toMatch(/value/); // the list names no value column
  });

  describe("planDeletes", () => {
    const refs = [
      { id: "r1", tenantId: "test-1", isTest: true },
      { id: "r2", tenantId: "biz-1", isTest: false },
      { id: "r3", tenantId: "prot-1", isTest: false },
    ];
    const protectedIds = new Set(["prot-1"]);

    it("test tenants only by default; a non-test tenant needs the override; a protected one also needs its id", () => {
      const ids = (o: object) =>
        core.planDeletes({ refs, protectedIds, ...o }).write.map((r: { id: string }) => r.id);
      expect(ids({ liveOverride: false })).toEqual(["r1"]);
      expect(ids({ liveOverride: true })).toEqual(["r1", "r2"]);
      expect(ids({ liveOverride: true, allowProtected: new Set(["prot-1"]) })).toEqual([
        "r1",
        "r2",
        "r3",
      ]);
      expect(core.planDeletes({ refs, protectedIds, liveOverride: false }).skipped).toEqual({
        protected: 1,
        nonTest: 1,
      });
    });
  });

  it("applyGate: dry run, nothing to delete, or a local database with test tenants only passes; the rest needs override, backup, a terminal and the phrase", () => {
    const g = (o: object) =>
      core.applyGate({ apply: true, local: true, rows: 3, nonTestRows: 0, ...o });
    const ok = { ok: true, phrase: null };
    expect(g({ apply: false, local: false, nonTestRows: 3 })).toEqual(ok);
    expect(g({ rows: 0, local: false, nonTestRows: 0 })).toEqual(ok);
    expect(g({})).toEqual(ok);
    expect(g({ local: false })).toMatchObject({ ok: false }); // test tenants on a non-local database
    expect(g({ nonTestRows: 2 })).toMatchObject({ ok: false }); // a non-test tenant on a local one
    expect(g({ nonTestRows: 2, liveOverride: true })).toMatchObject({ ok: false });
    expect(g({ nonTestRows: 2, liveOverride: true, backupTaken: true })).toMatchObject({
      ok: false,
    });
    const all = { nonTestRows: 2, liveOverride: true, backupTaken: true, isTTY: true };
    expect(g(all)).toEqual({ ok: true, phrase: "DELETE 3 LIVE" });
  });

  it("parseAllowProtected: every --allow-protected <id>, ids only", () => {
    const argv = ["--apply", "--allow-protected", "t-1", "--allow-protected", "t-2"];
    expect(core.parseAllowProtected(argv)).toEqual(["t-1", "t-2"]);
    expect(() => core.parseAllowProtected(["--allow-protected"])).toThrow(/needs a tenant id/);
  });
});

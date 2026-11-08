import fs from "node:fs";
import path from "node:path";

// AI limits PR-2: encrypt-legacy-secrets.mjs rewrites plaintext secret config rows. Dry run is the default and reads no
// value; `--apply` is behind `applyGate`; the ONE writer is the core (compare-and-swap). SQL: legacy-secrets.db.spec.ts.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/encrypt-legacy-secrets.mjs");
const CORE = path.resolve(API_DIR, "scripts/lib/legacy-secrets-core.cjs");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const cli = strip(fs.readFileSync(SCRIPT, "utf8"));
const coreSrc = strip(fs.readFileSync(CORE, "utf8"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require(CORE);

describe("encrypt-legacy-secrets.mjs", () => {
  it("structural: the CLI holds no SQL writer; the core's one UPDATE is row-scoped with a compare-and-swap", () => {
    expect(cli).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    expect(coreSrc.match(/\bUPDATE\s+"/g)).toHaveLength(1);
    expect(coreSrc).toMatch(/WHERE id = \$2 AND value = \$3/);
    expect(coreSrc).toMatch(/FOR UPDATE/);
    // never the bulk forms
    expect(coreSrc).not.toMatch(/\b(DELETE|TRUNCATE)\b/);
  });

  it("structural: it encrypts through the compiled EncryptionService, never its own crypto", () => {
    expect(cli).toContain('"dist", "common", "encryption.service.js"');
    for (const text of [cli, coreSrc]) {
      expect(text).not.toMatch(
        /createCipheriv|createDecipheriv|from "node:crypto"|require\("crypto"\)/,
      );
    }
  });

  it("structural: it goes through the live-target guard and prints no value", () => {
    expect(cli).toContain("protectedTenantIds(");
    expect(cli).toContain("confirmProtectedOverride(");
    expect(cli).not.toMatch(/console\.(log|error)\([^)]*\$\{[^}]*\b(value|old|plain|secret)\b/);
    expect(coreSrc).not.toMatch(/\blog\([^)]*\$\{[^}]*\b(value|old|enc|plain|secret)\b/);
  });

  it("the key lists live in ONE file the report script and this script both read", () => {
    const report = fs.readFileSync(
      path.join(API_DIR, "scripts/report-plaintext-secrets.mjs"),
      "utf8",
    );
    expect(report).toContain('from "./lib/secret-config-keys.cjs"');
    expect(cli + coreSrc).toContain("secret-config-keys.cjs");
  });

  it("applyGate: local or dry run passes; any other database needs override, backup, a terminal and the typed phrase", () => {
    const g = (o: object) => core.applyGate({ apply: true, local: false, rows: 7, ...o });
    const ok = { ok: true, phrase: null };
    expect(g({ apply: false })).toEqual(ok);
    expect(g({ rows: 0 })).toEqual(ok);
    expect(g({ local: true })).toEqual(ok);
    expect(g({})).toMatchObject({ ok: false });
    expect(g({ liveOverride: true })).toMatchObject({ ok: false });
    expect(g({ liveOverride: true, backupTaken: true })).toMatchObject({ ok: false });
    const all = { liveOverride: true, backupTaken: true, isTTY: true };
    expect(g(all)).toEqual({ ok: true, phrase: "ENCRYPT 7 LIVE" });
  });

  it("parseAllowProtected: every --allow-protected <id>, ids only", () => {
    const argv = ["--apply", "--allow-protected", "t-1", "--allow-protected", "t-2"];
    expect(core.parseAllowProtected(argv)).toEqual(["t-1", "t-2"]);
    expect(() => core.parseAllowProtected(["--allow-protected"])).toThrow(/needs a tenant id/);
  });
});

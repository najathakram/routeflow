import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// AI limits PR-2 (SA-1102 §4): apps/api/scripts/encrypt-legacy-secrets.mjs rewrites plaintext secret config rows through
// the real EncryptionService. The dry run is the default and reads no value; `--apply` is behind one decision
// (`applyGate`), protected tenants need `--allow-protected <id>`, and the ONE writer is the core, row by row, with a
// compare-and-swap on the old value. The SQL against a real database is in `legacy-secrets.db.spec.ts`.

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
    expect(report).not.toMatch(/SYSTEM_CONFIG_SECRET_KEYS = \[/);
    expect(cli + coreSrc).toContain("secret-config-keys.cjs");
  });

  it("the dry run is the default: --apply with no database configured exits 1 and says why", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--apply"], {
      cwd: API_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/encrypt-legacy-secrets/);
  });

  describe("applyGate (the one decision)", () => {
    const base = {
      apply: true,
      local: true,
      liveOverride: false,
      backupTaken: false,
      isTTY: false,
    };

    it("a dry run, or nothing to encrypt, is always fine", () => {
      expect(core.applyGate({ ...base, apply: false, rows: 5 })).toEqual({
        ok: true,
        phrase: null,
      });
      expect(core.applyGate({ ...base, local: false, rows: 0 })).toEqual({
        ok: true,
        phrase: null,
      });
    });

    it("apply on a provably local database needs nothing more", () => {
      expect(core.applyGate({ ...base, rows: 3 })).toEqual({ ok: true, phrase: null });
    });

    it("apply on any other database is refused without --live-target-override, then without --backup-taken, then without a terminal", () => {
      const live = { ...base, local: false, rows: 3 };
      expect(core.applyGate(live)).toMatchObject({ ok: false });
      expect(core.applyGate({ ...live, liveOverride: true })).toMatchObject({ ok: false });
      expect(
        core.applyGate({ ...live, liveOverride: true, backupTaken: true, isTTY: false }),
      ).toMatchObject({ ok: false });
    });

    it("apply on another database with all three needs the typed phrase naming the row count", () => {
      expect(
        core.applyGate({
          ...base,
          local: false,
          rows: 7,
          liveOverride: true,
          backupTaken: true,
          isTTY: true,
        }),
      ).toEqual({ ok: true, phrase: "ENCRYPT 7 LIVE" });
    });
  });

  it("parseAllowProtected: every --allow-protected <id>, ids only", () => {
    expect(
      core.parseAllowProtected(["--apply", "--allow-protected", "t-1", "--allow-protected", "t-2"]),
    ).toEqual(["t-1", "t-2"]);
    expect(core.parseAllowProtected(["--apply"])).toEqual([]);
    expect(() => core.parseAllowProtected(["--allow-protected"])).toThrow(/needs a tenant id/);
    expect(() => core.parseAllowProtected(["--allow-protected", "--apply"])).toThrow(
      /needs a tenant id/,
    );
  });
});

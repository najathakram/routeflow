import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LEGACY_ADDON_KEY_TO_SKU } from "../billing/plan-catalog.constants";

// #2188 / SA-385 (6) — apps/api/scripts/report-b2188-duplicate-addon-rows.mjs contract.
// Read-only, counts only: fails closed without a DB url, carries no write SQL, mirrors the ONE
// legacy key → sku map exactly, and never lets a tenant id or slug reach its output.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-b2188-duplicate-addon-rows.mjs");
const source = fs.readFileSync(SCRIPT, "utf8");

function codeLines(): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
    );
}

function node(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, args, {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

describe("report-b2188-duplicate-addon-rows.mjs", () => {
  it("fails closed with no database url, before connecting", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_PUBLIC_URL;
    const r = node([SCRIPT], env);
    expect(r.status).toBe(2);
  });

  it("sets the session read-only and carries no write-capable SQL", () => {
    expect(source).toContain("SET default_transaction_read_only = on");
    const sql = codeLines().join("\n");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/);
  });

  it("caps locks too", () => {
    expect(source).toContain("SET lock_timeout");
  });

  // A dead entry check exits 0 with no output, which reads as "no duplicates". Spawn the REAL
  // file — and the same file through a symlink in a directory whose name has a space — and
  // require the self-test's own output, so that can never pass silently again.
  it("--self-test runs when spawned by its real path", () => {
    const direct = node([SCRIPT, "--self-test"], process.env);
    expect(direct.status).toBe(0);
    expect(direct.stdout.trim()).toBe("self-test ok");
  });

  // Windows without symlink rights throws EPERM (the #2221 trap) — skip there, loudly, rather
  // than turn every PC pre-push red; the real-path case above still runs everywhere.
  it("--self-test runs through a symlink in a directory whose name has a space", () => {
    if (process.platform === "win32") {
      console.warn("skipped: symlink entry case needs symlink rights; not asserted on win32");
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2188 entry "));
    const link = path.join(dir, "report-b2188-duplicate-addon-rows.mjs");
    try {
      try {
        fs.symlinkSync(SCRIPT, link);
      } catch (e: any) {
        if (e?.code === "EPERM" || e?.code === "EACCES") {
          console.warn(`skipped: cannot create a symlink here (${e.code})`);
          return;
        }
        throw e;
      }
      const viaLink = node([link, "--self-test"], process.env);
      expect(viaLink.status).toBe(0);
      expect(viaLink.stdout.trim()).toBe("self-test ok");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mirrors LEGACY_ADDON_KEY_TO_SKU exactly (deep-equal parity pin)", () => {
    const block = source.match(/export const LEGACY_ADDON_KEY_TO_SKU = \{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    const mirror = Object.fromEntries(
      [...block![1].matchAll(/(\w+):\s*"([A-Z0-9_]+)"/g)].map((m) => [m[1], m[2]]),
    );
    expect(mirror).toEqual(LEGACY_ADDON_KEY_TO_SKU);
  });

  it("summarize labels tenants anonymously and never echoes an id or slug", () => {
    const rows = [
      { tenantId: "11111111-aaaa", slug: "acme", code: "MSRP", rows: 2 },
      { tenantId: "11111111-aaaa", slug: "acme", code: "OCR_PACK_250", rows: 2 },
      { tenantId: "22222222-bbbb", slug: "globex", code: "MSRP", rows: 3 },
    ];
    const r = node(
      [
        "--input-type=module",
        "-e",
        // An ESM import needs a file:// URL — a bare absolute path is ERR_UNSUPPORTED_ESM_URL_SCHEME on win32.
        `import { summarize } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};` +
          `console.log(JSON.stringify(summarize(${JSON.stringify(rows)})));`,
      ],
      process.env,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/1111|2222|acme|globex/);
    expect(JSON.parse(r.stdout)).toEqual({
      tenants: 2,
      groups: 3,
      detail: [
        { tenant: "tenant A", sku: "MSRP", rows: 2 },
        { tenant: "tenant A", sku: "OCR_PACK_250", rows: 2 },
        { tenant: "tenant B", sku: "MSRP", rows: 3 },
      ],
    });
  });
});

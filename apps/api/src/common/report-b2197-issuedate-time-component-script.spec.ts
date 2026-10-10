import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// #2197 / R-030 — apps/api/scripts/report-b2197-issuedate-time-component.mjs contract.
// Read-only, counts only: fails closed without a DB url, carries no write SQL, and never lets a
// tenant id or slug reach its output.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-b2197-issuedate-time-component.mjs");
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

describe("report-b2197-issuedate-time-component.mjs", () => {
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

  it("caps statements and locks", () => {
    expect(source).toContain("SET statement_timeout");
    expect(source).toContain("SET lock_timeout");
  });

  // A dead entry check exits 0 with no output, which reads as "nothing found". Spawn the REAL
  // file, and the same file through a symlink in a directory whose name has a space.
  it("--self-test runs when spawned by its real path and through a spaced symlink", () => {
    const direct = node([SCRIPT, "--self-test"], process.env);
    expect(direct.status).toBe(0);
    expect(direct.stdout.trim()).toBe("self-test ok");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2197 entry "));
    const link = path.join(dir, "report-b2197-issuedate-time-component.mjs");
    try {
      try {
        fs.symlinkSync(SCRIPT, link);
      } catch (e: any) {
        // Same guard as the b2188 spec: a Windows box without symlink rights (EPERM) cannot
        // build the fixture — the real-path run above still proves the self-test.
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

  it("summarize labels tenants anonymously and never echoes an id or slug", () => {
    const rows = [
      { tenantId: "11111111-aaaa", slug: "acme", rows: 4, drafts: 1 },
      { tenantId: "22222222-bbbb", slug: "globex", rows: 2, drafts: 0 },
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
      invoices: 6,
      drafts: 1,
      detail: [
        { tenant: "tenant A", rows: 4, drafts: 1 },
        { tenant: "tenant B", rows: 2, drafts: 0 },
      ],
    });
  });
});

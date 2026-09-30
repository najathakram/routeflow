import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// TP4 — apps/api/scripts/report-addon-gate-blast-radius.mjs contract (pins, no REG token).
//
// Read-only report: it must fail closed when DATABASE_URL is unset, before opening any
// connection, and its source must never carry a write-capable SQL keyword. Modeled on
// prod-migrate-script.spec.ts's way of exercising a script via spawnSync.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-addon-gate-blast-radius.mjs");

function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  return { ...env, ...extra };
}

/** The script's non-comment lines — a claim in a comment must never satisfy a source pin. */
function codeLines(): string[] {
  return fs
    .readFileSync(SCRIPT, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
    );
}

function run(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

describe("report-addon-gate-blast-radius.mjs contract (TP4)", () => {
  it("P3a: exits non-zero and names DATABASE_URL when it is unset, before opening any connection", () => {
    const res = run(scrubbedEnv());

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.status).not.toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("DATABASE_URL");
    // It must be a fail-closed MESSAGE, not a token that happened to appear in a stack trace;
    // this also keeps a locally present DATABASE_URL (dotenv) from turning the test green.
    expect(combined).toMatch(/required|not set|unset|missing/i);
    // "before opening any connection": no driver-level connection error may appear.
    expect(combined).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|reach database/i);
  });

  it("P3b: source is read-only — declares default_transaction_read_only and no write-capable SQL keyword", () => {
    const code = codeLines().join("\n");

    // Asserted on non-comment lines: a comment mentioning the setting must not satisfy this.
    expect(code).toContain("default_transaction_read_only");

    const forbidden = ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP", "TRUNCATE"];
    const found = forbidden.filter((keyword) => new RegExp(`\\b${keyword}\\b`, "i").test(code));
    expect(found).toEqual([]);
  });

  it("P3c: usage evidence covers every gated ocr route — both scan archives and the AiUsageEvent feature rollup", () => {
    // The `ocr` gate sits on four routes that leave three different traces: InvoiceScan
    // (vendor-bill + batch import), SupplierStatementScan (statement scan) and AiUsageEvent
    // `ocr.*` (the expense-receipt extraction's only trace). Dropping any one of them makes the
    // report undercount the tenants a flip to `enforced` would deny — the PR #475 outage again.
    const code = codeLines().join("\n");

    expect(code).toContain('"InvoiceScan"');
    expect(code).toContain('"SupplierStatementScan"');
    expect(code).toContain('"AiUsageEvent"');
    expect(code).toContain("LIKE $1 || '.%'");
  });
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// #477 — apps/api/scripts/report-477-sub-without-customer.mjs contract. Read-only, counts only:
// fails closed without a DB url, carries no write SQL, and --self-test runs when spawned by its real
// path (a dead entry check would exit 0 silently, reading as "none found").

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-477-sub-without-customer.mjs");
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

describe("report-477-sub-without-customer.mjs", () => {
  it("fails closed with no database url, before connecting", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env))
      if (/^(DATABASE_|POSTGRES_|PG|RAILWAY_TCP_PROXY_)/.test(k)) delete env[k];
    expect(node([SCRIPT], env).status).toBe(2);
  });

  it("sets the session read-only, caps statements and locks, and carries no write-capable SQL", () => {
    expect(source).toContain("SET default_transaction_read_only = on");
    expect(source).toContain("SET statement_timeout");
    expect(source).toContain("SET lock_timeout");
    const sql = codeLines().join("\n");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/);
  });

  it("--self-test runs when spawned by its real path", () => {
    const r = node([SCRIPT, "--self-test"], process.env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("self-test ok");
  });

  it("counts by status only — no id or slug reaches the summary", () => {
    const rows = [
      { tenantId: "11111111-aaaa", slug: "acme", status: "ACTIVE" },
      { tenantId: "22222222-bbbb", slug: "globex", status: "TRIAL" },
    ];
    const r = node(
      [
        "--input-type=module",
        "-e",
        `import { summarize } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};` +
          `console.log(JSON.stringify(summarize(${JSON.stringify(rows)})));`,
      ],
      process.env,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/1111|2222|acme|globex/);
    expect(JSON.parse(r.stdout)).toEqual({ tenants: 2, byStatus: { ACTIVE: 1, TRIAL: 1 } });
  });

  it("selects subscription-without-customer only, and --detail returns tenant ids and nothing else", () => {
    // the gate treats an empty-string customer id as absent, so the count must too
    expect(source).toContain(
      `s."stripeSubId" IS NOT NULL AND (s."stripeCustomerId" IS NULL OR s."stripeCustomerId" = '')`,
    );
    const rows = [{ tenantId: "11111111-aaaa", slug: "acme", status: "ACTIVE" }];
    const r = node(
      [
        "--input-type=module",
        "-e",
        `import { detailIds } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};` +
          `console.log(JSON.stringify(detailIds(${JSON.stringify(rows)})));`,
      ],
      process.env,
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["11111111-aaaa"]);
    expect(r.stdout).not.toMatch(/acme|ACTIVE/);
  });
});

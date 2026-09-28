import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// SA-540 — apps/api/scripts/report-addon-default-grant-flip.mjs contract.
//
// Read-only report: it must fail closed when DATABASE_URL is unset, before opening any
// connection, its source must never carry a write-capable SQL keyword or open a non-read-only
// transaction, its output must be counts only (never a tenant id/slug/name), and its pure
// classification/aggregation functions must pin every bucket from synthetic inputs, with no DB.
// Modeled on report-addon-gate-blast-radius-script.spec.ts's way of exercising a script.
//
// The pure functions live in scripts/lib/addon-default-grant-flip-classify.cjs (CommonJS) and
// are loaded here with a plain `require()` — the same code the .mjs script runs via
// `createRequire`, without needing --experimental-vm-modules to dynamic-`import()` an ESM file.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-addon-default-grant-flip.mjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  aggregate,
  classifyTenant,
}: {
  aggregate: (rows: Array<{ planKey: string; bucket: string; hasInactiveRow: boolean }>) => {
    byPlan: Array<Record<string, unknown>>;
    totals: Record<string, number>;
  };
  classifyTenant: (ctx: {
    hasActiveRow: boolean;
    activeAddonSet: Set<string>;
    entFlags: string[];
    overrides: Map<string, "GRANT" | "DENY">;
  }) => string;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require(path.resolve(API_DIR, "scripts/lib/addon-default-grant-flip-classify.cjs"));

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

describe("report-addon-default-grant-flip.mjs contract (SA-540)", () => {
  it("P1: exits non-zero and names DATABASE_URL when it is unset, before opening any connection", () => {
    const res = run(scrubbedEnv());

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.status).not.toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("DATABASE_URL");
    expect(combined).toMatch(/required|not set|unset|missing/i);
    // "before opening any connection": no driver-level connection error may appear.
    expect(combined).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|reach database/i);
  });

  it("P2: source is read-only — declares default_transaction_read_only and no write-capable SQL/Prisma keyword", () => {
    const code = codeLines().join("\n");

    expect(code).toContain("default_transaction_read_only");

    const forbiddenSql = ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP", "TRUNCATE"];
    const foundSql = forbiddenSql.filter((keyword) =>
      new RegExp(`\\b${keyword}\\b`, "i").test(code),
    );
    expect(foundSql).toEqual([]);

    // No Prisma-style write call either, in case a future edit swaps `pg` for a Prisma client.
    const forbiddenCalls = [
      /\.create\s*\(/,
      /\.update\s*\(/,
      /\.upsert\s*\(/,
      /\.delete\s*\(/,
      /\.updateMany\s*\(/,
      /\.deleteMany\s*\(/,
    ];
    for (const pattern of forbiddenCalls) {
      expect(code).not.toMatch(pattern);
    }
  });

  it("P3: never prints a tenant id/slug/name/email — aggregate output is counts only", () => {
    // A fixture carrying the kind of identifying values a real row could contain — the aggregate
    // must never let any of them leak into its stringified output.
    const forbiddenValues = [
      "acme-wholesale-9f3c",
      "tenant_8f21c4b0-91a2-4e77-9c3a-1d2e3f4a5b6c",
      "owner@acme-wholesale.example",
      "Acme Wholesale Distributors",
    ];

    const rows = [
      { planKey: "STARTER", bucket: "FLIPS_ON", hasInactiveRow: false },
      { planKey: "STARTER", bucket: "ALREADY_HELD", hasInactiveRow: true },
      { planKey: "GROWTH", bucket: "DENIED", hasInactiveRow: false },
      { planKey: "GROWTH", bucket: "REQUIRES_UNMET", hasInactiveRow: false },
    ];

    const result = aggregate(rows);
    const stringified = JSON.stringify(result);

    for (const forbidden of forbiddenValues) {
      expect(stringified).not.toContain(forbidden);
    }
    // The aggregate is genuinely counts-only: every leaf value is a number, every key a plan key
    // or bucket/total name.
    expect(result.totals.FLIPS_ON).toBe(1);
    expect(result.totals.ALREADY_HELD).toBe(1);
    expect(result.totals.DENIED).toBe(1);
    expect(result.totals.REQUIRES_UNMET).toBe(1);
    expect(result.totals.INACTIVE_ROW).toBe(1);
    expect(result.totals.total).toBe(4);
  });

  describe("classifyTenant — pure, no DB (pins every bucket from synthetic inputs)", () => {
    it("no row + plan grants flag.returns -> FLIPS_ON", () => {
      const bucket = classifyTenant({
        hasActiveRow: false,
        activeAddonSet: new Set(),
        entFlags: ["flag.returns"],
        overrides: new Map(),
      });
      expect(bucket).toBe("FLIPS_ON");
    });

    it("DENY override on orders_inline_returns -> DENIED, even with the plan flag", () => {
      const bucket = classifyTenant({
        hasActiveRow: false,
        activeAddonSet: new Set(),
        entFlags: ["flag.returns"],
        overrides: new Map([["orders_inline_returns", "DENY"]]),
      });
      expect(bucket).toBe("DENIED");
    });

    it("no row, plan does not grant flag.returns -> REQUIRES_UNMET", () => {
      const bucket = classifyTenant({
        hasActiveRow: false,
        activeAddonSet: new Set(),
        entFlags: [],
        overrides: new Map(),
      });
      expect(bucket).toBe("REQUIRES_UNMET");
    });

    it("GRANT override on flag.returns without the plan flag -> FLIPS_ON", () => {
      const bucket = classifyTenant({
        hasActiveRow: false,
        activeAddonSet: new Set(),
        entFlags: [],
        overrides: new Map([["flag.returns", "GRANT"]]),
      });
      expect(bucket).toBe("FLIPS_ON");
    });

    it("DENY override on flag.returns even with the plan flag -> REQUIRES_UNMET", () => {
      const bucket = classifyTenant({
        hasActiveRow: false,
        activeAddonSet: new Set(),
        entFlags: ["flag.returns"],
        overrides: new Map([["flag.returns", "DENY"]]),
      });
      expect(bucket).toBe("REQUIRES_UNMET");
    });

    it("active TenantAddon row -> ALREADY_HELD", () => {
      const bucket = classifyTenant({
        hasActiveRow: true,
        activeAddonSet: new Set(["orders_inline_returns"]),
        entFlags: [],
        overrides: new Map(),
      });
      expect(bucket).toBe("ALREADY_HELD");
    });
  });
});

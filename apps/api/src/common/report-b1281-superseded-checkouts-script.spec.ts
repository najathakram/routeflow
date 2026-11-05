import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// B1281 / SA-1103 (c): apps/api/scripts/report-b1281-superseded-checkouts.mjs contract. Read-only on the database AND
// on Stripe, ids last-4 and counts only, exit 0 clean / 3 finding / 2 usage, and a --self-test that runs when spawned by
// its real path (a dead entry check would exit 0 silently, reading as "none found").

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-b1281-superseded-checkouts.mjs");
const source = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, "utf8") : "";
const periodSource = fs.readFileSync(
  path.resolve(__dirname, "../billing/stripe-period.ts"),
  "utf8",
);

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

/** Run an exported function of the script in a child and return its JSON result. */
function call(expr: string): unknown {
  const r = node(
    [
      "--input-type=module",
      "-e",
      `import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)};` +
        `console.log(JSON.stringify(${expr}));`,
    ],
    process.env,
  );
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env))
    if (/^(DATABASE_|POSTGRES_|PG|RAILWAY_TCP_PROXY_|STRIPE_)/.test(k)) delete env[k];
  return { ...env, ...extra };
};

describe("report-b1281-superseded-checkouts.mjs", () => {
  it("exists", () => {
    expect(source).not.toBe("");
  });

  it("exits 2 (usage) with no Stripe key, before reading anything", () => {
    expect(node([SCRIPT], cleanEnv({ DATABASE_URL: "postgres://u:p@localhost:1/x" })).status).toBe(
      2,
    );
  });

  it("exits 2 with a Stripe key that is not a sk_/rk_ live or test key", () => {
    const env = cleanEnv({ STRIPE_SECRET_KEY: "pk_test_notasecret", DATABASE_URL: "postgres://x" });
    expect(node([SCRIPT], env).status).toBe(2);
  });

  it("exits 2 with a key but no database url, before connecting", () => {
    expect(node([SCRIPT], cleanEnv({ STRIPE_SECRET_KEY: "sk_test_unit" })).status).toBe(2);
  });

  it("exits 2 on an unknown flag or a bad --since", () => {
    const env = cleanEnv({ STRIPE_SECRET_KEY: "sk_test_unit", DATABASE_URL: "postgres://x" });
    expect(node([SCRIPT, "--bogus"], env).status).toBe(2);
    expect(node([SCRIPT, "--since", "yesterday"], env).status).toBe(2);
  });

  it("sets the session read-only, caps statements and locks, and carries no write-capable SQL", () => {
    expect(source).toContain("SET default_transaction_read_only = on");
    expect(source).toContain("SET statement_timeout");
    expect(source).toContain("SET lock_timeout");
    const sql = codeLines().join("\n");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/);
  });

  it("reaches Stripe only through list calls (class pin: no write verb on any Stripe resource)", () => {
    const code = codeLines().join("\n");
    expect(code).not.toMatch(
      /\.(create|update|cancel|del|confirm|pay|finalizeInvoice|voidInvoice|capture|refund)\s*\(/,
    );
    // the only Stripe resources it names are the two read-only lists
    const resources = [...code.matchAll(/stripe\.([a-zA-Z.]+?)\.list\(/g)].map((m) => m[1]).sort();
    expect(resources).toEqual(["checkout.sessions", "subscriptions"]);
  });

  it("uses the app's Stripe API version and the app's live-status set (no drift)", () => {
    const version = /STRIPE_API_VERSION = "([^"]+)"/.exec(periodSource)![1];
    expect(source).toContain(`"${version}"`);
    const set = /LIVE_SUBSCRIPTION_STATUSES[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(periodSource)![1];
    const appStatuses = [...set.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(call("[...m.LIVE_STATUSES].sort()")).toEqual(appStatuses);
  });

  it("--self-test runs when spawned by its real path", () => {
    const r = node([SCRIPT, "--self-test"], process.env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("self-test ok");
  });

  describe("classifyTenant (pure)", () => {
    const sub = (id: string, status: string) => ({ id, status });
    const sess = (subscription: string | null) => ({ mode: "subscription", subscription });

    it("a tenant with its one stored live subscription is clean", () => {
      const out = call(
        `m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: [${JSON.stringify(sub("sub_AAAA1111", "active"))}], sessions: [${JSON.stringify(sess("sub_AAAA1111"))}] })`,
      );
      expect(out).toMatchObject({
        liveSubs: 1,
        multiLive: false,
        orphanSessions: 0,
        finding: false,
      });
    });

    it("two live subscriptions is a finding (the old never cancelled, the new never applied)", () => {
      const subs = [sub("sub_AAAA1111", "active"), sub("sub_BBBB2222", "trialing")];
      const out = call(
        `m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: ${JSON.stringify(subs)}, sessions: [] })`,
      );
      expect(out).toMatchObject({ liveSubs: 2, multiLive: true, finding: true });
    });

    it("a completed checkout whose subscription is not the stored one is an orphan; a live one is flagged", () => {
      const subs = [sub("sub_AAAA1111", "active"), sub("sub_BBBB2222", "active")];
      const sessions = [sess("sub_BBBB2222"), sess("sub_BBBB2222"), sess("sub_CCCC3333")];
      const out = call(
        `m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: ${JSON.stringify(subs)}, sessions: ${JSON.stringify(sessions)} })`,
      );
      // distinct subscriptions, not sessions: a redelivered checkout is one orphan
      expect(out).toMatchObject({ orphanSessions: 2, orphanStillLive: 1, finding: true });
    });

    it("a replaced, cancelled subscription still shows as an orphan but not as live", () => {
      const subs = [sub("sub_AAAA1111", "active"), sub("sub_OLD00009", "canceled")];
      const out = call(
        `m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: ${JSON.stringify(subs)}, sessions: [${JSON.stringify(sess("sub_OLD00009"))}] })`,
      );
      expect(out).toMatchObject({ orphanSessions: 1, orphanStillLive: 0, multiLive: false });
    });

    it("no stored subscription id: every completed checkout is an orphan and the tenant is flagged", () => {
      const out = call(
        `m.classifyTenant({ storedSubId: null, subs: [], sessions: [${JSON.stringify(sess("sub_AAAA1111"))}] })`,
      );
      expect(out).toMatchObject({ noStoredSub: true, orphanSessions: 1, finding: true });
    });

    it("a payment-mode session (no subscription) is never an orphan", () => {
      const out = call(
        `m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: [], sessions: [{ mode: "payment", subscription: null }] })`,
      );
      expect(out).toMatchObject({ orphanSessions: 0, finding: false });
    });

    it("a capped read cannot prove clean: it is a finding", () => {
      const out = call(
        `m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: [], sessions: [], capped: true })`,
      );
      expect(out).toMatchObject({ capped: true, finding: true });
    });
  });

  describe("report shape", () => {
    it("carries tenant ids and last-4 Stripe ids only: no slug, no full Stripe id, no amount", () => {
      const out = JSON.stringify(
        call(
          `m.buildReport([
            { tenantId: "t-1", slug: "acme", customerId: "cus_SECRET1234", result: m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: [{ id: "sub_AAAA1111", status: "active" }, { id: "sub_BBBB2222", status: "active" }], sessions: [{ mode: "subscription", subscription: "sub_BBBB2222", amount_total: 4900 }] }) },
            { tenantId: "t-2", slug: "qa-trial", customerId: "cus_TEST5678", result: m.classifyTenant({ storedSubId: "sub_CCCC3333", subs: [{ id: "sub_CCCC3333", status: "active" }], sessions: [] }) },
          ])`,
        ),
      );
      expect(out).not.toMatch(/acme|qa-trial|cus_|sub_AAAA|sub_BBBB|SECRET|4900/);
      expect(out).toMatch(/1111|2222/); // last 4 only
    });

    it("splits LIVE tenants from TEST tenants (test-tenants policy), and counts findings per side", () => {
      const rep = call(
        `m.buildReport([
          { tenantId: "t-1", slug: "acme", result: m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: [{ id: "sub_AAAA1111", status: "active" }, { id: "sub_BBBB2222", status: "active" }], sessions: [] }) },
          { tenantId: "t-2", slug: "qa-trial", result: m.classifyTenant({ storedSubId: "sub_CCCC3333", subs: [{ id: "sub_CCCC3333", status: "active" }], sessions: [] }) },
        ])`,
      ) as {
        live: { tenants: number; findings: number };
        test: { tenants: number; findings: number };
      };
      expect(rep.live).toMatchObject({ tenants: 1, findings: 1 });
      expect(rep.test).toMatchObject({ tenants: 1, findings: 0 });
    });

    it("exit code: 0 when clean, 3 on any finding", () => {
      expect(call(`m.exitCodeFor({ live: { findings: 0 }, test: { findings: 0 } })`)).toBe(0);
      expect(call(`m.exitCodeFor({ live: { findings: 1 }, test: { findings: 0 } })`)).toBe(3);
      expect(call(`m.exitCodeFor({ live: { findings: 0 }, test: { findings: 2 } })`)).toBe(3);
    });
  });
});

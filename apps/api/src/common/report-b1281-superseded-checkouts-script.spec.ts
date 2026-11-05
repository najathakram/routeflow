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

  // Class pin (review B note 1): EVERY `stripe.<resource>.<verb>(` call is a read. A list of write verbs misses the
  // next one Stripe adds (expire, resume, markUncollectible, attach, detach ...); the allow-list cannot.
  const READ_VERBS = new Set(["list", "retrieve"]);
  const stripeCalls = (code: string) =>
    [...code.matchAll(/\bstripe\.([\w.]+)\.(\w+)\s*\(/g)].map((m) => ({
      resource: m[1],
      verb: m[2],
    }));

  it("the call detector sees expire and resume, which the old write-verb list missed", () => {
    const probe = `await stripe.checkout.sessions.expire(id); await stripe.subscriptions.resume(id); await stripe.subscriptions.list({});`;
    expect(
      stripeCalls(probe)
        .filter((c) => !READ_VERBS.has(c.verb))
        .map((c) => c.verb),
    ).toEqual(["expire", "resume"]);
  });

  it("reaches Stripe only through read calls (class pin: every stripe call is list or retrieve)", () => {
    const calls = stripeCalls(codeLines().join("\n"));
    expect(calls.length).toBeGreaterThan(0); // not vacuous
    expect(calls.filter((c) => !READ_VERBS.has(c.verb))).toEqual([]);
    // and the only resources it names are the two it needs
    expect([...new Set(calls.map((c) => c.resource))].sort()).toEqual([
      "checkout.sessions",
      "subscriptions",
    ]);
  });

  it("uses the app's Stripe API version and the app's live-status set (no drift)", () => {
    const version = /STRIPE_API_VERSION = "([^"]+)"/.exec(periodSource)![1];
    expect(source).toContain(`"${version}"`);
    const set = /LIVE_SUBSCRIPTION_STATUSES[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(periodSource)![1];
    const appStatuses = [...set.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(call("[...m.LIVE_STATUSES].sort()")).toEqual(appStatuses);
  });

  // D-4 (SA-1103 A-1): "which Stripe status means what" has ONE home, stripe-period.ts; the script cannot import it,
  // so both of its lists are pinned equal to the app's by reading the app's source (the report-noop-addons pattern).
  it("D-4: the live AND terminal status lists equal stripe-period.ts's (a status added there turns this red)", () => {
    const live = /LIVE_SUBSCRIPTION_STATUSES[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(periodSource)![1];
    const terminal = /isTerminalStripeSubscriptionStatus\s*=[^;]*;/.exec(periodSource)![0];
    const words = (s: string) => [...s.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(call("[...m.LIVE_STATUSES].sort()")).toEqual(words(live));
    expect(call("[...m.TERMINAL_STATUSES].sort()")).toEqual(words(terminal));
    expect(words(terminal)).toEqual(["canceled", "incomplete_expired"]); // not vacuous
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

    it("D-1: a deleted business with ONE live subscription is a finding in its own class", () => {
      const out = call(
        `m.classifyTenant({ deleted: true, storedSubId: "sub_AAAA1111", subs: [${JSON.stringify(sub("sub_AAAA1111", "active"))}], sessions: [] })`,
      );
      expect(out).toMatchObject({ deleted: true, deletedStillBilling: true, finding: true });
      // the same subscription on a business that still exists is clean
      expect(
        call(
          `m.classifyTenant({ deleted: false, storedSubId: "sub_AAAA1111", subs: [${JSON.stringify(sub("sub_AAAA1111", "active"))}], sessions: [] })`,
        ),
      ).toMatchObject({ deletedStillBilling: false, finding: false });
      // a deleted business whose subscription is already cancelled is not still billing
      expect(
        call(
          `m.classifyTenant({ deleted: true, storedSubId: "sub_AAAA1111", subs: [${JSON.stringify(sub("sub_AAAA1111", "canceled"))}], sessions: [] })`,
        ),
      ).toMatchObject({ deletedStillBilling: false, finding: false });
    });

    it("D-2: a paused superseded subscription with a completed checkout in the window is Revivable, superseded", () => {
      const subs = [sub("sub_AAAA1111", "active"), sub("sub_PAUS0009", "paused")];
      const out = call(
        `m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: ${JSON.stringify(subs)}, sessions: [${JSON.stringify(sess("sub_PAUS0009"))}] })`,
      );
      expect(out).toMatchObject({
        revivableSuperseded: 1,
        revivableSub4: ["0009"],
        multiLive: false,
        finding: true,
      });
      // incomplete is revivable too (the failed handler would have cancelled it)
      const inc = [sub("sub_AAAA1111", "active"), sub("sub_INCO0007", "incomplete")];
      expect(
        call(
          `m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: ${JSON.stringify(inc)}, sessions: [${JSON.stringify(sess("sub_INCO0007"))}] })`,
        ),
      ).toMatchObject({ revivableSuperseded: 1, orphanStillLive: 0 });
    });

    it("D-3: an incomplete_expired (terminal) superseded subscription is not listed as revivable", () => {
      const subs = [sub("sub_AAAA1111", "active"), sub("sub_DEAD0005", "incomplete_expired")];
      const out = call(
        `m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: ${JSON.stringify(subs)}, sessions: [${JSON.stringify(sess("sub_DEAD0005"))}] })`,
      );
      expect(out).toMatchObject({ revivableSuperseded: 0, revivableSub4: [] });
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

    it("a rethrown Stripe error carries the last 4 of any Stripe id, never a full id or the key (review B note 2)", () => {
      const msg =
        "No such customer: 'cus_QwErTy123456'; sub_AbCdEf987654 in acct_1AbCdEfGhIjKlMn failed with key sk_live_SeCrEtKeY0123 (pi_3PqRsTuV456789)";
      const out = call(
        `m.scrubStripeError(${JSON.stringify(msg)}, "sk_live_SeCrEtKeY0123")`,
      ) as string;
      expect(out).not.toMatch(
        /QwErTy123456|AbCdEf987654|1AbCdEfGhIjKlMn|SeCrEtKeY0123|3PqRsTuV456789/,
      );
      expect(out).toMatch(/cus_…3456/);
      expect(out).toMatch(/sub_…7654/);
      expect(out).toMatch(/acct_…KlMn/);
      expect(out).toMatch(/pi_…6789/);
      expect(out).toContain("No such customer"); // the words survive
    });

    it("prints the deleted column and the two A-1 sections, ids only (D-1, D-2)", () => {
      const lines = (
        call(
          `m.formatReport(m.buildReport([
            { tenantId: "t-del", slug: "acme", result: m.classifyTenant({ deleted: true, storedSubId: "sub_AAAA1111", subs: [{ id: "sub_AAAA1111", status: "active" }], sessions: [] }) },
            { tenantId: "t-rev", slug: "globex", result: m.classifyTenant({ storedSubId: "sub_BBBB2222", subs: [{ id: "sub_BBBB2222", status: "active" }, { id: "sub_PAUS0009", status: "paused" }], sessions: [{ mode: "subscription", subscription: "sub_PAUS0009" }] }) },
          ]))`,
        ) as string[]
      ).join("\n");
      expect(lines).toMatch(/Deleted business, still billing:[^\n]*t-del/);
      expect(lines).toMatch(/Revivable, superseded:[^\n]*t-rev[^\n]*0009/);
      expect(lines).toMatch(/tenant t-del:[^\n]*deleted yes/);
      expect(lines).toMatch(/tenant t-rev:[^\n]*deleted no/);
      expect(lines).not.toMatch(/acme|globex|sub_|cus_/);
    });

    it("the exit code follows LIVE findings only: a TEST-only finding exits 0 and the LIVE line says so (SA-1103, read A M2)", () => {
      const rep = (slug: string) => `m.buildReport([
        { tenantId: "t-1", slug: "${slug}", result: m.classifyTenant({ storedSubId: "sub_AAAA1111", subs: [{ id: "sub_AAAA1111", status: "active" }, { id: "sub_BBBB2222", status: "active" }], sessions: [] }) },
      ])`;
      expect(call(`m.exitCodeFor(${rep("qa-trial")})`)).toBe(0);
      expect(call(`m.exitCodeFor(${rep("acme")})`)).toBe(3);
    });

    it("prints a separate LIVE findings line (review B note 4)", () => {
      const liveSub = `{ storedSubId: "sub_AAAA1111", subs: [{ id: "sub_AAAA1111", status: "active" }], sessions: [] }`;
      const dirty = `{ storedSubId: "sub_AAAA1111", subs: [{ id: "sub_AAAA1111", status: "active" }, { id: "sub_BBBB2222", status: "active" }], sessions: [] }`;
      const testOnly = `m.buildReport([
        { tenantId: "t-1", slug: "acme", result: m.classifyTenant(${liveSub}) },
        { tenantId: "t-2", slug: "qa-trial", result: m.classifyTenant(${dirty}) },
      ])`;
      const lines = call(`m.formatReport(${testOnly})`) as string[];
      expect(lines.filter((l) => l.startsWith("LIVE FINDINGS:"))).toEqual([
        "LIVE FINDINGS: 0 (the exit code is 3 when this is above 0; TEST findings are printed but never change it)",
      ]);
      expect(lines[lines.length - 1]).toMatch(/^LIVE FINDINGS: 0 /); // it ends the report
      expect(call(`m.exitCodeFor(${testOnly})`)).toBe(0);
      const liveDirty = `m.buildReport([{ tenantId: "t-1", slug: "acme", result: m.classifyTenant(${dirty}) }])`;
      expect((call(`m.formatReport(${liveDirty})`) as string[]).join("\n")).toMatch(
        /LIVE FINDINGS: 1 /,
      );
    });

    it("the header says a non-live orphan is a finding (review B note 6)", () => {
      expect(source).not.toMatch(/only counted/);
      expect(source).toMatch(/non-live orphan[^.]*finding/i);
    });

    it("exit code: 0 when LIVE is clean (whatever TEST holds), 3 on any LIVE finding", () => {
      expect(call(`m.exitCodeFor({ live: { findings: 0 }, test: { findings: 0 } })`)).toBe(0);
      expect(call(`m.exitCodeFor({ live: { findings: 1 }, test: { findings: 0 } })`)).toBe(3);
      expect(call(`m.exitCodeFor({ live: { findings: 0 }, test: { findings: 2 } })`)).toBe(0);
    });
  });
});

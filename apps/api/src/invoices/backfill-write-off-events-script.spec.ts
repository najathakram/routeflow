import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { InvoiceStatus } from "@prisma/client";
import { applyWriteOffBackfill, planWriteOffBackfill } from "./invoice-write-off-backfill";

/**
 * SA-1050 PR-1 (review-b note 3): contract for `apps/api/scripts/backfill-write-off-events.mjs`, the write-off ledger backfill.
 * No database. The refusals run the REAL CLI as a child process (they exit before any query), the protected-tenant hold runs the
 * guard the CLI filters through, and "a rerun writes 0" runs the plan and the writer on in-memory fakes; the read -> write round
 * trip on real Postgres is `invoice-write-off-backfill.db.spec.ts`. What must never regress: `--apply` with no tenant needs the
 * live override; a non-test tenant needs the exact id typed back; a protected tenant is held, never written; a rerun writes 0.
 */
const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-write-off-events.mjs");
const CLI_HREF = pathToFileURL(CLI).href;
const GUARD_HREF = pathToFileURL(path.resolve(API_DIR, "scripts/lib/live-target-guard.cjs")).href;
const ENV = { DATABASE_URL: "postgres://u:p@localhost:1/none", PROTECTED_TENANT_SLUGS: "" };

function evalModule(body: string): any {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    encoding: "utf8",
    env: { ...process.env, ...ENV },
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`shim exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function cli(...args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...ENV },
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("the argument parsers", () => {
  const parse = (fn: string, argv: string[]) =>
    evalModule(
      `import { ${fn} } from "${CLI_HREF}";
       let out; try { out = { ok: ${fn}(${JSON.stringify(argv)}) ?? null }; } catch (e) { out = { err: e.message }; }
       console.log(JSON.stringify(out));`,
    );

  it("--tenant-id needs a value and may be given once", () => {
    expect(parse("parseTenantId", ["--apply", "--tenant-id", "t1"])).toEqual({ ok: "t1" });
    expect(parse("parseTenantId", ["--apply"])).toEqual({ ok: null });
    expect(parse("parseTenantId", ["--tenant-id"]).err).toMatch(/requires a non-empty value/);
    expect(parse("parseTenantId", ["--tenant-id", "--apply"]).err).toMatch(/non-empty value/);
    expect(parse("parseTenantId", ["--tenant-id", "a", "--tenant-id", "b"]).err).toMatch(
      /only once/,
    );
  });

  it("--confirm-tenant-id is the = form only", () => {
    expect(parse("parseConfirmTenantId", ["--confirm-tenant-id=t1"])).toEqual({ ok: "t1" });
    expect(parse("parseConfirmTenantId", ["--confirm-tenant-id", "t1"])).toEqual({ ok: null });
  });
});

describe("the CLI refusals exit 1 before any query or build", () => {
  it("--apply with no --tenant-id and no --live-tenant-override refuses and writes nothing", () => {
    const { status, out } = cli("--apply");
    expect(status).toBe(1);
    expect(out).toMatch(/--live-tenant-override/);
    expect(out).toMatch(/Nothing was written/);
  });

  it("a malformed --tenant-id refuses", () => {
    expect(cli("--apply", "--tenant-id").status).toBe(1);
    expect(cli("--tenant-id", "a", "--tenant-id", "b").status).toBe(1);
  });
});

describe("the CLI source: dry run by default, live gates, protected hold, one writer", () => {
  const script: string = readFileSync(CLI, "utf8");

  it("writes only under --apply (the dry run returns before the writer)", () => {
    expect(script).toContain('process.argv.includes("--apply")');
    const dryExit = script.indexOf("Dry run only");
    expect(dryExit).toBeGreaterThan(-1);
    expect(script.indexOf("await mod.applyWriteOffBackfill(")).toBeGreaterThan(dryExit);
  });

  it("a non-test tenant needs --live-tenant-override AND the exact id typed back", () => {
    expect(script).toContain(
      "!isTestTenant(tenant.slug) && (!liveOverride || confirmTenantId !== tenantId)",
    );
    expect(script).toMatch(/--confirm-tenant-id=\$\{tenantId\}/);
    expect(script).toContain("Nothing was written");
  });

  it("an all-tenants apply filters through filterWritableTenants BEFORE it writes, with the protected slugs it dials with", () => {
    const filter = script.indexOf("filterWritableTenants(withRows");
    const write = script.indexOf("await mod.applyWriteOffBackfill(");
    expect(filter).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(filter);
    expect(script).toContain("loadProtectedSlugs(process.env, databaseUrl)");
    expect(script).toMatch(/held: protected tenant, run per tenant with --allow-protected/);
  });

  it("a single protected tenant needs the TTY override (confirmProtectedOverride + assertWritableTenant)", () => {
    expect(script).toContain("confirmProtectedOverride(");
    expect(script).toContain("assertWritableTenant(");
  });

  it("runs no SQL of its own: the one writer is ensureWriteOffEvent through the service module", () => {
    expect(script).not.toMatch(/\$executeRaw|\$queryRaw|\bUPDATE\b|\bINSERT\b|\bDELETE\b/);
    expect(script).toContain("invoice-write-off-backfill.js");
  });
});

describe("the protected-tenant hold in the all-tenants path", () => {
  const held = (extra: string): any =>
    evalModule(`
      import guard from "${GUARD_HREF}";
      const tenants = [
        { id: "t-listed", slug: "acme-listed", status: "TRIAL", class: "STANDARD", deletedAt: null },
        { id: "t-open", slug: "acme-open", status: "TRIAL", class: "STANDARD", deletedAt: null },
      ];
      ${extra}
      const logs = [];
      const { writable } = guard.filterWritableTenants(tenants, subs, new Set(["acme-listed"]), { log: (l) => logs.push(l) });
      console.log(JSON.stringify({ writable: writable.map((t) => t.id), logs }));
    `);

  it("an env-listed tenant is held, an unprotected one is written, and no slug reaches the log", () => {
    const out = held("const subs = new Map();");
    expect(out.writable).toEqual(["t-open"]);
    expect(out.logs.join(" ")).toMatch(/skipped 1 of 2/);
    expect(JSON.stringify(out.logs)).not.toContain("acme-listed");
  });

  it("a Stripe-linked tenant is held too", () => {
    const out = held(
      'const subs = new Map([["t-open", { planKey: "STARTER", stripeSubId: "sub_x", couponFull: false }]]);',
    );
    expect(out.writable).toEqual([]);
  });
});

describe("a rerun writes 0", () => {
  const invoice = (events: Array<{ id: string }>) => ({
    id: "inv-1",
    tenantId: "t1",
    total: 107,
    taxAmount: 7,
    writtenOffAt: new Date("2026-10-15T12:00:00.000Z"),
    writeOffEvents: events,
    payments: [],
  });
  const dbOf = (rows: any[], tx?: any) => ({
    invoice: { findMany: jest.fn().mockResolvedValue(rows) },
    $transaction: jest.fn(async (fn: (t: any) => Promise<any>) => fn(tx)),
  });

  it("the plan picks an unevented write-off and skips one that already has its event", async () => {
    expect((await planWriteOffBackfill(dbOf([invoice([])]))).invoiceIds).toEqual(["inv-1"]);
    const rerun = await planWriteOffBackfill(dbOf([invoice([{ id: "ev-1" }])]));
    expect(rerun.invoiceIds).toEqual([]);
    expect(rerun.scanned).toBe(1);
  });

  it("the writer skips an invoice that already has an event: nothing is created", async () => {
    const create = jest.fn();
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      invoice: {
        findUnique: jest.fn().mockResolvedValue({
          id: "inv-1",
          orderId: null,
          tenantId: "t1",
          status: InvoiceStatus.WRITTEN_OFF,
          total: 107,
          taxAmount: 7,
          payments: [],
        }),
      },
      invoiceWriteOffEvent: {
        findFirst: jest.fn().mockResolvedValue({ id: "ev-1" }),
        create,
      },
    };
    const res = await applyWriteOffBackfill(dbOf([], tx), ["inv-1"]);
    expect(res).toEqual({ written: 0, skipped: 1, failed: [] });
    expect(create).not.toHaveBeenCalled();
  });
});

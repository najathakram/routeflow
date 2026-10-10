import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * #2500 (SA-481, option B hardened) — apps/api/scripts/wipe-tenant-fresh-start.js resolves its
 * database ONCE (scripts/lib/fresh-start-target.mjs), and that same URL feeds the pg Pool, the
 * redacted "DB:" banner and the guard. The defect this pins: the script used to dial
 * `DATABASE_PUBLIC_URL || DATABASE_URL` while the banner printed `DATABASE_URL`, so an operator could
 * confirm one database and wipe another.
 *
 * Nothing here reaches a database: refusals happen before any dial, and the two end-to-end cases
 * point the resolved target at 127.0.0.1:1 (nothing listens), so the only thing that can happen is
 * Prisma's "Can't reach database server at <host>" NAMING the host that was dialled — which must
 * be the banner's host.
 */

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(API_DIR, "scripts", "wipe-tenant-fresh-start.js");
const LIB_HREF = pathToFileURL(path.join(API_DIR, "scripts", "lib", "fresh-start-target.mjs")).href;

const PROXY = {
  POSTGRES_USER: "u",
  POSTGRES_PASSWORD: "p",
  POSTGRES_DB: "railway",
  RAILWAY_TCP_PROXY_DOMAIN: "127.0.0.1",
  RAILWAY_TCP_PROXY_PORT: "1",
};

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("DATABASE_") ||
      key.startsWith("RAILWAY_") ||
      key.startsWith("POSTGRES_") ||
      key.startsWith("PG") ||
      key === "NODE_ENV"
    )
      delete env[key];
  }
  return { ...env, ...extra };
}

function run(args: string[], extra: Record<string, string>) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: cleanEnv(extra),
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const PLAN_CASES = `
import * as t from "${LIB_HREF}";
const redact = (u) => "R(" + u + ")";
const local = (url) => url.includes("localhost") ? { ok: true, config: { host: "localhost", url } } : { ok: false, reason: "not local" };
const resolve = (env, { requireProxy }) => {
  if (env.PROXY) return "postgresql://proxy-host/db";
  if (requireProxy) throw new Error("Missing Railway proxy variables");
  if (env.DATABASE_URL) return env.DATABASE_URL;
  throw new Error("No DATABASE_URL");
};
const deps = { resolve, redact, classifyLocal: local, isTestTenant: (s) => s.startsWith("e2e-") };
const plan = (argv, env) => t.planFreshStart(t.parseFreshStartArgs(argv), env, deps);
console.log(JSON.stringify({
  parse: [
    t.parseFreshStartArgs(["acme", "--live-tenant-override", "--exclude-tenant", "big,huge", "--exclude-tenant", "big"]),
    t.parseFreshStartArgs(["acme", "--nope"]),
    t.parseFreshStartArgs(["acme", "other"]),
    t.parseFreshStartArgs(["acme", "--exclude-tenant"]),
    t.parseFreshStartArgs(["acme", "--exclude-tenant", "a,"]),
  ],
  localOk: plan(["e2e-x", "--local"], { DATABASE_URL: "postgresql://u:p@localhost:5432/dev" }),
  localProxy: plan(["e2e-x", "--local"], { PROXY: "1", DATABASE_URL: "postgresql://u:p@localhost:5432/dev" }),
  localRemote: plan(["e2e-x", "--local"], { DATABASE_URL: "postgresql://u:p@db.example.com/x" }),
  localLive: plan(["acme", "--local"], { DATABASE_URL: "postgresql://u:p@localhost:5432/dev" }),
  liveOk: plan(["acme", "--live-tenant-override", "--exclude-tenant", "big"], { PROXY: "1", DATABASE_URL: "postgresql://decoy/x" }),
  liveNoProxy: plan(["acme", "--live-tenant-override", "--exclude-tenant", "big"], { DATABASE_URL: "postgresql://decoy/x" }),
  liveNoExclude: plan(["acme", "--live-tenant-override"], { PROXY: "1" }),
  liveTest: plan(["e2e-x", "--live-tenant-override", "--exclude-tenant", "big"], { PROXY: "1" }),
  liveNoBackup: plan(["acme", "--live-tenant-override", "--exclude-tenant", "big", "--execute"], { PROXY: "1" }),
  liveBackup: plan(["acme", "--live-tenant-override", "--exclude-tenant", "big", "--execute", "--backup-taken"], { PROXY: "1" }),
  excludedLocal: plan(["e2e-x", "--local", "--exclude-tenant", "e2e-x"], { DATABASE_URL: "postgresql://u:p@localhost:5432/dev" }),
  excludedLive: plan(["big", "--live-tenant-override", "--exclude-tenant", "big"], { PROXY: "1" }),
  noPath: plan(["acme"], {}),
  bothPaths: plan(["acme", "--local", "--live-tenant-override"], {}),
  noSlug: plan([], {}),
  excl: (() => {
    const tenant = { id: "t-acme", slug: "acme", name: "Acme" };
    const found = [{ id: "t-big", slug: "big", name: "Big Co" }];
    return {
      ok: t.checkExcludedTenants({ exclude: ["big"], found, tenant }),
      typo: t.checkExcludedTenants({ exclude: ["big", "acmee"], found, tenant }),
      caseVariant: t.checkExcludedTenants({ exclude: ["BIG"], found: [], tenant }),
      targetById: t.checkExcludedTenants({ exclude: ["alias"], found: [{ id: "t-acme", slug: "alias", name: "Acme" }], tenant }),
      none: t.checkExcludedTenants({ exclude: [], found: [], tenant }),
    };
  })(),
}));
`;

describe("fresh-start target planner (#2500)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: any;
  beforeAll(() => {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", PLAN_CASES], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.stderr).toBe("");
    r = JSON.parse(res.stdout.trim());
  });

  it("parses argv strictly", () => {
    expect(r.parse[0]).toMatchObject({ slug: "acme", live: true, exclude: ["big", "huge"] });
    expect(r.parse[1].error).toMatch(/unknown argument: --nope/);
    expect(r.parse[2].error).toMatch(/unexpected second tenant slug/);
    expect(r.parse[3].error).toMatch(/--exclude-tenant needs a value/);
    expect(r.parse[4].error).toMatch(/empty slug/);
  });

  it("the banner, the Pool and the guard all come from the ONE resolved URL", () => {
    expect(r.localOk).toEqual({
      ok: true,
      url: "postgresql://u:p@localhost:5432/dev",
      source: "local",
      banner: "DB:     R(postgresql://u:p@localhost:5432/dev)  (source: local)",
      poolConfig: { host: "localhost", url: "postgresql://u:p@localhost:5432/dev" },
    });
    expect(r.liveOk).toEqual({
      ok: true,
      url: "postgresql://proxy-host/db",
      source: "Railway proxy",
      banner: "DB:     R(postgresql://proxy-host/db)  (source: Railway proxy)",
      poolConfig: { connectionString: "postgresql://proxy-host/db" },
      backupCommand:
        "railway run --service postgres node apps/api/scripts/backup-production.mjs pre-fresh-start-live",
    });
  });

  it("--local refuses a proxy URL and any non-local target before dialing", () => {
    expect(r.localProxy).toMatchObject({ ok: false, exit: 1 });
    expect(r.localProxy.reason).toMatch(
      /--local refuses this target \(R\(postgresql:\/\/proxy-host\/db\)\)/,
    );
    expect(r.localRemote.reason).toMatch(/--local refuses this target/);
  });

  it("--local wipes test tenants only; the live path refuses test tenants", () => {
    expect(r.localLive.reason).toMatch(/--local wipes approved test tenants only/);
    expect(r.liveTest.reason).toMatch(/is a test tenant: wipe it with --local/);
  });

  it("the live path dials the Railway proxy only, never a stray DATABASE_URL", () => {
    expect(r.liveNoProxy).toMatchObject({ ok: false, exit: 1 });
    expect(r.liveNoProxy.reason).toMatch(/Railway proxy only: Missing Railway proxy variables/);
    expect(JSON.stringify(r.liveOk)).not.toContain("decoy");
  });

  it("the live path needs the owner's exclusion list, and --execute needs --backup-taken", () => {
    expect(r.liveNoExclude.reason).toMatch(/needs --exclude-tenant/);
    expect(r.liveNoBackup.reason).toMatch(/needs --backup-taken/);
    expect(r.liveNoBackup.reason).toContain(
      "railway run --service postgres node apps/api/scripts/backup-production.mjs pre-fresh-start-live",
    );
    expect(r.liveBackup.ok).toBe(true);
  });

  it("an excluded tenant is refused in both modes", () => {
    expect(r.excludedLocal.reason).toMatch(/on the --exclude-tenant list: it is never wiped/);
    expect(r.excludedLive.reason).toMatch(/on the --exclude-tenant list: it is never wiped/);
  });

  it("every excluded slug must resolve to a tenant: a typo or case variant aborts (fails closed)", () => {
    // SA-547b: ids only — never the business name (a client identifier).
    expect(r.excl.ok).toEqual({ ok: true, lines: ["EXCLUDED (never wiped): tenant t-big"] });
    expect(r.excl.typo).toMatchObject({ ok: false });
    expect(r.excl.typo.reason).toMatch(/--exclude-tenant names no tenant: acmee/);
    expect(r.excl.caseVariant.reason).toMatch(/names no tenant: BIG/);
    expect(r.excl.none).toEqual({ ok: true, lines: [] });
  });

  it("the target is refused when its tenant id is in the resolved exclusion set", () => {
    expect(r.excl.targetById).toMatchObject({ ok: false });
    expect(r.excl.targetById.reason).toMatch(/tenant t-acme is excluded: it is never wiped/);
    expect(r.excl.targetById.reason).not.toMatch(/Acme/);
  });

  it("no path flag, both path flags and no slug are usage errors (exit 2)", () => {
    for (const k of ["noPath", "bothPaths", "noSlug"])
      expect(r[k]).toMatchObject({ ok: false, exit: 2 });
  });
});

describe("wipe-tenant-fresh-start.js (#2500), real script, no database", () => {
  it.each([
    [[], 2, /missing tenant slug/],
    [["e2e-x"], 2, /choose a path/],
    [["e2e-x", "--nope"], 2, /unknown argument: --nope/],
    [["acme", "--local"], 1, /--local wipes approved test tenants only/],
    [["e2e-x", "--local"], 1, /--local refuses this target .*db\.example\.com/],
    [["acme", "--live-tenant-override", "--exclude-tenant", "big"], 1, /Railway proxy only/],
    [["big", "--live-tenant-override", "--exclude-tenant", "big"], 1, /never wiped, in any mode/],
  ])("%j exits %i before dialing", (args, code, message) => {
    const r = run(args as string[], { DATABASE_URL: "postgresql://u:p@db.example.com:5432/x" });
    expect(r.status).toBe(code);
    expect(r.out).toMatch(message as RegExp);
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/);
  });

  it("--local: the banner names exactly the host that is dialled", () => {
    const r = run(["e2e-x", "--local"], {
      DATABASE_URL: "postgresql://u:secret@127.0.0.1:1/devdb",
    });
    expect(r.out).toMatch(
      /DB:\s+postgresql:\/\/u:\*\*\*@127\.0\.0\.1:1\/devdb\s+\(source: local\)/,
    );
    expect(r.out).not.toContain("secret");
    expect(r.out).toMatch(/Can't reach database server at 127\.0\.0\.1:1\b/);
    expect(r.status).toBe(99);
  });

  it("the live path: the banner names the proxy it dials, never the decoy DATABASE_URL", () => {
    const r = run(["acme", "--live-tenant-override", "--exclude-tenant", "big"], {
      ...PROXY,
      DATABASE_URL: "postgresql://u:p@127.0.0.1:2/decoy",
      DATABASE_PUBLIC_URL: "postgresql://u:p@127.0.0.1:3/decoy",
    });
    expect(r.out).toMatch(
      /DB:\s+postgresql:\/\/u:\*\*\*@127\.0\.0\.1:1\/railway\s+\(source: Railway proxy\)/,
    );
    expect(r.out).toMatch(/Can't reach database server at 127\.0\.0\.1:1\b/);
    expect(r.out).not.toMatch(/127\.0\.0\.1:[23]|decoy/);
    expect(r.status).toBe(99);
  });

  it("source pin: exclusions resolve with the same client after getTenant() and BEFORE the counts", () => {
    const code = readFileSync(SCRIPT, "utf8");
    const at = (needle: string) => {
      const i = code.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const tenant = at("const tenant = await getTenant();");
    const lookup = code.search(
      /prisma\.tenant\.findMany\(\{\s*where: \{ slug: \{ in: args\.exclude \} \}/,
    );
    expect(lookup).toBeGreaterThan(-1);
    const check = at("checkExcludedTenants({");
    const counts = at("const rows = await countAll(tenant.id);");
    expect(tenant).toBeLessThan(lookup);
    expect(lookup).toBeLessThan(check);
    expect(check).toBeLessThan(counts);
  });

  it("source pin: the script reads no DATABASE_* variable and builds its one Pool from the plan", () => {
    const code = readFileSync(SCRIPT, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/DATABASE_(PUBLIC_)?URL/);
    expect(code.match(/new Pool\(/g)).toHaveLength(1);
    expect(code).toContain("new Pool(target.poolConfig)");
    expect(code).toContain("console.log(`\\n${target.banner}`)");
  });

  it("source pin (SA-594): recipeComponent < recipe < product in NUKE_MODELS (RESTRICT FKs into Product)", () => {
    const code = readFileSync(SCRIPT, "utf8");
    const body = /const NUKE_MODELS = \[([\s\S]*?)\n\];/.exec(code)?.[1] ?? "";
    const names = [...body.replace(/\/\/.*$/gm, "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
    const at = (n: string) => {
      expect(names.filter((x) => x === n)).toHaveLength(1);
      return names.indexOf(n);
    };
    expect(at("recipeComponent")).toBeLessThan(at("recipe"));
    expect(at("recipe")).toBeLessThan(at("product"));
  });
});

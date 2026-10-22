import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AuditInterceptor } from "../audit/audit.interceptor";

/**
 * Contract for `apps/api/scripts/report-operator-account-blast-radius.mjs` and its pure layer
 * `apps/api/scripts/lib/operator-account-blast-radius.mjs` (test harness for the admin-only
 * endpoints: a read-only, counts-only usage report).
 *
 * No database is touched. The pure module is ESM and this suite runs under ts-jest's CommonJS
 * transform, so the mapping/aggregation cases are evaluated in ONE `node --input-type=module`
 * child that imports the real module by `file://` URL and prints JSON (same shape as
 * backfill-check-dates-script.spec.ts). The handler list is also pinned against the controller
 * SOURCES, so it cannot drift from the code silently.
 */

const API_DIR = path.resolve(__dirname, "../..");
const SRC_DIR = path.resolve(API_DIR, "src");
const SCRIPT = path.resolve(API_DIR, "scripts/report-operator-account-blast-radius.mjs");
const LIB_HREF = pathToFileURL(
  path.resolve(API_DIR, "scripts/lib/operator-account-blast-radius.mjs"),
).href;

interface Handler {
  id: string;
  httpMethod: string;
  route: string;
  controller: string;
  method: string;
  nonSelfOnly: boolean;
  audited: boolean;
}

function evalLib<T>(body: string): T {
  const code = `import * as lib from ${JSON.stringify(LIB_HREF)};\n${body}`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: API_DIR,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`child failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as T;
}

const handlers = evalLib<Handler[]>("console.log(JSON.stringify(lib.CLOSED_HANDLERS));");

/** Controller base path per source file (the `@Controller(...)` argument). */
const BASE: Record<string, string> = {
  "users/users.controller.ts": "/users",
  "stripe-connect/stripe-connect.controller.ts": "/settings/stripe-connect",
  "import/import.controller.ts": "/import",
  "import/migration.controller.ts": "/import/migration",
  "import/numbering.controller.ts": "/import/numbering",
  "billing/settings-billing.controller.ts": "/billing",
  "system-config/settings.controller.ts": "/settings",
  "crm/crm.controller.ts": "/crm/gohighlevel",
  "customers/customers.controller.ts": "/customers",
  "products/products.controller.ts": "/products",
};

function cap(httpMethod: string): string {
  return httpMethod[0] + httpMethod.slice(1).toLowerCase();
}

describe("closed handler list (pinned against the controller sources)", () => {
  it.each(Object.entries(BASE))(
    "%s: BASE matches the first @Controller(...) argument",
    (file, base) => {
      const source = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
      const m = source.match(/@Controller\(\s*(\[\s*)?"([^"]+)"/);
      expect(m).not.toBeNull();
      expect(`/${m![2]}`).toBe(base);
    },
  );

  it("has unique ids and unique method+route pairs", () => {
    expect(new Set(handlers.map((x) => x.id)).size).toBe(handlers.length);
    expect(new Set(handlers.map((x) => `${x.httpMethod} ${x.route}`)).size).toBe(handlers.length);
  });

  it("pins the verified count: 53 handlers + the non-self user update", () => {
    const withoutUpdate = handlers.filter((x) => x.id !== "users.update");
    expect(withoutUpdate).toHaveLength(53);
    expect(handlers).toHaveLength(54);
    // Mutations leave an AuditLog row; the 12 GETs cannot be counted.
    expect(handlers.filter((x) => x.audited)).toHaveLength(42);
    expect(handlers.filter((x) => !x.audited).map((x) => x.httpMethod)).toEqual(
      Array(12).fill("GET"),
    );
  });

  it.each(handlers.map((x) => [x.id, x] as const))(
    "%s is declared by its controller with that method and route",
    (_id, handler) => {
      const base = BASE[handler.controller];
      expect(base).toBeDefined();
      expect(handler.route.startsWith(base)).toBe(true);
      const sub = handler.route.slice(base.length).replace(/^\//, "");
      const source = fs.readFileSync(path.join(SRC_DIR, handler.controller), "utf8");
      const arg = sub === "" ? "" : `"${sub}"`;
      const decorator = `@${cap(handler.httpMethod)}(${arg})`;
      // The decorator, then (other decorators allowed) the handler method name, before the next
      // route decorator begins.
      const at = source.indexOf(decorator);
      expect(at).toBeGreaterThanOrEqual(0);
      const tail = source.slice(at + decorator.length);
      const next = tail.search(/\n {2}@(Get|Post|Put|Patch|Delete)\(/);
      const window = next < 0 ? tail : tail.slice(0, next);
      expect(window).toMatch(new RegExp(`\\n {2}(async )?${handler.method}\\(`));
    },
  );

  it.each([
    ["import/import.controller.ts", 14],
    ["import/migration.controller.ts", 6],
    ["import/numbering.controller.ts", 3],
  ])("%s: every handler in the controller is on the list (%i)", (file, count) => {
    const source = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
    const declared = (source.match(/\n {2}@(Get|Post|Put|Patch|Delete)\(/g) ?? []).length;
    expect(declared).toBe(count);
    expect(handlers.filter((x) => x.controller === file)).toHaveLength(count);
  });
});

describe("classifyAction / buildActionRegex", () => {
  it("maps every traceable handler's own audit action back to its id, and the regex accepts it", () => {
    const out = evalLib<Array<{ id: string; action: string; got: string | null; re: boolean }>>(`
      const re = new RegExp(lib.buildActionRegex());
      const rows = lib.traceableHandlers().map((h) => {
        const path = h.route.replace(/:[A-Za-z]+/g, "abc-123");
        const action = h.httpMethod + " " + path;
        return { id: h.id, action, got: lib.classifyAction(action), re: re.test(action) };
      });
      console.log(JSON.stringify(rows));
    `);
    expect(out).toHaveLength(42);
    for (const r of out) {
      expect({ id: r.id, got: r.got, re: r.re }).toEqual({ id: r.id, got: r.id, re: true });
    }
  });

  it("recognises the tenant/settings alias of the settings controller", () => {
    const got = evalLib<Array<string | null>>(`
      console.log(JSON.stringify([
        lib.classifyAction("POST /tenant/settings/email/test"),
        lib.classifyAction("PATCH /tenant/settings/anthropic"),
        lib.classifyAction("DELETE /tenant/settings/email/domain"),
      ]));
    `);
    expect(got).toEqual([
      "settings.testEmailSettings",
      "settings.updateAnthropicSettings",
      "settings.removeSendingDomain",
    ]);
  });

  it("does NOT claim open routes that merely resemble a closed one", () => {
    const got = evalLib<Array<{ action: string; id: string | null; re: boolean }>>(`
      const re = new RegExp(lib.buildActionRegex());
      const actions = [
        "PATCH /users/me/preferences",
        "POST /settings/email/mailbox/google/start",
        "POST /settings/email/mailbox/confirm",
        "DELETE /settings/email/mailbox",
        "DELETE /customers/3b1f",
        "POST /customers/batch-delete",
        "PATCH /customers/all",
        "GET /customers/all",
        "POST /products/clear-all",
        "POST /import/batch",
        "GET /import/aliases",
        "POST /import/resolution/match",
        "PATCH /settings/invoice",
        "DELETE /settings/financial-data",
        "POST /billing/subscribe",
        "GET /settings/stripe-connect/callback",
        "POST /crm/gohighlevel/sync",
        "POST /users",
        "garbage",
      ];
      console.log(JSON.stringify(actions.map((action) => ({ action, id: lib.classifyAction(action), re: re.test(action) }))));
    `);
    for (const r of got)
      expect({ action: r.action, id: r.id, re: r.re }).toEqual({
        action: r.action,
        id: null,
        re: false,
      });
  });

  it("counts PATCH /users/:id only when the target is somebody else", () => {
    const got = evalLib<Array<string | null>>(`
      console.log(JSON.stringify([
        lib.classifyAction("PATCH /users/u-1", { nonSelf: true }),
        lib.classifyAction("PATCH /users/u-1", { nonSelf: false }),
        lib.classifyAction("PATCH /users/u-1/status", { nonSelf: false }),
      ]));
    `);
    expect(got).toEqual(["users.update", null, "users.changeStatus"]);
  });

  it("prefers the static route (DELETE /customers/all) over any param route", () => {
    const got = evalLib<string | null>(
      `console.log(JSON.stringify(lib.classifyAction("DELETE /customers/all")));`,
    );
    expect(got).toBe("customers.deleteAll");
  });
});

describe("aggregateByTenant", () => {
  it("sums per tenant and area, ignores unmapped rows, self edits and zero counts, and keeps counts only", () => {
    const out = evalLib<{
      tenants: Array<{
        slug: string;
        total: number;
        byHandler: Record<string, number>;
        byArea: Record<string, number>;
      }>;
      totals: Record<string, number>;
    }>(`
      const rows = [
        { slug: "zeta", action: "POST /users/operator", nonSelf: true, n: 2 },
        { slug: "alpha", action: "PATCH /users/a1/status", nonSelf: true, n: 3 },
        { slug: "alpha", action: "PATCH /users/b2/status", nonSelf: true, n: 4 },
        { slug: "alpha", action: "PATCH /users/a1", nonSelf: true, n: 5 },
        { slug: "alpha", action: "PATCH /users/a1", nonSelf: false, n: 9 },
        { slug: "alpha", action: "PUT /import/numbering/INVOICE", nonSelf: true, n: 1 },
        { slug: "alpha", action: "POST /customers", nonSelf: true, n: 50 },
        { slug: "alpha", action: "DELETE /products/clear-all", nonSelf: true, n: 0 },
        { slug: "zeta", action: "POST /tenant/settings/email/test", nonSelf: true, n: 1 },
      ];
      const tenants = lib.aggregateByTenant(rows);
      console.log(JSON.stringify({ tenants, totals: lib.totalsByHandler(tenants) }));
    `);
    expect(out.tenants.map((t) => t.slug)).toEqual(["alpha", "zeta"]);
    expect(out.tenants[0]).toEqual({
      slug: "alpha",
      total: 13,
      byHandler: { "users.changeStatus": 7, "users.update": 5, "numbering.updateSettings": 1 },
      byArea: { users: 12, numbering: 1 },
    });
    expect(out.tenants[1]).toEqual({
      slug: "zeta",
      total: 3,
      byHandler: { "users.createOperator": 2, "settings.testEmailSettings": 1 },
      byArea: { users: 2, settings: 1 },
    });
    expect(out.totals["users.changeStatus"]).toBe(7);
    // Counts only: nothing but slug + numbers + handler/area ids leaves the aggregation.
    expect(Object.keys(out.tenants[0]).sort()).toEqual(["byArea", "byHandler", "slug", "total"]);
  });

  it("returns an empty list for no rows", () => {
    expect(evalLib("console.log(JSON.stringify(lib.aggregateByTenant([])));")).toEqual([]);
  });
});

describe("report-operator-account-blast-radius.mjs contract", () => {
  /** The script's non-comment lines: a claim in a comment must never satisfy a source pin. */
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

  it("fails closed when DATABASE_URL is unset, before opening any connection", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    const res = spawnSync(process.execPath, [SCRIPT], {
      cwd: API_DIR,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    expect(res.status).not.toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("DATABASE_URL");
    expect(combined).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|reach database/i);
  });

  it("rejects a bad --days before any connection", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--days", "0"], {
      cwd: API_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--days/);
  });

  it("is read-only: sets default_transaction_read_only and carries no write keyword", () => {
    const code = codeLines().join("\n");
    expect(code).toContain("default_transaction_read_only");
    const forbidden = ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP", "TRUNCATE"];
    expect(forbidden.filter((k) => new RegExp(`\\b${k}\\b`, "i").test(code))).toEqual([]);
  });

  it("selects no personal columns: no username, e-mail, user id or entity id is ever output", () => {
    const code = codeLines().join("\n");
    // The SQL reads `entityId` / `userId` only inside an IS DISTINCT FROM comparison.
    expect(code).not.toMatch(/\bu\.(username|email|id)\s+AS\b/i);
    expect(code).not.toMatch(/SELECT[^;]*\b(username|email)\b/is);
    expect(code).toContain('(a."entityId" IS DISTINCT FROM a."userId") AS "nonSelf"');
  });

  it("prints the legacy isAdmin count first and labels the GET handlers 'untraceable (reads are not audited)'", () => {
    const code = codeLines().join("\n");
    const flagged = code.indexOf("carrying the legacy isAdmin flag");
    const perArea = code.indexOf("Per tenant, by area:");
    expect(flagged).toBeGreaterThan(0);
    expect(flagged).toBeLessThan(code.indexOf("closed handlers:"));
    expect(flagged).toBeLessThan(perArea);
    expect(code).toContain("untraceable (reads are not audited)");
  });

  it("prints a positive control: total audit rows, admin/operator matches and tenants with an operator", () => {
    const code = codeLines().join("\n");
    expect(code).toContain('"audit rows in window"');
    expect(code).toContain("TENANT_ADMIN rows matching a closed handler");
    expect(code).toContain("tenants with an active operator");
    expect(code).toContain("positiveControl");
    // Counts only: the control query selects aggregates, never a personal column.
    expect(code).not.toMatch(/SELECT[^;]*\b(username|email)\b/is);
    expect(code.indexOf("Positive control")).toBeLessThan(code.indexOf("closed handlers:"));
  });
});

describe("the real AuditInterceptor output is what the classifier expects", () => {
  async function audited(method: string, url: string, userId = "u-1") {
    const logged: Array<Record<string, unknown>> = [];
    const interceptor = new AuditInterceptor({
      log: async (dto: Record<string, unknown>) => {
        logged.push(dto);
      },
    } as never);
    const req = { method, url, ip: "127.0.0.1", user: { sub: userId, tenantId: "t-1" } };
    const context = { switchToHttp: () => ({ getRequest: () => req }) };
    interceptor.intercept(context as never, { handle: () => ({}) } as never);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toHaveLength(1);
    return logged[0] as {
      action: string;
      entityType: string;
      entityId: string | null;
      userId: string;
    };
  }

  it("PATCH /api/v1/users/u-2?q=1 by u-1 classifies as users.update (non-self); by u-2 it does not", async () => {
    const other = await audited("PATCH", "/api/v1/users/u-2?q=1", "u-1");
    expect(other).toMatchObject({
      action: "PATCH /users/u-2",
      entityType: "users",
      entityId: "u-2",
    });
    const self = await audited("PATCH", "/api/v1/users/u-2?q=1", "u-2");
    const got = evalLib<Array<string | null>>(`
      console.log(JSON.stringify([
        lib.classifyAction(${JSON.stringify(other.action)}, { nonSelf: ${other.entityId !== other.userId} }),
        lib.classifyAction(${JSON.stringify(self.action)}, { nonSelf: ${self.entityId !== self.userId} }),
      ]));
    `);
    expect(got).toEqual(["users.update", null]);
  });

  it("classifies what the interceptor writes for other prefixed and aliased closed routes", async () => {
    const rows = await Promise.all([
      audited("DELETE", "/api/v1/customers/all?x=1"),
      audited("POST", "/api/v1/tenant/settings/email/test"),
      audited("PUT", "/api/v1/import/numbering/INVOICE"),
      audited("PATCH", "/api/v1/users/u-9/status"),
    ]);
    const got = evalLib<Array<string | null>>(`
      const actions = ${JSON.stringify(rows.map((r) => r.action))};
      console.log(JSON.stringify(actions.map((a) => lib.classifyAction(a))));
    `);
    expect(got).toEqual([
      "customers.deleteAll",
      "settings.testEmailSettings",
      "numbering.updateSettings",
      "users.changeStatus",
    ]);
  });
});

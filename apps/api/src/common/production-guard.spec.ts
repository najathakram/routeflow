/**
 * #2206: `scripts/lib/production-guard.js` decides whether a destructive script may touch a
 * database. It used to substring-match Railway hostnames in the raw DATABASE_URL, which `pg`'s
 * own `?host=` / `?hostaddr=` / `?service=` overrides, lookalike hosts and userinfo tricks walk
 * straight past. It is now an allow-list on the host `pg` would actually dial (resolved by
 * `local-db-target.cjs`), failing closed. These cases pin the pure decision; the real scripts are
 * pinned end to end in `production-guard-script.spec.ts`. Fixtures are placeholders.
 */
import { NON_LOCAL_DB_URLS } from "./local-db-bypass-urls";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyDbTarget, classifyApiTarget } = require("../../scripts/lib/production-guard");

const LOCAL_ENV = {}; // no RAILWAY_ENVIRONMENT, NODE_ENV unset

/** Beyond the shared #2162 list: the forms the issue and the lead's brief name explicitly. */
const EXTRA_BYPASSES: ReadonlyArray<readonly [string, string]> = [
  [
    "a lookalike with railway.app inside a foreign host",
    "postgresql://u:p@evil.railway.app.attacker.com:5432/x",
  ],
  ["localhost as a subdomain of a railway host", "postgresql://u:p@localhost.railway.app:5432/x"],
  [
    "a ?host= pointing at a Railway proxy",
    "postgresql://u:p@localhost:5432/x?host=roundhouse.proxy.rlwy.net",
  ],
  ["a ?host= with no value", "postgresql://u:p@localhost:5432/x?host="],
  [
    "a ?hostaddr= with a railway.internal name",
    "postgresql://u:p@127.0.0.1:5432/x?hostaddr=postgres.railway.internal",
  ],
  ["user@host: localhost as the username", "postgresql://localhost:5432@db.example.com/x"],
  ["user@host: a full local URL in the password", "postgresql://u:localhost@db.example.com:5432/x"],
  ["user@host: an @ inside the userinfo", "postgresql://u%40localhost:p@db.example.com:5432/x"],
  ["an IPv4 host that only starts with 127", "postgresql://u:p@127.0.0.1.nip.io:5432/x"],
  [
    "a railway substring in the database name only",
    "postgresql://u:p@db.example.com:5432/railway_local",
  ],
  ["undefined", undefined as unknown as string],
  ["null", null as unknown as string],
];

const LOCAL_URLS: ReadonlyArray<readonly [string, string]> = [
  ["localhost", "postgresql://user:pass@localhost:5432/routeflow_dev"],
  ["127.0.0.1", "postgresql://user:pass@127.0.0.1:5432/routeflow_dev"],
  ["::1", "postgresql://user:pass@[::1]:5432/routeflow_dev"],
  ["the compose host postgres", "postgresql://user:pass@postgres:5432/routeflow"],
  [
    "localhost with a benign query param",
    "postgresql://user:pass@localhost:5432/routeflow_dev?sslmode=disable",
  ],
];

describe("#2206 classifyDbTarget: only a provably local database passes", () => {
  it.each([...NON_LOCAL_DB_URLS, ...EXTRA_BYPASSES])("refuses %s", (_label, url) => {
    const verdict = classifyDbTarget(url, LOCAL_ENV);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not provably local/);
  });

  it.each(LOCAL_URLS)("allows %s and returns the fields to dial", (_label, url) => {
    const verdict = classifyDbTarget(url, LOCAL_ENV);
    expect(verdict.ok).toBe(true);
    expect(["localhost", "127.0.0.1", "::1", "postgres"]).toContain(verdict.config.host);
    expect(typeof verdict.config.port).toBe("number");
  });

  it("the returned config carries the parsed target, not the raw string", () => {
    const verdict = classifyDbTarget(
      "postgresql://user:pass@localhost:5433/routeflow_dev",
      LOCAL_ENV,
    );
    expect(verdict.config).toEqual({
      host: "localhost",
      port: 5433,
      user: "user",
      password: "pass",
      database: "routeflow_dev",
    });
  });
});

describe("#2206 classifyDbTarget: the environment checks still win", () => {
  const LOCAL = "postgresql://user:pass@localhost:5432/routeflow_dev";

  it("refuses a local URL inside Railway (RAILWAY_ENVIRONMENT set, even empty)", () => {
    expect(classifyDbTarget(LOCAL, { RAILWAY_ENVIRONMENT: "production" }).ok).toBe(false);
    expect(classifyDbTarget(LOCAL, { RAILWAY_ENVIRONMENT: "" }).ok).toBe(false);
  });

  it("refuses a local URL under NODE_ENV=production", () => {
    expect(classifyDbTarget(LOCAL, { NODE_ENV: "production" }).ok).toBe(false);
  });

  it("a script that dials no database passes on the environment checks alone", () => {
    expect(classifyDbTarget(undefined, LOCAL_ENV, { requireDb: false })).toEqual({
      ok: true,
      config: null,
    });
    expect(classifyDbTarget(undefined, { NODE_ENV: "production" }, { requireDb: false }).ok).toBe(
      false,
    );
  });
});

describe("#2421 classifyDbTarget: NODE_ENV=production in any case or padding", () => {
  const LOCAL = "postgresql://user:pass@localhost:5432/routeflow_dev";
  it.each(["production", "Production", "PRODUCTION", " production ", "production\n"])(
    "refuses NODE_ENV=%j",
    (value) => {
      expect(classifyDbTarget(LOCAL, { NODE_ENV: value }).ok).toBe(false);
    },
  );
  it("still allows development/test", () => {
    expect(classifyDbTarget(LOCAL, { NODE_ENV: "development" }).ok).toBe(true);
    expect(classifyDbTarget(LOCAL, { NODE_ENV: "test" }).ok).toBe(true);
  });
});

describe("#2421 classifyApiTarget: an HTTP API base URL must be provably local", () => {
  it.each([
    ["localhost", "http://localhost:3000/api/v1"],
    ["127.0.0.1", "http://127.0.0.1:3000/api/v1"],
    ["::1", "http://[::1]:3000/api/v1"],
    ["https localhost", "https://localhost/api/v1"],
  ])("allows %s", (_label, url) => {
    expect(classifyApiTarget(url)).toEqual({ ok: true });
  });

  it.each([
    ["the production API host", "https://routeflowapi-production.up.railway.app/api/v1"],
    ["a lookalike", "http://localhost.railway.app/api/v1"],
    ["a nip.io loopback lookalike", "http://127.0.0.1.nip.io/api/v1"],
    ["localhost as userinfo", "http://localhost@api.example.com/api/v1"],
    ["credentials on a local host", "http://u:p@localhost:3000/api/v1"],
    ["a non-http scheme", "ftp://localhost/api/v1"],
    ["an empty value", ""],
    ["undefined", undefined],
    ["an unparseable value", "not a url"],
  ])("refuses %s", (_label, url) => {
    expect(classifyApiTarget(url).ok).toBe(false);
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isLocalDbTarget, localConnectionConfig } =
  require("../../scripts/lib/local-db-target.cjs") as {
    isLocalDbTarget: (url: unknown) => boolean;
    localConnectionConfig: (url: unknown) => {
      host: string;
      port: number;
      user?: string;
      password?: string;
      database: string;
    } | null;
  };

// The approved-buyer fixture plants a GLOBAL BuyerAccount with a committed password, so the seed
// may run it only against a provably local database. Anything unclassifiable must be NOT local.
describe("isLocalDbTarget (e2e-seed approved-buyer gate)", () => {
  it.each([
    "postgresql://user:pass@localhost:5432/routeflow_dev",
    "postgresql://user:pass@127.0.0.1:5432/routeflow_dev",
    "postgresql://user:pass@[::1]:5432/routeflow_dev",
    "postgresql://user:pass@postgres:5432/routeflow_dev", // docker-compose service host
    "postgresql://user:pass@LOCALHOST:5432/routeflow_dev",
  ])("is local: %s", (url) => {
    expect(isLocalDbTarget(url)).toBe(true);
  });

  it.each([
    ["a Railway TCP proxy URL", "postgresql://u:p@roundhouse.proxy.rlwy.net:12345/railway"],
    ["a *.railway.internal URL", "postgresql://u:p@postgres.railway.internal:5432/railway"],
    ["an unknown remote host", "postgresql://u:p@db.example.com:5432/app"],
    ["a custom proxy host with no railway marker", "postgresql://u:p@pg.internal-proxy.net:5432/x"],
    ["a lookalike host", "postgresql://u:p@localhost.evil.com:5432/x"],
    ["localhost only in the userinfo", "postgresql://localhost@evil.com:5432/x"],
    // Opus on #2162: pg-connection-string lets a query parameter override the authority's host, so these all
    // LOOK local to `new URL().hostname` while pg would dial elsewhere
    ["a ?host= override", "postgresql://u:p@localhost:5432/x?host=prod.example.com"],
    ["a ?hostaddr= override", "postgresql://u:p@localhost:5432/x?hostaddr=203.0.113.9"],
    ["a ?service= indirection", "postgresql://u:p@localhost:5432/x?service=prod"],
    ["a ?HOST= in any case", "postgresql://u:p@localhost:5432/x?HOST=prod.example.com"],
    [
      "a host param among others",
      "postgresql://u:p@localhost:5432/x?sslmode=disable&host=evil.com",
    ],
    ["a multi-host list", "postgresql://u:p@localhost,evil.com:5432/x"],
    ["a unix-socket host", "postgresql://u:p@/x?host=%2Fvar%2Frun%2Fpostgresql"],
    [
      "a query smuggled in the database name",
      "postgresql://u:p@localhost:5432/routeflow_dev%3Fhost%3Dprod.example.com",
    ],
    ["an empty string", ""],
    ["an unparseable value", "not a url"],
  ])("is NOT local: %s", (_label, url) => {
    expect(isLocalDbTarget(url)).toBe(false);
  });

  it("is NOT local for a missing or non-string value", () => {
    expect(isLocalDbTarget(undefined)).toBe(false);
    expect(isLocalDbTarget(null)).toBe(false);
    expect(isLocalDbTarget(42)).toBe(false);
  });
});

describe("localConnectionConfig (the fields pg is built from)", () => {
  it("returns explicit, decoded fields for a local URL", () => {
    expect(
      localConnectionConfig("postgresql://us%40er:p%2Fw@LOCALHOST:55432/routeflow_dev"),
    ).toEqual({
      host: "localhost",
      port: 55432,
      user: "us@er",
      password: "p/w",
      database: "routeflow_dev",
    });
  });
  it("defaults the port and is null for anything not provably local", () => {
    expect(localConnectionConfig("postgresql://u:p@[::1]/x")?.port).toBe(5432);
    expect(localConnectionConfig("postgresql://u:p@localhost:5432/x?host=evil.com")).toBeNull();
  });
});

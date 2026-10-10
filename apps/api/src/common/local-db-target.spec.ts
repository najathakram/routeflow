import { NON_LOCAL_DB_URLS } from "./local-db-bypass-urls";

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

  it.each(NON_LOCAL_DB_URLS.map((r) => [...r]))("is NOT local: %s", (_label, url) => {
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isLocalDbTarget } = require("../../scripts/lib/local-db-target.cjs") as {
  isLocalDbTarget: (url: unknown) => boolean;
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

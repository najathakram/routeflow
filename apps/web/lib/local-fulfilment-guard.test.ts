import { assertLocalFulfilmentTarget, isLocalOnlyLane } from "./local-fulfilment-guard";

const OK = {
  baseUrl: "http://localhost:3001",
  apiUrl: "http://localhost:3000",
  dbUrl: "postgresql://user:pw@localhost:5432/routeflow_dev",
  tenantSlug: "e2e-routeflow",
};

describe("assertLocalFulfilmentTarget", () => {
  it("passes for the local stack on an approved test tenant", () => {
    expect(() => assertLocalFulfilmentTarget(OK)).not.toThrow();
    expect(() => assertLocalFulfilmentTarget({ ...OK, tenantSlug: "qa-abc" })).not.toThrow();
  });

  it.each([
    ["a deployed web URL", { baseUrl: "https://www.routeflow.info" }],
    ["a lookalike host", { baseUrl: "http://localhost.evil.com:3001" }],
    ["an unset web URL", { baseUrl: undefined }],
    ["a deployed API origin", { apiUrl: "https://routeflowapi-production.up.railway.app" }],
    ["a remote database", { dbUrl: "postgresql://u:p@db.example.com:5432/x" }],
    ["a redirecting database host", { dbUrl: "postgresql://u:p@localhost/x?host=db.example.com" }],
    ["an unset database", { dbUrl: undefined }],
    ["a live tenant slug", { tenantSlug: "some-client" }],
    ["an unset tenant slug", { tenantSlug: undefined }],
    ["GitHub Actions", { githubActions: "true" }],
  ])("refuses %s", (_label, patch) => {
    expect(() => assertLocalFulfilmentTarget({ ...OK, ...patch })).toThrow(
      /local fulfilment guard|Test-tenant policy/,
    );
  });
});

describe("isLocalOnlyLane", () => {
  it("is true only for a local base URL outside GitHub Actions", () => {
    expect(isLocalOnlyLane({ PLAYWRIGHT_BASE_URL: "http://localhost:3001" })).toBe(true);
    expect(isLocalOnlyLane({ PLAYWRIGHT_BASE_URL: "https://www.routeflow.info" })).toBe(false);
    expect(isLocalOnlyLane({})).toBe(false);
    expect(
      isLocalOnlyLane({ PLAYWRIGHT_BASE_URL: "http://localhost:3001", GITHUB_ACTIONS: "true" }),
    ).toBe(false);
  });
});

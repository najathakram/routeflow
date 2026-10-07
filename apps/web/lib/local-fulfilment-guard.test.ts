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

describe("local-only e2e projects stay behind the local-lane gate", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { resolve } = require("node:path") as typeof import("node:path");
  const cfg = readFileSync(resolve(__dirname, "../playwright.config.ts"), "utf8");
  const gateAt = cfg.indexOf("...(isLocalOnlyLane(process.env)");

  it("specs 71 and 72 are registered ONLY inside the isLocalOnlyLane(process.env) spread, once each", () => {
    expect(gateAt).toBeGreaterThan(0);
    for (const name of ["counter-ship-handoff", "counter-pos-stack"]) {
      const at = [...cfg.matchAll(new RegExp(`name: "${name}"`, "g"))].map((m) => m.index!);
      expect(at).toHaveLength(1);
      expect(at[0]).toBeGreaterThan(gateAt);
    }
    // nothing but the gated spread follows: the array it sits in closes right after the two projects
    expect(cfg.slice(gateAt)).toMatch(/\]\s*:\s*\[\]\)/);
  });

  it("spec 72 runs the local-target guard and assertTestTenant BEFORE it creates anything", () => {
    const spec = readFileSync(resolve(__dirname, "../e2e/72-counter-pos-stack.spec.ts"), "utf8");
    const fn = spec.slice(spec.indexOf("async function makeTierFixtures"));
    const guard = fn.indexOf("assertLocalFulfilmentTarget(");
    const tenant = fn.indexOf("assertTestTenant(");
    const firstPost = fn.indexOf("request.post(");
    expect(guard).toBeGreaterThan(0);
    expect(tenant).toBeGreaterThan(0);
    expect(firstPost).toBeGreaterThan(Math.max(guard, tenant));
  });

  it("spec 72 retires its throwaways softly (no DELETE) and reads them back", () => {
    const spec = readFileSync(resolve(__dirname, "../e2e/72-counter-pos-stack.spec.ts"), "utf8");
    expect(spec).not.toMatch(/\.delete\(/);
    expect(spec).toMatch(/isActive: false/);
    expect(spec).toMatch(/status: "INACTIVE"/);
    expect(spec).toMatch(/reads back inactive/);
  });
});

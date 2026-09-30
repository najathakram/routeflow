import { AppService } from "./app.service";

// PR-11 — Item 9 / T2: AppService.healthCheck() reports the deployed commit/branch, mirroring
// apps/web/app/api/health/route.ts's RAILWAY_GIT_COMMIT_SHA / RAILWAY_GIT_BRANCH read.

describe("AppService.healthCheck (T2)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns status/commit/branch from RAILWAY_GIT_COMMIT_SHA and RAILWAY_GIT_BRANCH when set", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "abc123";
    process.env.RAILWAY_GIT_BRANCH = "master";

    const service = new AppService();
    const result = service.healthCheck();

    expect(result).toEqual({
      status: "ok",
      timestamp: expect.any(String),
      commit: "abc123",
      branch: "master",
    });
  });

  it("returns commit: null, branch: null when the Railway env vars are unset", () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    delete process.env.RAILWAY_GIT_BRANCH;

    const service = new AppService();
    const result = service.healthCheck();

    // Whole-shape oracle (R4: `null`, never `"unknown"`, and the existing keys survive) — a
    // bare `toBeNull()` pair would also be satisfied by an implementation that drops
    // status/timestamp.
    expect(result).toEqual({
      status: "ok",
      timestamp: expect.any(String),
      commit: null,
      branch: null,
    });
  });
});

// Release-health tagging (PR 1): apps/api/src/instrument.ts must tag every Sentry event with
// the deployed commit sha (RAILWAY_GIT_COMMIT_SHA) as `release`, and a missing sha must not
// crash boot. Sentry.init() runs as a module-level side effect on import, so each case mocks
// @sentry/node and re-imports the module fresh via jest.isolateModules + resetModules.

jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  httpIntegration: jest.fn((options: unknown) => ({ name: "Http", options })),
}));

describe("instrument.ts release tagging (PR 1)", () => {
  const ORIGINAL_ENV = process.env;
  let init: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    init = require("@sentry/node").init as jest.Mock;
    init.mockClear();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("tags the Sentry release with RAILWAY_GIT_COMMIT_SHA when set", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "abc123deadbeef";
    process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/1";

    require("./instrument");

    expect(init).toHaveBeenCalledWith(expect.objectContaining({ release: "abc123deadbeef" }));
  });

  it("does not crash and passes release: undefined when RAILWAY_GIT_COMMIT_SHA is unset", () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;

    expect(() => require("./instrument")).not.toThrow();
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ release: undefined }));
  });

  it("treats an empty-string RAILWAY_GIT_COMMIT_SHA the same as unset (never tags a blank release)", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "";

    require("./instrument");

    expect(init).toHaveBeenCalledWith(expect.objectContaining({ release: undefined }));
  });

  it("sends no incoming request body and scrubs every event and transaction", () => {
    process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/1";

    require("./instrument");

    const options = init.mock.calls[0][0];
    expect(options.integrations).toEqual([
      expect.objectContaining({ name: "Http", options: { maxIncomingRequestBodySize: "none" } }),
    ]);
    const event = { request: { url: "https://h.test/a?token=x", query_string: "token=x" } };
    expect(options.beforeSend(event)).toBe(event);
    expect(event.request).toEqual({ url: "https://h.test/a" });
    const tx = { request: { url: "https://h.test/b?t=1", data: "{}" } };
    expect(options.beforeSendTransaction(tx)).toBe(tx);
    expect(tx.request).toEqual({ url: "https://h.test/b" });
  });

  it("stays inert without a DSN", () => {
    delete process.env.SENTRY_DSN;

    require("./instrument");

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: undefined, enabled: false, skipOpenTelemetrySetup: true }),
    );
  });
});

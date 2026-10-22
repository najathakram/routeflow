// Release-health tagging (PR 1): apps/api/src/instrument.ts must tag every Sentry event with
// the deployed commit sha (RAILWAY_GIT_COMMIT_SHA) as `release`, and a missing sha must not
// crash boot. Sentry.init() runs as a module-level side effect on import, so each case mocks
// @sentry/node and re-imports the module fresh via jest.isolateModules + resetModules.

jest.mock("@sentry/node", () => ({ init: jest.fn() }));

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

  it("wires the Idempotency-Key redaction into beforeSend and beforeSendTransaction (SA-824)", () => {
    require("./instrument");

    const opts = init.mock.calls[0][0];
    const ev = { transaction: "GET /api/v1/invoices/payments/by-key/RAW-KEY-4" };
    expect(opts.beforeSend(structuredClone(ev)).transaction).toBe(
      "GET /api/v1/invoices/payments/by-key/:key",
    );
    expect(opts.beforeSendTransaction(structuredClone(ev)).transaction).toBe(
      "GET /api/v1/invoices/payments/by-key/:key",
    );
  });
});

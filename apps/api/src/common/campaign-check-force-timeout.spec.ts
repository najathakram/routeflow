// campaign-check's forced `turbo run test --force` must not call a timeout a test failure
// (2026-11-22: two pushes refused although every suite passed). Pure helper, injected spawn results.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const helpers = require("../../../../scripts/lib/campaign-force-run.cjs") as {
  DEFAULT_FORCE_TIMEOUT_MIN: number;
  forceTimeoutMin: (env: Record<string, string | undefined>) => number;
  classifyForcedRun: (
    res: {
      status?: number | null;
      signal?: string | null;
      error?: { code?: string; message: string };
    },
    minutes: number,
  ) => { ok: boolean; reason: string | null; timedOut?: boolean; minutes?: number };
  failureMessage: (
    forced: { reason: string | null; timedOut?: boolean; minutes?: number },
    pkg: string,
    dir: string,
    verb: string,
  ) => string;
};

describe("campaign-check forced-run timeout", () => {
  it("defaults to 45 minutes", () => {
    expect(helpers.forceTimeoutMin({})).toBe(45);
    expect(helpers.DEFAULT_FORCE_TIMEOUT_MIN).toBe(45);
  });

  it("reads RF_CAMPAIGN_FORCE_TIMEOUT_MIN when it is a positive integer", () => {
    expect(helpers.forceTimeoutMin({ RF_CAMPAIGN_FORCE_TIMEOUT_MIN: "90" })).toBe(90);
  });

  it.each(["0", "-5", "abc", "1.5", "", " "])("ignores invalid value %p", (v) => {
    expect(helpers.forceTimeoutMin({ RF_CAMPAIGN_FORCE_TIMEOUT_MIN: v })).toBe(45);
  });

  it("ETIMEDOUT is a timeout, not a failure", () => {
    const r = helpers.classifyForcedRun(
      { error: { code: "ETIMEDOUT", message: "spawnSync ETIMEDOUT" } },
      45,
    );
    expect(r).toMatchObject({ ok: false, timedOut: true, minutes: 45 });
  });

  it("a kill signal is a timeout", () => {
    const r = helpers.classifyForcedRun({ status: null, signal: "SIGTERM" }, 30);
    expect(r).toMatchObject({ ok: false, timedOut: true, minutes: 30 });
  });

  it("timeout prints the TIMED OUT line and never says genuine failure", () => {
    const forced = helpers.classifyForcedRun({ error: { code: "ETIMEDOUT", message: "x" } }, 45);
    const msg = helpers.failureMessage(forced, "@routeflow/api", "apps/api", "did not produce it");
    expect(msg).toBe(
      "campaign-check: forced run for @routeflow/api TIMED OUT after 45 min (host load?), not a test failure; re-push when the heavy-slot queue is quiet or raise RF_CAMPAIGN_FORCE_TIMEOUT_MIN",
    );
    expect(msg).not.toContain("genuine failure");
  });

  it("a non-zero exit still says genuine failure", () => {
    const forced = helpers.classifyForcedRun({ status: 1 }, 45);
    expect(forced).toMatchObject({ ok: false, reason: "turbo exited 1" });
    expect(forced.timedOut).toBeFalsy();
    const msg = helpers.failureMessage(forced, "@routeflow/api", "apps/api", "did not produce it");
    expect(msg).toContain("this is a genuine failure, not a caching artifact");
    expect(msg).toContain("turbo exited 1");
  });

  it("exit 0 is ok", () => {
    expect(helpers.classifyForcedRun({ status: 0 }, 45)).toMatchObject({ ok: true, reason: null });
  });
});

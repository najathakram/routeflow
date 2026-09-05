/**
 * Pins `scripts/lib/recover-calendar-day.cjs` — the rule that decides which
 * calendar day the F25 licence-date repair (`scripts/repair-f25-licence-dates.mjs`,
 * a data-mutating `--execute` flight) writes back to
 * `CustomerAuthorization.expiresAt`.
 *
 * The spec `require`s the SAME module the repair script imports, so there is no
 * hand-copied twin to drift: a change that lost the already-UTC-midnight skip,
 * or moved the noon split, fails here instead of silently rewriting live rows
 * to the wrong day.
 *
 * Each case below is a stored instant as some WRITING DEVICE produced it from
 * ``new Date(`${day}T23:59:59`)`` — the intended day is always 2026-07-01.
 */
const { recoverCalendarDay, classifyRepairRow } =
  require("../../../../scripts/lib/recover-calendar-day.cjs") as {
    recoverCalendarDay: (storedIso: string) => string | null;
    classifyRepairRow: (
      storedIso: string,
      afterIso: string,
      nowMs: number,
    ) => { expiringNow: boolean; farEast: boolean };
  };

describe("recoverCalendarDay (scripts/lib/recover-calendar-day.cjs)", () => {
  it("recovers the intended day from a UTC device's 23:59:59", () => {
    expect(recoverCalendarDay("2026-07-01T23:59:59.000Z")).toBe("2026-07-01");
  });

  it("recovers the intended day from a PDT (UTC-7) device — rolls back a UTC day", () => {
    expect(recoverCalendarDay("2026-07-02T06:59:59.000Z")).toBe("2026-07-01");
  });

  it("recovers the intended day from an EDT (UTC-4) device — rolls back a UTC day", () => {
    expect(recoverCalendarDay("2026-07-02T03:59:59.000Z")).toBe("2026-07-01");
  });

  it("recovers the intended day from a UTC+5:30 device — keeps the UTC day", () => {
    expect(recoverCalendarDay("2026-07-01T18:29:59.000Z")).toBe("2026-07-01");
  });

  // The two sides of the noon split itself — the rule's only branch. Moving the
  // cutoff by a single hour in either direction fails one of these.
  it("keeps the UTC day at exactly 12:00:00 (the far-east edge, device UTC+11:59:59)", () => {
    expect(recoverCalendarDay("2026-07-01T12:00:00.000Z")).toBe("2026-07-01");
  });

  it("rolls back at 11:59:59.999 — the last instant on the before-noon side", () => {
    expect(recoverCalendarDay("2026-07-01T11:59:59.999Z")).toBe("2026-06-30");
  });

  it("rolls a month/year boundary back correctly for a west-of-UTC device", () => {
    expect(recoverCalendarDay("2027-01-01T04:59:59.000Z")).toBe("2026-12-31");
  });

  it("returns null for an already-UTC-midnight row — never shifts a correct row", () => {
    expect(recoverCalendarDay("2026-07-01T00:00:00.000Z")).toBeNull();
  });

  it("treats one millisecond past UTC midnight as damage, not as a correct row", () => {
    expect(recoverCalendarDay("2026-07-02T00:00:00.001Z")).toBe("2026-07-01");
  });

  it("returns null for an unparseable instant", () => {
    expect(recoverCalendarDay("garbage")).toBeNull();
  });
});

/**
 * Pins `classifyRepairRow` — the two hold-back gates the repair flight applies
 * on top of the day recovery above. Both classes write a compliance field
 * (`authorization-guard.service.ts` blocks regulated sales on
 * `expiresAt < now`), so each needs an explicit operator flag.
 */
describe("classifyRepairRow — the repair's hold-back gates", () => {
  const IRRELEVANT_NOW = Date.parse("2020-01-01T00:00:00.000Z");

  // A 2026-09-05 expiry captured on a PDT (UTC−7) device: stored as that
  // device's local 23:59:59, i.e. 2026-09-05T06:59:59Z. Its repaired value is
  // 2026-09-05T00:00:00.000Z — still in the FUTURE at 23:55Z on 2026-09-04,
  // already in the PAST ten minutes after that UTC midnight.
  const before = "2026-09-05T06:59:59.000Z";
  const after = "2026-09-05T00:00:00.000Z";

  it("holds back a row that becomes EXPIRING NOW between the preview and the write", () => {
    const previewNow = Date.parse("2026-09-04T23:55:00.000Z"); // plan printed
    const writeNow = Date.parse("2026-09-05T00:10:00.000Z"); // operator typed the slug back

    // Preview says PLAIN — this is the snapshot the script must NOT gate on.
    expect(classifyRepairRow(before, after, previewNow).expiringNow).toBe(false);
    // A fresh clock taken immediately before the write says EXPIRING NOW, so
    // the row is held back unless --allow-expiring-rows is passed.
    expect(classifyRepairRow(before, after, writeNow).expiringNow).toBe(true);
  });

  it("still reports EXPIRING NOW for a row that was already crossing at plan time", () => {
    const now = Date.parse("2026-09-05T03:00:00.000Z");
    expect(classifyRepairRow(before, after, now).expiringNow).toBe(true);
  });

  it("leaves a row whose repaired value stays in the future unflagged", () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    expect(classifyRepairRow(before, after, now).expiringNow).toBe(false);
  });

  it("flags a UTC+13 (Pacific/Auckland, NZDT) row as FAR EAST — recovered one day EARLY", () => {
    // Intended day 2026-12-01, stored as that device's local 23:59:59.
    const stored = "2026-12-01T10:59:59.000Z";
    // The recovery rule reads before-noon and rolls back — one day early.
    expect(recoverCalendarDay(stored)).toBe("2026-11-30");
    expect(classifyRepairRow(stored, "2026-11-30T00:00:00.000Z", IRRELEVANT_NOW).farEast).toBe(
      true,
    );
  });

  it("flags the whole [09:00, 12:00) band and nothing outside it", () => {
    const at = (iso: string) => classifyRepairRow(iso, "2026-12-01T00:00:00.000Z", IRRELEVANT_NOW);
    expect(at("2026-12-01T08:59:59.999Z").farEast).toBe(false);
    expect(at("2026-12-01T09:00:00.000Z").farEast).toBe(true);
    expect(at("2026-12-01T11:59:59.999Z").farEast).toBe(true);
    expect(at("2026-12-01T12:00:00.000Z").farEast).toBe(false);
  });

  it("does not flag rows written inside the rule's documented device range", () => {
    const at = (iso: string) => classifyRepairRow(iso, "2026-07-01T00:00:00.000Z", IRRELEVANT_NOW);
    expect(at("2026-07-01T23:59:59.000Z").farEast).toBe(false); // UTC device
    expect(at("2026-07-02T03:59:59.000Z").farEast).toBe(false); // EDT (UTC−4)
    expect(at("2026-07-02T06:59:59.000Z").farEast).toBe(false); // PDT (UTC−7)
    expect(at("2026-07-01T18:29:59.000Z").farEast).toBe(false); // UTC+5:30
  });

  it("classifies an unparseable instant as neither — it is skipped upstream anyway", () => {
    const c = classifyRepairRow("garbage", "2026-07-01T00:00:00.000Z", IRRELEVANT_NOW);
    expect(c).toEqual({ expiringNow: false, farEast: false });
  });
});

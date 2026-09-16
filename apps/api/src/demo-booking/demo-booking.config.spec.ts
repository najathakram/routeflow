import {
  isCalendarConfigured,
  isSlotGridValid,
  isTokenSigningConfigured,
  loadDemoBookingConfig,
} from "./demo-booking.config";

/**
 * The Railway-pasted service-account key arrives as a single line with LITERAL
 * `\n` two-character sequences (that's how it prints inside the downloaded
 * JSON). `normalisePrivateKey` must turn those into real newline bytes — a
 * regex of `/\n/g` (matching an actual newline) is a silent no-op against that
 * input, which is exactly the bug this pins.
 */
describe("loadDemoBookingConfig — private key normalisation", () => {
  const literalTwoCharEscapes =
    "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n";

  it("turns literal \\n escapes into real newline characters", () => {
    const config = loadDemoBookingConfig({
      GOOGLE_CALENDAR_SA_PRIVATE_KEY: literalTwoCharEscapes,
    } as unknown as NodeJS.ProcessEnv);

    // The buggy `/\n/g` regex leaves the string byte-for-byte unchanged — the
    // real fix must actually split it across multiple lines.
    expect(config.saPrivateKey).not.toBe(literalTwoCharEscapes);
    expect(config.saPrivateKey.split("\n").length).toBeGreaterThan(1);
    expect(config.saPrivateKey).toContain("-----BEGIN PRIVATE KEY-----\nMIIEvQ");
  });

  it("leaves an already-real-newline key untouched", () => {
    const alreadyReal = "-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n";
    const config = loadDemoBookingConfig({
      GOOGLE_CALENDAR_SA_PRIVATE_KEY: alreadyReal,
    } as unknown as NodeJS.ProcessEnv);
    expect(config.saPrivateKey).toBe(alreadyReal.trim());
  });

  it("strips wrapping quotes some paste flows add, then normalises", () => {
    const quoted = `"${literalTwoCharEscapes}"`;
    const config = loadDemoBookingConfig({
      GOOGLE_CALENDAR_SA_PRIVATE_KEY: quoted,
    } as unknown as NodeJS.ProcessEnv);
    expect(config.saPrivateKey).toContain("-----BEGIN PRIVATE KEY-----\nMIIEvQ");
    expect(config.saPrivateKey.startsWith('"')).toBe(false);
  });

  it("a correctly-normalised key is reported as configured", () => {
    const config = loadDemoBookingConfig({
      GOOGLE_CALENDAR_SA_PRIVATE_KEY: literalTwoCharEscapes,
      GOOGLE_CALENDAR_SA_EMAIL: "sa@example.iam.gserviceaccount.com",
      GOOGLE_CALENDAR_IMPERSONATE: "admin@routeflow.info",
    } as unknown as NodeJS.ProcessEnv);
    expect(isCalendarConfigured(config)).toBe(true);
  });
});

describe("loadDemoBookingConfig — other config parsing", () => {
  it("reports unconfigured with no env at all", () => {
    const config = loadDemoBookingConfig({} as NodeJS.ProcessEnv);
    expect(isCalendarConfigured(config)).toBe(false);
    expect(isTokenSigningConfigured(config)).toBe(false);
  });

  it("falls back to defaults on garbage numeric input rather than NaN", () => {
    const config = loadDemoBookingConfig({
      DEMO_BOOKING_DURATION_MINUTES: "not-a-number",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.durationMinutes).toBe(30);
  });
});

// Review round-2 finding C: neither the advisory lock (keyed on exact start)
// nor the partial unique index (on startsAt alone) catches two DIFFERENT
// starts whose [start, start+duration) ranges overlap — that can only happen
// when the step is shorter than the duration, so the grid must never be
// allowed to offer that combination.
describe("isSlotGridValid", () => {
  it("is valid when the interval equals the duration (the shipped default: 30/30)", () => {
    const config = loadDemoBookingConfig({} as NodeJS.ProcessEnv);
    expect(config.slotIntervalMinutes).toBe(30);
    expect(config.durationMinutes).toBe(30);
    expect(isSlotGridValid(config)).toBe(true);
  });

  it("is valid when the interval is longer than the duration", () => {
    const config = loadDemoBookingConfig({
      DEMO_BOOKING_DURATION_MINUTES: "20",
      DEMO_BOOKING_SLOT_INTERVAL_MINUTES: "30",
    } as unknown as NodeJS.ProcessEnv);
    expect(isSlotGridValid(config)).toBe(true);
  });

  it("is invalid when the interval is shorter than the duration", () => {
    const config = loadDemoBookingConfig({
      DEMO_BOOKING_DURATION_MINUTES: "30",
      DEMO_BOOKING_SLOT_INTERVAL_MINUTES: "15",
    } as unknown as NodeJS.ProcessEnv);
    expect(isSlotGridValid(config)).toBe(false);
  });
});

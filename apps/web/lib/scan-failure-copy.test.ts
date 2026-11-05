import { scanFailureCopy } from "./scan-failure-copy";
import { SCAN_FAILED_COPY } from "./reason-copy";
import { SCAN_LOCK_BODY, SCAN_LOCK_TITLE } from "./scan-po-lock";

const http = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe("scanFailureCopy (SA-1102 A-4 M1-1)", () => {
  it("a monthly-cap refusal is a pause with the server's date, never 'clearer photo'", () => {
    const err = http(403, { code: "AI_MONTHLY_CAP_REACHED", resetsAt: "2026-12-01T00:00:00.000Z" });
    const c = scanFailureCopy(err, false);
    expect(c.title).toBe("Scanning is paused");
    expect(c.description).toBe(
      "AI scans are paused until December 1. You can still enter the bill by hand.",
    );
    expect(c.rowError).toBe(c.description);
    expect(JSON.stringify(c)).not.toMatch(/clearer photo/i);
  });

  it("a cap refusal without a date still reads as a pause", () => {
    const c = scanFailureCopy(http(403, { code: "AI_MONTHLY_CAP_REACHED" }), false);
    expect(c.description).toBe(
      "AI scans are paused until the 1st of next month. You can still enter the bill by hand.",
    );
  });

  it("a closed plan gate wins over everything", () => {
    const err = http(403, { code: "AI_MONTHLY_CAP_REACHED", resetsAt: "2026-12-01T00:00:00.000Z" });
    expect(scanFailureCopy(err, true)).toEqual({
      title: SCAN_LOCK_TITLE,
      description: SCAN_LOCK_BODY,
      rowError: SCAN_LOCK_BODY,
    });
  });

  it("a refused key reads as the key copy", () => {
    const c = scanFailureCopy(http(400, { code: "AI_KEY_INVALID", message: "x" }), false);
    expect(c.title).toBe("Anthropic API key not configured");
    expect(c.rowError).toMatch(/Settings → AI & Integrations/);
  });

  it("anything else is the closed retry copy, never the server's text", () => {
    const c = scanFailureCopy(http(500, { message: "boom: internal detail" }), false);
    expect(c).toEqual({
      title: "Failed to scan invoice",
      description: SCAN_FAILED_COPY,
      rowError: SCAN_FAILED_COPY,
    });
    expect(JSON.stringify(c)).not.toMatch(/boom/);
  });
});

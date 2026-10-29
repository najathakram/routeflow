import { displayAuthStatus } from "./authorizations";

// B330: the customer-file badge reads a licence through the shared rule: good through its printed day in the
// business's zone. Chicago CDT: the day printed 2026-03-09 ends at 2026-03-10T05:00Z.
describe("REG-B330 displayAuthStatus", () => {
  const row = { status: "VERIFIED" as const, expiresAt: "2026-03-09T00:00:00.000Z" };

  it("REG-B330 keeps a VERIFIED licence on its printed day and expires it from the next local day", () => {
    expect(displayAuthStatus(row, "America/Chicago", new Date("2026-03-10T03:00:00.000Z"))).toBe(
      "VERIFIED",
    );
    expect(displayAuthStatus(row, "America/Chicago", new Date("2026-03-10T05:00:00.000Z"))).toBe(
      "EXPIRED",
    );
  });

  it("REG-B330 an unknown zone reads the day in UTC, and non-VERIFIED statuses are never rewritten", () => {
    expect(displayAuthStatus(row, "Not/AZone", new Date("2026-03-10T03:00:00.000Z"))).toBe(
      "EXPIRED",
    );
    expect(
      displayAuthStatus(
        { status: "PENDING_REVIEW", expiresAt: row.expiresAt },
        "America/Chicago",
        new Date("2026-03-11T00:00:00.000Z"),
      ),
    ).toBe("PENDING_REVIEW");
  });
});

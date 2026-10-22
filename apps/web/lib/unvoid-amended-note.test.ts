import { unvoidAmendedPeriodNote } from "@routeflow/types";

describe("unvoidAmendedPeriodNote: SA-839 §3, the unvoid toast's filed-month line", () => {
  it("names the void's filed month and the month the sale is booked in (UTC)", () => {
    expect(
      unvoidAmendedPeriodNote(
        { periodKey: "2026-10", status: "GENERATED", trackedCategoryId: "cat-1" },
        new Date("2026-11-03T12:00:00Z"),
      ),
    ).toBe(
      "Restored. The void was in October 2026, which is already filed. This sale is booked in November 2026; an amended return for October 2026 may be needed.",
    );
  });

  it("null when there is no filed period (the common case), or the key is unreadable", () => {
    expect(unvoidAmendedPeriodNote(null)).toBeNull();
    expect(unvoidAmendedPeriodNote(undefined)).toBeNull();
    expect(
      unvoidAmendedPeriodNote({ periodKey: "2026-Q4", status: "LOCKED", trackedCategoryId: "c" }),
    ).toBeNull();
  });
});

/**
 * Shared late-stop derivation used by BOTH dispatch modals (B161).
 *
 * The helpers live here rather than in a `page.tsx` so neither route module exports
 * anything but its default component and recognised segment config, and so the two
 * modals cannot drift apart on the warning's wording.
 */
import { lateStopsFromAnalysis } from "./late-stops";
import type { RouteAnalysisResult } from "@/lib/api/routes";

const eta = (over: Partial<RouteAnalysisResult["etas"][number]>) => ({
  stopId: "s1",
  stopNumber: 1,
  customerName: "Acme Grocers",
  arrivalTime: "10:30",
  departureTime: "10:45",
  travelTimeMinutes: 12,
  deliveryWindowStart: "08:00",
  deliveryWindowEnd: "10:00",
  withinWindow: false,
  ...over,
});

describe("lateStopsFromAnalysis", () => {
  it("keeps only the ETAs the analyzer marked outside their window", () => {
    const result = lateStopsFromAnalysis({
      configured: true,
      etas: [
        eta({ stopId: "late", withinWindow: false }),
        eta({ stopId: "ontime", withinWindow: true }),
        // `null` = the stop has no window at all — not a violation.
        eta({ stopId: "nowindow", withinWindow: null, deliveryWindowEnd: null }),
      ],
    });

    expect(result.map((s) => s.stopId)).toEqual(["late"]);
  });

  it("labels a late stop with its customer, ETA and window end", () => {
    const [late] = lateStopsFromAnalysis({
      configured: true,
      etas: [
        eta({ customerName: "Acme Grocers", arrivalTime: "10:30", deliveryWindowEnd: "10:00" }),
      ],
    });

    expect(late.label).toBe("Acme Grocers — ETA 10:30 misses window (ends 10:00)");
  });

  it("falls back to '?' when the late stop has no window end", () => {
    const [late] = lateStopsFromAnalysis({
      configured: true,
      etas: [eta({ deliveryWindowEnd: null })],
    });

    expect(late.label).toBe("Acme Grocers — ETA 10:30 misses window (ends ?)");
  });

  it("returns nothing when the analyzer produced no ETAs", () => {
    expect(lateStopsFromAnalysis({ configured: false, etas: [] })).toEqual([]);
  });
});

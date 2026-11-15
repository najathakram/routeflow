import { routeStopsNotPlacedSentence } from "@routeflow/types/route-stops-not-placed";
import { optimizeUnplacedCopy } from "../lib/route-optimize-error";

// UXG B14: the driver and both operator screens say which stops have no map position, from the structured
// fields of the coded 400 (never the server message); any other error keeps the screen's own line (null here).
const coded = (data: Record<string, unknown>) => ({ response: { status: 400, data } });

describe("routeStopsNotPlacedSentence (shared with web)", () => {
  it("names up to three stops", () => {
    expect(routeStopsNotPlacedSentence(2, ["Acme Deli", "Acme Market"])).toBe(
      "2 stops have no map position (Acme Deli, Acme Market). Check their addresses, then optimize again.",
    );
  });
  it("says 'and N more' past three, and uses the singular for one", () => {
    expect(routeStopsNotPlacedSentence(5, ["A", "B", "C", "D", "E"])).toBe(
      "5 stops have no map position (A, B, C and 2 more). Check their addresses, then optimize again.",
    );
    expect(routeStopsNotPlacedSentence(1, ["Acme Deli"])).toBe(
      "1 stop has no map position (Acme Deli). Check their addresses, then optimize again.",
    );
  });
  it("drops the list when no names came back", () => {
    expect(routeStopsNotPlacedSentence(3, [])).toBe(
      "3 stops have no map position. Check their addresses, then optimize again.",
    );
  });
});

describe("optimizeUnplacedCopy", () => {
  it("builds the sentence from count and names, ignoring the message", () => {
    expect(
      optimizeUnplacedCopy(
        coded({ code: "ROUTE_STOPS_NOT_PLACED", message: "RAW", count: 1, names: ["Acme Deli"] }),
      ),
    ).toBe("1 stop has no map position (Acme Deli). Check their addresses, then optimize again.");
  });
  it("is null for any other error", () => {
    expect(optimizeUnplacedCopy(coded({ code: "OTHER", message: "x" }))).toBeNull();
    expect(optimizeUnplacedCopy(new Error("Network Error"))).toBeNull();
    expect(optimizeUnplacedCopy(undefined)).toBeNull();
  });
});

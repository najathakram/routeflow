import { readFileSync } from "fs";
import { join } from "path";
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

describe("routeStopsNotPlacedSentence hardening", () => {
  it("drops empty and space-only names", () => {
    expect(routeStopsNotPlacedSentence(2, ["", " ", "Acme Deli"])).toBe(
      "2 stops have no map position (Acme Deli and 1 more). Check their addresses, then optimize again.",
    );
    expect(routeStopsNotPlacedSentence(2, ["", " "])).toBe(
      "2 stops have no map position. Check their addresses, then optimize again.",
    );
  });
  it("claims no number when there is neither a count nor a usable name", () => {
    const want = "Some stops have no map position. Check their addresses, then optimize again.";
    expect(routeStopsNotPlacedSentence(0, [])).toBe(want);
    expect(routeStopsNotPlacedSentence(Number.NaN, ["", " "])).toBe(want);
    expect(routeStopsNotPlacedSentence(-1, [])).toBe(want);
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

// UXG B14 class guard: every optimize call site on mobile reads the coded 400 through optimizeUnplacedCopy. The
// operator route template once got the call on the drag-reorder handler instead (which never receives this code).
describe("optimize call sites use optimizeUnplacedCopy (caller pin)", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", "app", rel), "utf8");
  const between = (src: string, from: string, to: string) => {
    const a = src.indexOf(from);
    expect(a).toBeGreaterThanOrEqual(0);
    const b = src.indexOf(to, a + from.length);
    return src.slice(a, b === -1 ? undefined : b);
  };

  it("driver route: the optimize mutation's onError", () => {
    const src = read("(driver)/route/index.tsx");
    // The silent pre-start optimize has no onError; the explicit re-optimize button is the last call.
    const last = src.lastIndexOf("optimize.mutate(");
    const body = src.slice(last, src.indexOf("\n  };", last));
    expect(body).toContain("onError");
    expect(body).toContain("optimizeUnplacedCopy(");
  });
  it("operator route run: the optimize mutation's onError", () => {
    const src = read("(operator)/route-runs/[id].tsx");
    const body = between(src, "optimizeMut.mutate(", "\n  };");
    expect(body).toContain("onError");
    expect(body).toContain("optimizeUnplacedCopy(");
  });
  it("operator route template: handleOptimize calls it, handleDragEnd does not", () => {
    const src = read("(operator)/routes/[id].tsx");
    const optimize = between(src, "const handleOptimize", "\n  const handleDispatchConfirm");
    expect(optimize).toContain("optimizeUnplacedCopy(");
    const drag = between(src, "const handleDragEnd", "\n  const handleOptimize");
    expect(drag).not.toContain("optimizeUnplacedCopy");
  });
});

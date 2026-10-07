import { fulfilPathLabel, fulfilPathOptions } from "./fulfil-path-options";

describe("staff fulfil-path select options", () => {
  it("every fulfil path has a label, PICKUP included", () => {
    expect(fulfilPathLabel("ROUTE")).toBe("Delivery route");
    expect(fulfilPathLabel("SHIP")).toBe("Ship via carrier");
    expect(fulfilPathLabel("PICKUP")).toBe("Pick up at store");
  });

  it("a PICKUP order's select shows its own label (never blank), not selectable as a write target", () => {
    const opts = fulfilPathOptions("PICKUP");
    expect(opts.find((o) => o.value === "PICKUP")).toEqual({
      value: "PICKUP",
      label: "Pick up at store",
      disabled: true,
    });
    expect(opts.filter((o) => !o.disabled).map((o) => o.value)).toEqual(["ROUTE", "SHIP"]);
  });

  it("ROUTE / SHIP orders keep today's two options", () => {
    for (const current of ["ROUTE", "SHIP"] as const) {
      expect(fulfilPathOptions(current)).toEqual([
        { value: "ROUTE", label: "Delivery route" },
        { value: "SHIP", label: "Ship via carrier" },
      ]);
    }
  });
});

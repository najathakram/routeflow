import { pickupLineOf } from "./pickup-line";

/** W-1043 (SA-1062 MUST 20) R19: the one seam for the pickup tail of the Ready email (#3167 adds hours here). */
describe("pickupLineOf", () => {
  it("names the address after a leading space, ending in a full stop", () => {
    expect(
      pickupLineOf({ street: "12 Main St", city: "Springfield", state: "NY", zip: "12345" }),
    ).toBe(" Pick up at 12 Main St, Springfield, NY 12345.");
  });
  it("keeps what is there when the city line is partial", () => {
    expect(pickupLineOf({ street: "12 Main St", city: "Springfield" })).toBe(
      " Pick up at 12 Main St, Springfield.",
    );
    expect(pickupLineOf({ street: "12 Main St", zip: "12345" })).toBe(
      " Pick up at 12 Main St, 12345.",
    );
  });
  it("trims blanks", () => {
    expect(pickupLineOf({ street: "  12 Main St ", city: " ", state: null, zip: "" })).toBe(
      " Pick up at 12 Main St.",
    );
  });
  it.each([null, undefined, {}, { street: "  " }, { city: "Springfield", zip: "12345" }])(
    "a business with no street address reads blank: %j",
    (cfg) => {
      expect(pickupLineOf(cfg as never)).toBe("");
    },
  );
});

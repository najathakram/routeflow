import { TO_COLLECT_METHOD_VALUES } from "./to-collect";

describe("L-072: the API mirror is pinned to the shared contract", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const shared = require("@routeflow/types");

  it("TO_COLLECT_METHOD_VALUES is set-equal to @routeflow/types and a subset of PAYMENT_METHOD_VALUES", () => {
    expect([...TO_COLLECT_METHOD_VALUES].sort()).toEqual(
      [...shared.TO_COLLECT_METHOD_VALUES].sort(),
    );
    for (const m of TO_COLLECT_METHOD_VALUES) expect(shared.PAYMENT_METHOD_VALUES).toContain(m);
  });

  it("the three states are exactly TO_COLLECT, NONE and UNKNOWN", () => {
    expect([...shared.TO_COLLECT_STATE_VALUES].sort()).toEqual(["NONE", "TO_COLLECT", "UNKNOWN"]);
  });
});

/**
 * B1205: CREDITS_PENDING_COPY lives in packages/types (web + mobile read it). Mobile's jest lane
 * stubs @routeflow/types with a hand copy, which must stay byte-identical to the shared constant.
 */
import * as path from "path";

function shared(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require("@routeflow/types") as Record<string, unknown>).CREDITS_PENDING_COPY;
}

describe("CREDITS_PENDING_COPY parity (shared vs mobile stub)", () => {
  it("the shared constant exists and is a non-empty string", () => {
    expect(typeof shared()).toBe("string");
    expect((shared() as string).length).toBeGreaterThan(0);
  });

  it("mobile's @routeflow/types stub carries the identical copy", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stub = require(
      path.resolve(__dirname, "../../../mobile/__tests__/__mocks__/@routeflow/types.js"),
    ) as Record<string, unknown>;
    expect(stub.CREDITS_PENDING_COPY).toBe(shared());
  });
});

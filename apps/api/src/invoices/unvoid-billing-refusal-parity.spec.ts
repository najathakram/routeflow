import { UNVOID_REFUSAL_COPY, UNVOID_REFUSAL_REASONS } from "./unvoid-billing-refusal";

/**
 * SA-814d: the unvoid refusal's reasons and copy exist twice: `@routeflow/types` (web and mobile read them) and a
 * literal copy here (the API never value-imports that package). Pinned equal so the 409 the API sends and the copy
 * the page shows for its `reason` cannot drift apart.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const shared = require("@routeflow/types") as {
  ORDER_BILLING_CHANGED_REASONS?: Record<string, string>;
  UNVOID_BILLING_COPY?: Record<string, string>;
};

describe("unvoid refusal: API literals == @routeflow/types (SA-814d)", () => {
  it("the shared reasons and copy are exported", () => {
    expect(shared.ORDER_BILLING_CHANGED_REASONS).toBeDefined();
    expect(shared.UNVOID_BILLING_COPY).toBeDefined();
  });

  it("the reasons are equal", () => {
    expect({ ...UNVOID_REFUSAL_REASONS }).toEqual(shared.ORDER_BILLING_CHANGED_REASONS);
  });

  it("the copy is byte-equal per reason", () => {
    expect({ ...UNVOID_REFUSAL_COPY }).toEqual(shared.UNVOID_BILLING_COPY);
  });
});

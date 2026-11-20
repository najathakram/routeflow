import { COUNTER_COMPLETE_SHIPPED_MESSAGE as SHARED } from "@routeflow/types";
import { COUNTER_COMPLETE_SHIPPED_MESSAGE as API_LOCAL } from "./complete-at-counter-run";

/**
 * B1372 K4.2 (L-072 pattern): the API's 409 COUNTER_COMPLETE_SHIPPED sentence is a local literal, because the API never
 * value-imports `@routeflow/types` at runtime (no-runtime-workspace-imports.spec.ts). Web and mobile read the shared
 * copy in packages/types/counter-copy.ts. This pins the two equal, so the refusal reads the same everywhere.
 */
describe("COUNTER_COMPLETE_SHIPPED_MESSAGE parity (B1372)", () => {
  it("the api literal equals the shared copy", () => {
    expect(API_LOCAL).toBe(SHARED);
  });
});

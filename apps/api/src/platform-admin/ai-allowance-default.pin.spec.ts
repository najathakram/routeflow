import { DEFAULT_MONTHLY_AI_CAP_USD as SHARED } from "@routeflow/types";
import { DEFAULT_MONTHLY_AI_CAP_USD } from "./platform-config.service";

// The API cannot import a runtime value from @routeflow/types (no-runtime-types-import.spec.ts), so the allowance default
// lives twice: here, enforced by the cap check, and in the shared package, shown by the super admin settings screen.
// This pin keeps them equal, so the screen never shows a number the server does not enforce.
describe("the default monthly AI allowance", () => {
  it("is the same number in the API and in @routeflow/types, and is $10 (owner 2026-11-07)", () => {
    expect(DEFAULT_MONTHLY_AI_CAP_USD).toBe(SHARED);
    expect(SHARED).toBe(10);
  });
});

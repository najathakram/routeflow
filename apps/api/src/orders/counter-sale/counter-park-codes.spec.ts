import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * SA-748: PARK_LIMIT / PARK_TAKEN are the codes the web screen branches on (`packages/types/api/error-codes.ts`). The API
 * never value-imports `@routeflow/types` at runtime (L-261), so it carries literals; this spec (a spec MAY value-import
 * the package) pins them to the shared ones. The whole-object parity lives in `common/api-error-codes-parity.spec.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared = (require("@routeflow/types") as { API_ERROR_CODES: Record<string, string> })
  .API_ERROR_CODES;

describe("parked-sale error codes", () => {
  it.each(["PARK_LIMIT", "PARK_TAKEN"] as const)("%s equals the shared code", (key) => {
    expect(shared[key]).toBe(key);
    expect(API_ERROR_CODES[key]).toBe(shared[key]);
  });
});

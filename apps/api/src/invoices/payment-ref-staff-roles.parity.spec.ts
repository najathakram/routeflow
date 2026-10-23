import { RECORD_ANYWAY_ROLES as SHARED } from "../../../../packages/types/payment-ref-copy";
import { RECORD_ANYWAY_ROLES as API } from "./payment-ref-dedupe";

/**
 * Row 498 review M7: the roles that may use `recordAnyway` have ONE source, packages/types/payment-ref-copy.ts
 * (`canRecordAnyway` reads it on web and mobile). The API cannot import that package at runtime, so it keeps a
 * literal copy (the L-072 pattern) and this spec pins the two set-equal and order-equal.
 */
describe("RECORD_ANYWAY_ROLES: the API copy equals the shared list", () => {
  it("is the same list, in the same order", () => {
    expect([...API]).toEqual([...SHARED]);
  });
  it("names only staff roles (never CUSTOMER or DRIVER)", () => {
    expect([...SHARED].sort()).toEqual(["OPERATOR", "SUPER_ADMIN", "TENANT_ADMIN"]);
  });
});

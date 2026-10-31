import { READY_FOR_PICKUP_NOTICE_VALUES } from "@routeflow/types";
import { READY_RECORD_NOTICES } from "./ready-for-pickup.record";

/**
 * The record helper keeps a LOCAL notice list: `@routeflow/types` is raw TypeScript at runtime, so the compiled API may
 * not import its values (no-runtime-types-import.spec.ts). This pins the local list to the shared one, so a notice added
 * to the shared list that the API forgot fails here (and a row carrying it would otherwise be dropped from the record).
 */
describe("READY_RECORD_NOTICES", () => {
  it("is set-equal to the shared READY_FOR_PICKUP_NOTICE_VALUES", () => {
    expect([...READY_RECORD_NOTICES].sort()).toEqual([...READY_FOR_PICKUP_NOTICE_VALUES].sort());
  });
});

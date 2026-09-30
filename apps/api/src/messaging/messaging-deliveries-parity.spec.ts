import { DELIVERY_FIX_KEY_VALUES } from "./messaging-deliveries.service";
import { EMAIL_KINDS } from "../email/email-kinds";
import {
  DELIVERY_FIX_KEY_VALUES as SHARED_FIX_KEYS,
  EMAIL_KIND_VALUES,
} from "../../../../packages/types/api/messaging-delivery";
import { STAFF_ORDER_EMAIL_MODE_VALUES } from "../../../../packages/types/api/staff-order-email";

/** L-072: the API keeps local literal copies of the shared closed sets (it never value-imports
 *  `@routeflow/types`); this pins them set-equal to the shared source. */
describe("WS4 shared-type parity", () => {
  it("DELIVERY_FIX_KEY_VALUES equals the shared set", () => {
    expect([...DELIVERY_FIX_KEY_VALUES].sort()).toEqual([...SHARED_FIX_KEYS].sort());
  });
  it("EMAIL_KINDS equals the shared EMAIL_KIND_VALUES", () => {
    expect([...EMAIL_KINDS].sort()).toEqual([...EMAIL_KIND_VALUES].sort());
  });
  it("the staff order-email modes are exactly off, dark, on", () => {
    expect([...STAFF_ORDER_EMAIL_MODE_VALUES]).toEqual(["off", "dark", "on"]);
  });
});

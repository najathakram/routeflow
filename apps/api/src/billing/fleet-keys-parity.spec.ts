import { FLEET_MODULE_KEYS } from "@routeflow/types";
import { FLEET_KEYS } from "./fulfilment-capability";

/**
 * The fleet modules are listed twice on purpose: the api keeps its own `FLEET_KEYS` literal (API
 * source never imports a runtime value from the raw-TS @routeflow/types, or `node dist` fails at
 * boot), the web reads `FLEET_MODULE_KEYS`. Pinned set-equal here, in the enum-parity style (L-072).
 */
describe("fleet module keys: api FLEET_KEYS === @routeflow/types FLEET_MODULE_KEYS", () => {
  it("are set-equal", () => {
    expect([...FLEET_KEYS].sort()).toEqual([...FLEET_MODULE_KEYS].sort());
  });
});

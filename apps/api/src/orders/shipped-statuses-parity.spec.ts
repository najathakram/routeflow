/**
 * L-072 pattern: the API cannot value-import @routeflow/types, so it keeps its own SHIPPED_STATUSES
 * literal; web (ShipmentCard) and mobile (shipment-display) read the shared SHIPPED_ORDER_STATUSES from
 * packages/types. They must stay set-equal, every member a real OrderStatus, and mobile's hand stub must
 * match too (it cannot `require` the real file).
 */
import * as path from "path";
import { OrderStatus } from "@prisma/client";
import { SHIPPED_STATUSES } from "./shipment-notifications";

function shared(): readonly string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return ((require("@routeflow/types") as Record<string, unknown>).SHIPPED_ORDER_STATUSES ??
      []) as readonly string[];
  } catch {
    return [];
  }
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("SHIPPED_ORDER_STATUSES parity (shared vs api)", () => {
  it("packages/types SHIPPED_ORDER_STATUSES is set-equal to the api's SHIPPED_STATUSES", () => {
    expect(sorted(shared())).toEqual(sorted(SHIPPED_STATUSES));
  });

  it("every member is a real Prisma OrderStatus", () => {
    const all = new Set<string>(Object.values(OrderStatus));
    expect(shared().filter((s) => !all.has(s))).toEqual([]);
  });

  it("mobile's @routeflow/types stub carries the same set", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stub = require(
      path.resolve(__dirname, "../../../mobile/__tests__/__mocks__/@routeflow/types.js"),
    ) as Record<string, unknown>;
    expect(sorted((stub.SHIPPED_ORDER_STATUSES ?? []) as string[])).toEqual(
      sorted(SHIPPED_STATUSES),
    );
  });
});

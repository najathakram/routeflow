import { FulfillPath, UserRole } from "@prisma/client";
import {
  activeFulfilPath,
  assertFulfilPathOffered,
  fulfilCaller,
  resolveFulfilPath,
} from "./fulfil-path-resolver";

/**
 * W-870: POS mode (an explicit PICKUP that skips the tenant's offer) is `staffMay(role, "USE_POS_MODE", deniedGroups)`
 * over the caller's denied groups, not the role alone. An OPERATOR denied ORDERS is judged like any staff member without
 * POS mode: in a ship-only business PICKUP is not offered, so it is the coded 400. Before the fix the resolver asked the
 * role alone and gave that operator PICKUP.
 */
const deps = () => ({
  featureConfig: { getEffectiveMode: jest.fn(async () => "ship") },
  tenantId: "t1",
  logger: { warn: jest.fn() },
});
const P = FulfillPath.PICKUP;
const OP = UserRole.OPERATOR;
const denied = ["ORDERS"];

describe("fulfil-path resolver: POS mode reads the caller's denied groups (W-870)", () => {
  it("an operator denied ORDERS asking PICKUP in a ship-only business is refused (was: PICKUP)", async () => {
    const input = { explicit: P, audience: "staff" as const, role: OP, deniedGroups: denied };
    await expect(resolveFulfilPath(deps(), input)).rejects.toMatchObject({ status: 400 });
    await expect(activeFulfilPath(deps(), input)).rejects.toMatchObject({ status: 400 });
  });

  it("the PICKUP switch for that operator is refused too (was: allowed)", async () => {
    await expect(assertFulfilPathOffered(deps(), P, OP, denied)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("an operator holding ORDERS keeps POS mode", async () => {
    const input = { explicit: P, audience: "staff" as const, role: OP, deniedGroups: [] };
    expect(await resolveFulfilPath(deps(), input)).toBe(P);
    await expect(assertFulfilPathOffered(deps(), P, OP, [])).resolves.toBeUndefined();
  });

  it("fulfilCaller carries the denied groups it is given", () => {
    expect(fulfilCaller({ role: OP }, denied)).toEqual({
      audience: "staff",
      role: OP,
      deniedGroups: denied,
    });
  });
});

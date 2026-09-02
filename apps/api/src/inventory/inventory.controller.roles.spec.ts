import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { InventoryController } from "./inventory.controller";

/**
 * B168: RolesGuard resolves `getAllAndOverride(handler, class)`, so a handler-level
 * @Roles(OPERATOR, DRIVER) OVERRIDES the class-level @Roles(OPERATOR). Four writes
 * carried that override after the driver PO/inventory screens were deleted.
 */
describe("InventoryController effective @Roles (B168)", () => {
  const reflector = new Reflector();
  const proto = InventoryController.prototype as Record<string, any>;
  const effective = (h: string) => {
    expect(typeof proto[h]).toBe("function");
    return reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [proto[h], InventoryController]);
  };

  // T12 (REG-B168) — one case PER HANDLER. A single loop inside one `it` aborts at
  // the first failure, so only `recordPurchase` would ever be evidenced and a
  // regression on any later handler would stay invisible behind it.
  it.each([
    "recordPurchase",
    "recordAdjustment",
    "createPO",
    "receivePO",
    "commitStockCount",
    "sendPO",
    "closePO",
  ])("REG-B168 %s resolves to exactly [OPERATOR] — no DRIVER", (h) => {
    expect(effective(h)).toEqual([UserRole.OPERATOR]);
  });

  // T13 — over-reach fence: reads are out of scope for this batch (spec §4), so this
  // stays GREEN on both sides of the fix and goes red only on scope creep. It keeps
  // the REG-B168 token because it is the only coverage of R7's "reads keep DRIVER"
  // clause and campaign-check reads traceability from the title.
  it("REG-B168 (fence) the four inventory reads still admit DRIVER", () => {
    for (const h of ["getStockOverview", "listMovements", "listPOs", "getPO"]) {
      expect(effective(h)).toEqual(expect.arrayContaining([UserRole.OPERATOR, UserRole.DRIVER]));
    }
  });
});

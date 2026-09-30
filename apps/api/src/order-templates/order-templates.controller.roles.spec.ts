import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { OrderTemplatesController } from "./order-templates.controller";

/**
 * B133: four standing-order mutations still admitted DRIVER after the driver
 * screens that motivated the grant were deleted (028f86b0). generateDailyOrders
 * (06:00 cron) materialises whatever a driver wrote into billed orders.
 */
describe("OrderTemplatesController @Roles matrix (B133)", () => {
  const reflector = new Reflector();
  const proto = OrderTemplatesController.prototype as Record<string, any>;
  const rolesOf = (h: string) => {
    expect(typeof proto[h]).toBe("function");
    return reflector.get<UserRole[]>(ROLES_KEY, proto[h]);
  };

  // T9 (REG-B133) — one case PER HANDLER. A single loop inside one `it` aborts at
  // the first failure, so only `create` would ever be evidenced and a regression on
  // any later mutation would stay invisible behind it. `not.toContain` is the honest
  // negation: `expect.not.arrayContaining([...])` negates the CONJUNCTION and would
  // pass on any array merely missing ONE of the listed roles.
  it.each(["create", "update", "remove", "addItem", "removeItem", "generateOrder"])(
    "REG-B133 %s declares roles and does not admit DRIVER",
    (h) => {
      const roles = rolesOf(h);
      // Guards the rename-vacuity trap: an undeclared handler must fail here, not
      // slip through because `undefined` trivially "contains no DRIVER".
      expect(Array.isArray(roles) && roles.length > 0).toBe(true);
      expect(roles).not.toContain(UserRole.DRIVER);
    },
  );

  // T9 (REG-B133)
  it("REG-B133 the matrix is {OPERATOR, CUSTOMER} for owner-scoped mutations and [OPERATOR] for addItem", () => {
    for (const h of ["create", "update", "remove", "removeItem", "generateOrder"]) {
      expect([...rolesOf(h)].sort()).toEqual([UserRole.CUSTOMER, UserRole.OPERATOR].sort());
    }
    expect(rolesOf("addItem")).toEqual([UserRole.OPERATOR]);
  });

  // T9 pin — findAll/findOne are unchanged by this batch; recorded so a later
  // change to their access is deliberate, not an accidental widening.
  it("pin (B133): findAll/findOne carry no @Roles (recorded residual — a DRIVER can still list)", () => {
    expect(reflector.get(ROLES_KEY, proto.findAll)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, proto.findOne)).toBeUndefined();
  });

  // T10 (REG-B133): symmetry with the removeItem -> removeItemForUser delegation
  // already on this controller — addItem must route through the same kind of
  // ownership wrapper instead of calling the unscoped service method directly.
  it("REG-B133 addItem delegates to the ownership wrapper addItemForUser, never to addItem", async () => {
    const svc = { addItemForUser: jest.fn().mockResolvedValue("ok"), addItem: jest.fn() };
    const ctrl = new OrderTemplatesController(svc as any) as any;
    const dto = { productId: "p1", qty: 2 };
    const user = { sub: "u1", role: "OPERATOR" };

    const result = await ctrl.addItem("t1", dto, user);

    expect(result).toBe("ok");
    expect(svc.addItemForUser).toHaveBeenCalledWith("t1", dto, user);
    expect(svc.addItem).not.toHaveBeenCalled();
  });
});

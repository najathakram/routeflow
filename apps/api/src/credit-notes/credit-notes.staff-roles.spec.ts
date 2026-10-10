/**
 * #2403 / SA-436 PR-3: removing (un-applying) and voiding a credit note are STAFF actions —
 * OPERATOR and TENANT_ADMIN named explicitly on the handlers — and DRIVER / CUSTOMER are refused
 * through the real RolesGuard.
 */
import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CreditNotesController } from "./credit-notes.controller";

const HANDLERS = ["unapply", "voidNote"] as const;

function ctxFor(handler: (typeof HANDLERS)[number], role: UserRole): ExecutionContext {
  return {
    getHandler: () => CreditNotesController.prototype[handler],
    getClass: () => CreditNotesController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

describe("credit-note staff actions — roles (#2403, SA-436 PR-3)", () => {
  const guard = new RolesGuard(new Reflector());

  it.each(HANDLERS)("%s names OPERATOR and TENANT_ADMIN", (handler) => {
    const roles = Reflect.getMetadata(ROLES_KEY, CreditNotesController.prototype[handler]);
    expect(roles).toEqual(expect.arrayContaining([UserRole.OPERATOR, UserRole.TENANT_ADMIN]));
  });

  it.each(HANDLERS)("%s: OPERATOR, TENANT_ADMIN and SUPER_ADMIN pass the guard", (handler) => {
    for (const role of [UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN]) {
      expect(guard.canActivate(ctxFor(handler, role))).toBe(true);
    }
  });

  it.each(HANDLERS)("%s: DRIVER and CUSTOMER are refused", (handler) => {
    for (const role of [UserRole.DRIVER, UserRole.CUSTOMER]) {
      expect(guard.canActivate(ctxFor(handler, role))).toBe(false);
    }
  });
});

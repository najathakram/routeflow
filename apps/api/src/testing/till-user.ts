import { UserRole } from "@prisma/client";

/**
 * W-870: the principal the office payment paths (void, delete, update, check bounce) now REQUIRE. A tenant admin ignores
 * denied groups, so a spec that is not about the permission check passes this and reads no permissions row.
 */
export const TILL_ADMIN = { sub: "spec-admin", role: UserRole.TENANT_ADMIN, tenantId: "t-1" };

interface TillPaymentService {
  deletePayment: (inv: string, pay: string, user: typeof TILL_ADMIN) => Promise<unknown>;
  voidPayment: (inv: string, pay: string, user: typeof TILL_ADMIN) => Promise<unknown>;
  setCheckStatus: (
    inv: string,
    pay: string,
    dto: never,
    user: typeof TILL_ADMIN,
  ) => Promise<unknown>;
  updatePayment: (
    inv: string,
    pay: string,
    dto: never,
    ctx: { user: typeof TILL_ADMIN },
  ) => Promise<unknown>;
}

/**
 * Short callers for the four office payment paths as a tenant admin (W-870), for specs that are not about the permission
 * check. `get` reads the service lazily because the specs build it in a `beforeEach`.
 */
export function tillCalls<S extends TillPaymentService>(get: () => S) {
  return {
    setStatus: (dto: object) => get().setCheckStatus("inv-1", "pay-1", dto as never, TILL_ADMIN),
    delPay: (inv: string, pay: string) => get().deletePayment(inv, pay, TILL_ADMIN),
    voidPay: (inv: string, pay: string) => get().voidPayment(inv, pay, TILL_ADMIN),
    editPay: (dto: object, opts: object = {}) =>
      get().updatePayment("inv-1", "pay-1", dto as never, { ...opts, user: TILL_ADMIN }),
    editOf: (inv: string, pay: string, dto: object) =>
      get().updatePayment(inv, pay, dto as never, { user: TILL_ADMIN }),
  };
}

/**
 * W-870: the module mock for `till-permission.guard` in a spec that is not about the permission check. The real
 * `operatorDeniedGroups` reads the user's permissions row; a mocked Prisma has none, so a fail-closed read would deny
 * every group to an OPERATOR. Use as
 * `jest.mock("<rel>/orders/counter-sale/till-permission.guard", () => require("<rel>/testing/till-user").tillGuardMock())`;
 * pass the groups to deny for a spec that is about a denial.
 */
export function tillGuardMock(denied: readonly string[] = []) {
  return {
    ...jest.requireActual("../orders/counter-sale/till-permission.guard"),
    operatorDeniedGroups: async () => [...denied],
  };
}

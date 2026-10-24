import { startOfLocalDay } from "../../common/calendar-date";
import * as api from "./staff-capabilities";

/**
 * L-261: the API never value-imports @routeflow/types, so the staff capability table, the void window policy and both
 * helpers are API literals. A spec may import the shared copy, and pins the two deep-equal: the table and the
 * policy by value, the helpers by behaviour across every role x action x denial combination.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared: typeof api = require("@routeflow/types");

describe("staff-capabilities: the API literal is pinned to packages/types", () => {
  it("STAFF_CAPABILITY_VALUES and STAFF_CAPABILITY_RULES are deep-equal", () => {
    expect([...api.STAFF_CAPABILITY_VALUES]).toEqual([...shared.STAFF_CAPABILITY_VALUES]);
    expect(api.STAFF_CAPABILITY_RULES).toEqual(shared.STAFF_CAPABILITY_RULES);
  });

  it("the table names the POS-mode rows in both copies", () => {
    for (const copy of [api, shared]) {
      expect(copy.STAFF_CAPABILITY_RULES.USE_POS_MODE.group).toBe("ORDERS");
      expect(copy.STAFF_CAPABILITY_RULES.EDIT_AFTER_FINAL.group).toBe("FINANCE");
      expect(copy.STAFF_CAPABILITY_RULES.OVERRIDE_SELLING_RESTRICTION.roles).toEqual([
        "OPERATOR",
        "TENANT_ADMIN",
      ]);
    }
  });

  it("COUNTER_VOID_WINDOW and COUNTER_VOID_WINDOW_VALUES are deep-equal", () => {
    expect(api.COUNTER_VOID_WINDOW).toBe(shared.COUNTER_VOID_WINDOW);
    expect([...api.COUNTER_VOID_WINDOW_VALUES]).toEqual([...shared.COUNTER_VOID_WINDOW_VALUES]);
  });

  it("staffMay answers identically for every role x action x denial set", () => {
    const roles = [
      "OPERATOR",
      "TENANT_ADMIN",
      "SUPER_ADMIN",
      "DRIVER",
      "CUSTOMER",
      "X",
      null,
      undefined,
    ];
    const denials: string[][] = [
      [],
      ["PRICING"],
      ["ORDERS"],
      ["FINANCE"],
      ["PRICING", "ORDERS"],
      ["ORDERS", "FINANCE"],
      ["PRICING", "ORDERS", "FINANCE"],
    ];
    for (const role of roles) {
      for (const action of api.STAFF_CAPABILITY_VALUES) {
        for (const denied of denials) {
          expect(api.staffMay(role, action, denied)).toBe(shared.staffMay(role, action, denied));
        }
        expect(api.staffMay(role, action)).toBe(shared.staffMay(role, action));
      }
    }
  });

  it("voidWindowAllows answers identically at the day edges and when closed", () => {
    const zone = "Pacific/Auckland";
    const nowTenantDay = {
      start: startOfLocalDay("2026-10-08", zone),
      end: startOfLocalDay("2026-10-09", zone),
    };
    const edges = [
      new Date(nowTenantDay.start.getTime() - 1),
      nowTenantDay.start,
      new Date(nowTenantDay.end.getTime() - 1),
      nowTenantDay.end,
    ];
    for (const saleCreatedAt of edges) {
      for (const windowClosed of [false, true]) {
        const ctx = { saleCreatedAt, nowTenantDay, windowClosed };
        expect(api.voidWindowAllows(api.COUNTER_VOID_WINDOW, ctx)).toBe(
          shared.voidWindowAllows(shared.COUNTER_VOID_WINDOW, ctx),
        );
      }
    }
  });
});

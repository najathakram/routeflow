import { startOfLocalDay } from "../../common/calendar-date";
import {
  COUNTER_VOID_WINDOW,
  COUNTER_VOID_WINDOW_VALUES,
  STAFF_CAPABILITY_RULES,
  STAFF_CAPABILITY_VALUES,
  staffMay,
  voidWindowAllows,
} from "./staff-capabilities";

describe("staffMay (SA-762r Ruling A): one table, one helper", () => {
  it("OPERATOR and TENANT_ADMIN may do both actions", () => {
    for (const role of ["OPERATOR", "TENANT_ADMIN"]) {
      expect(staffMay(role, "EDIT_LINE_PRICE")).toBe(true);
      expect(staffMay(role, "VOID_SALE")).toBe(true);
    }
  });

  it("SUPER_ADMIN may void a sale but may not edit a line price (F4)", () => {
    expect(staffMay("SUPER_ADMIN", "VOID_SALE")).toBe(true);
    expect(staffMay("SUPER_ADMIN", "EDIT_LINE_PRICE")).toBe(false);
  });

  it("DRIVER, CUSTOMER, an unknown role and no role may do neither", () => {
    for (const role of ["DRIVER", "CUSTOMER", "WIZARD", "", null, undefined]) {
      for (const action of STAFF_CAPABILITY_VALUES) expect(staffMay(role, action)).toBe(false);
    }
  });

  it("an OPERATOR denied PRICING loses EDIT_LINE_PRICE but keeps VOID_SALE", () => {
    expect(staffMay("OPERATOR", "EDIT_LINE_PRICE", ["PRICING"])).toBe(false);
    expect(staffMay("OPERATOR", "VOID_SALE", ["PRICING"])).toBe(true);
    expect(staffMay("OPERATOR", "VOID_SALE", ["ORDERS"])).toBe(false);
    expect(staffMay("OPERATOR", "EDIT_LINE_PRICE", ["ORDERS"])).toBe(true);
  });

  it("TENANT_ADMIN and SUPER_ADMIN ignore denials", () => {
    expect(staffMay("TENANT_ADMIN", "EDIT_LINE_PRICE", ["PRICING"])).toBe(true);
    expect(staffMay("TENANT_ADMIN", "VOID_SALE", ["ORDERS", "PRICING"])).toBe(true);
    expect(staffMay("SUPER_ADMIN", "VOID_SALE", ["ORDERS"])).toBe(true);
  });

  it("every action has a row, and the rows are exactly the action list", () => {
    expect(Object.keys(STAFF_CAPABILITY_RULES).sort()).toEqual([...STAFF_CAPABILITY_VALUES].sort());
    expect(STAFF_CAPABILITY_RULES.EDIT_LINE_PRICE.group).toBe("PRICING");
    expect(STAFF_CAPABILITY_RULES.VOID_SALE.group).toBe("ORDERS");
  });
});

describe("staffMay: the POS-mode rows (SA-763r)", () => {
  it("USE_POS_MODE is OPERATOR + TENANT_ADMIN, group ORDERS; nobody else", () => {
    expect(STAFF_CAPABILITY_RULES.USE_POS_MODE).toEqual({
      roles: ["OPERATOR", "TENANT_ADMIN"],
      group: "ORDERS",
    });
    for (const role of ["OPERATOR", "TENANT_ADMIN"])
      expect(staffMay(role, "USE_POS_MODE")).toBe(true);
    for (const role of ["SUPER_ADMIN", "DRIVER", "CUSTOMER", null, undefined]) {
      expect(staffMay(role, "USE_POS_MODE")).toBe(false);
    }
  });

  it("an OPERATOR denied ORDERS loses USE_POS_MODE; a denied PRICING keeps it", () => {
    expect(staffMay("OPERATOR", "USE_POS_MODE", ["ORDERS"])).toBe(false);
    expect(staffMay("OPERATOR", "USE_POS_MODE", ["PRICING", "FINANCE"])).toBe(true);
    expect(staffMay("TENANT_ADMIN", "USE_POS_MODE", ["ORDERS"])).toBe(true);
  });

  it("EDIT_AFTER_FINAL is OPERATOR + TENANT_ADMIN, group FINANCE; nobody else", () => {
    expect(STAFF_CAPABILITY_RULES.EDIT_AFTER_FINAL).toEqual({
      roles: ["OPERATOR", "TENANT_ADMIN"],
      group: "FINANCE",
    });
    for (const role of ["OPERATOR", "TENANT_ADMIN"]) {
      expect(staffMay(role, "EDIT_AFTER_FINAL")).toBe(true);
    }
    for (const role of ["SUPER_ADMIN", "DRIVER", "CUSTOMER", null, undefined]) {
      expect(staffMay(role, "EDIT_AFTER_FINAL")).toBe(false);
    }
  });

  it("an OPERATOR denied FINANCE loses EDIT_AFTER_FINAL; a denied ORDERS keeps it", () => {
    expect(staffMay("OPERATOR", "EDIT_AFTER_FINAL", ["FINANCE"])).toBe(false);
    expect(staffMay("OPERATOR", "EDIT_AFTER_FINAL", ["ORDERS", "PRICING"])).toBe(true);
    expect(staffMay("TENANT_ADMIN", "EDIT_AFTER_FINAL", ["FINANCE"])).toBe(true);
  });
});

describe("staffMay: the restriction-override row (row 510)", () => {
  it("OVERRIDE_SELLING_RESTRICTION is OPERATOR + TENANT_ADMIN, group ORDERS; DRIVER, SUPER_ADMIN and CUSTOMER may not", () => {
    expect(STAFF_CAPABILITY_RULES.OVERRIDE_SELLING_RESTRICTION).toEqual({
      roles: ["OPERATOR", "TENANT_ADMIN"],
      group: "ORDERS",
    });
    for (const role of ["OPERATOR", "TENANT_ADMIN"])
      expect(staffMay(role, "OVERRIDE_SELLING_RESTRICTION")).toBe(true);
    for (const role of ["DRIVER", "SUPER_ADMIN", "CUSTOMER", "", null, undefined])
      expect(staffMay(role, "OVERRIDE_SELLING_RESTRICTION")).toBe(false);
  });

  it("an OPERATOR denied ORDERS loses it; TENANT_ADMIN ignores the denial", () => {
    expect(staffMay("OPERATOR", "OVERRIDE_SELLING_RESTRICTION", ["ORDERS"])).toBe(false);
    expect(staffMay("OPERATOR", "OVERRIDE_SELLING_RESTRICTION", ["PRICING", "FINANCE"])).toBe(true);
    expect(staffMay("TENANT_ADMIN", "OVERRIDE_SELLING_RESTRICTION", ["ORDERS"])).toBe(true);
  });
});

describe("voidWindowAllows: SAME_TENANT_DAY_BEFORE_CLOSE", () => {
  // A tenant in New York on 2026-10-08 (EDT, UTC-4): its day is [04:00Z on the 8th, 04:00Z on the 9th).
  const zone = "America/New_York";
  const nowTenantDay = {
    start: startOfLocalDay("2026-10-08", zone),
    end: startOfLocalDay("2026-10-09", zone),
  };
  const allow = (saleCreatedAt: string, windowClosed = false) =>
    voidWindowAllows(COUNTER_VOID_WINDOW, {
      saleCreatedAt: new Date(saleCreatedAt),
      nowTenantDay,
      windowClosed,
    });

  it("the policy in force is the one the owner chose", () => {
    expect(COUNTER_VOID_WINDOW).toBe("SAME_TENANT_DAY_BEFORE_CLOSE");
    expect([...COUNTER_VOID_WINDOW_VALUES]).toEqual(["SAME_TENANT_DAY_BEFORE_CLOSE"]);
  });

  it("is true at 23:59 tenant-local on the sale day, and at the day's first instant", () => {
    expect(allow("2026-10-09T03:59:00.000Z")).toBe(true); // 23:59 local, but already the 9th in UTC
    expect(allow("2026-10-08T04:00:00.000Z")).toBe(true); // 00:00 local
  });

  it("is false at 00:00 the next tenant-local day, and just before the day began (tenant zone, not UTC)", () => {
    expect(allow("2026-10-09T04:00:00.000Z")).toBe(false); // 00:00 local on the 9th
    expect(allow("2026-10-08T03:59:00.000Z")).toBe(false); // 23:59 local on the 7th, still the 8th in UTC
  });

  it("is false whenever the window is closed, even for a sale made seconds ago", () => {
    expect(allow("2026-10-08T15:00:00.000Z", true)).toBe(false);
  });
});

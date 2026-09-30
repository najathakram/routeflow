import {
  buildRoutePatch,
  canEditSellingRules,
  depotContext,
  digestPatch,
  isDigestOn,
  notReadyMessage,
  restrictionsSummary,
  routeDefaultsFormFrom,
  showDigestToggle,
  validateRouteDefaults,
  type RouteDefaultsForm,
} from "../lib/settings-parity-logic";

// Vectors mirror apps/web RouteDefaultsCard.test.tsx / its validate() — mobile mirrors web.
// TODO(after Settings PR-1 #2792 lands): move validate/build into packages/types so this mirror dies.

const OK: RouteDefaultsForm = { service: "10", start: "08:00", speed: "40", lat: "", lng: "" };

describe("validateRouteDefaults", () => {
  it("accepts a clean form", () => {
    expect(validateRouteDefaults(OK)).toEqual({});
  });

  it.each([
    ["-1", false],
    ["0", true],
    ["120", true],
    ["121", false],
    ["1.5", false],
    ["", false],
    ["abc", false],
  ])("service time %p -> valid=%p", (service, valid) => {
    const errs = validateRouteDefaults({ ...OK, service });
    expect(errs.service === undefined).toBe(valid);
    if (!valid) expect(errs.service).toMatch(/0 and 120/);
  });

  it.each([
    ["08:00", true],
    ["23:59", true],
    ["24:00", false],
    ["8:00", false],
    ["08:60", false],
    ["", false],
  ])("start time %p -> valid=%p", (start, valid) => {
    const errs = validateRouteDefaults({ ...OK, start });
    expect(errs.start === undefined).toBe(valid);
    if (!valid) expect(errs.start).toMatch(/HH:MM/);
  });

  it.each([
    ["0", false],
    ["1", true],
    ["200", true],
    ["201", false],
    ["", false],
  ])("speed %p -> valid=%p", (speed, valid) => {
    const errs = validateRouteDefaults({ ...OK, speed });
    expect(errs.speed === undefined).toBe(valid);
    if (!valid) expect(errs.speed).toMatch(/1 and 200/);
  });

  it("needs latitude and longitude together or not at all", () => {
    expect(validateRouteDefaults({ ...OK, lat: "34", lng: "" }).lng).toMatch(
      /both latitude and longitude/i,
    );
    expect(validateRouteDefaults({ ...OK, lat: "", lng: "-118" }).lat).toMatch(
      /both latitude and longitude/i,
    );
    expect(validateRouteDefaults({ ...OK, lat: "34", lng: "-118" })).toEqual({});
  });

  it("rejects out-of-range coordinates and accepts the 0/0 boundary", () => {
    const bad = validateRouteDefaults({ ...OK, lat: "91", lng: "-181" });
    expect(bad.lat).toMatch(/-90 and 90/);
    expect(bad.lng).toMatch(/-180 and 180/);
    expect(validateRouteDefaults({ ...OK, lat: "0", lng: "0" })).toEqual({});
  });
});

describe("buildRoutePatch", () => {
  it("sends numbers as numbers and OMITS the depot when both fields are blank (keep as is)", () => {
    const patch = buildRoutePatch(OK);
    expect(patch).toEqual({
      serviceTimeMinutes: 10,
      defaultStartTime: "08:00",
      averageSpeedKmh: 40,
    });
    expect(patch).not.toHaveProperty("depotLat");
    expect(patch).not.toHaveProperty("depotLng");
  });

  it("sends both depot coordinates when both are set, including 0/0", () => {
    expect(buildRoutePatch({ ...OK, lat: "34.05", lng: "-118.2" })).toMatchObject({
      depotLat: 34.05,
      depotLng: -118.2,
    });
    expect(buildRoutePatch({ ...OK, lat: "0", lng: "0" })).toMatchObject({
      depotLat: 0,
      depotLng: 0,
    });
  });
});

describe("route defaults form + depot context", () => {
  const DATA = {
    serviceTimeMinutes: 10,
    defaultStartTime: "08:00",
    averageSpeedKmh: 40,
    depotLat: 33.9,
    depotLng: -118.2,
    depotAddress: "1 Main St, Springfield",
  };

  it("never prefills the depot inputs (GET may return a geocode cache)", () => {
    expect(routeDefaultsFormFrom(DATA)).toEqual({
      service: "10",
      start: "08:00",
      speed: "40",
      lat: "",
      lng: "",
    });
  });

  it("names the SAVED coordinates first, the business address only when none is saved", () => {
    expect(depotContext(DATA)).toBe("Routes currently start from 33.9, -118.2.");
    expect(depotContext({ ...DATA, depotLat: null, depotLng: null })).toBe(
      "Routes currently start from 1 Main St, Springfield.",
    );
    expect(depotContext({ ...DATA, depotLat: null, depotLng: null, depotAddress: "" })).toBe(
      "No depot is set yet.",
    );
    expect(depotContext(undefined)).toBe("No depot is set yet.");
  });
});

describe("low-stock digest", () => {
  it("is ON when absent (opt-out) and only the string 'false' turns it off", () => {
    expect(isDigestOn(undefined)).toBe(true);
    expect(isDigestOn({})).toBe(true);
    expect(isDigestOn({ lowStockDigestEnabled: "true" })).toBe(true);
    expect(isDigestOn({ lowStockDigestEnabled: "false" })).toBe(false);
    expect(isDigestOn({ lowStockDigestEnabled: "no" })).toBe(true);
  });

  it("writes the preference under the shared key as 'true'/'false'", () => {
    expect(digestPatch(false)).toEqual({ lowStockDigestEnabled: "false" });
    expect(digestPatch(true)).toEqual({ lowStockDigestEnabled: "true" });
  });

  it("is shown to a TENANT_ADMIN only (the digest goes to admins)", () => {
    expect(showDigestToggle("TENANT_ADMIN")).toBe(true);
    expect(showDigestToggle("OPERATOR")).toBe(false);
    expect(showDigestToggle("DRIVER")).toBe(false);
    expect(showDigestToggle(undefined)).toBe(false);
  });
});

describe("selling restrictions entry", () => {
  it("summarises the switch and the governing address in plain words", () => {
    expect(restrictionsSummary({ enabled: false, governingAddress: "BILLING_FIRST" })).toBe(
      "Off — restricted products can be sold to any customer.",
    );
    expect(restrictionsSummary({ enabled: true, governingAddress: "BILLING_FIRST" })).toBe(
      "On — the billing address decides first.",
    );
    expect(restrictionsSummary({ enabled: true, governingAddress: "SHIPPING_FIRST" })).toBe(
      "On — the shipping address decides first.",
    );
    expect(restrictionsSummary(undefined)).toBe("");
  });

  it("only a TENANT_ADMIN can edit; operators read", () => {
    expect(canEditSellingRules("TENANT_ADMIN")).toBe(true);
    expect(canEditSellingRules("OPERATOR")).toBe(false);
    expect(canEditSellingRules("DRIVER")).toBe(false);
  });

  it("honours readiness.truncated like web: too large to check, ask support", () => {
    const err = {
      response: {
        status: 409,
        data: {
          code: "SELLING_RESTRICTIONS_NOT_READY",
          readiness: { truncated: true, customersWithoutAddress: 0 },
        },
      },
    };
    expect(notReadyMessage(err)).toMatch(/too large to check in one pass; ask support/);
    const withCounts = {
      response: {
        status: 409,
        data: {
          code: "SELLING_RESTRICTIONS_NOT_READY",
          readiness: { truncated: true, customersWithoutAddress: 2 },
        },
      },
    };
    const msg = notReadyMessage(withCounts)!;
    expect(msg).toMatch(/too large to check/);
    expect(msg).toMatch(/2 customers without an address/);
  });

  it("turns the 409 SELLING_RESTRICTIONS_NOT_READY into a plain reason, never raw codes", () => {
    const err = {
      response: {
        status: 409,
        data: {
          code: "SELLING_RESTRICTIONS_NOT_READY",
          readiness: { customersWithoutAddress: 3, addressesMissingStateCode: 2 },
        },
      },
    };
    const msg = notReadyMessage(err)!;
    expect(msg).toMatch(/3 customers? without an address/);
    expect(msg).toMatch(/2 addresses? missing a state/);
    expect(msg).not.toMatch(/SELLING_RESTRICTIONS|409/);
    expect(notReadyMessage({ response: { status: 409, data: { code: "OTHER" } } })).toBeNull();
    expect(notReadyMessage(new Error("net"))).toBeNull();
  });
});

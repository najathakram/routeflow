import {
  bulkPortalPayload,
  canBulkSetPortalVisibility,
  portalBadge,
  portalVisibleFilterParam,
} from "./product-portal-visibility-ui";

describe("product portal visibility UI logic", () => {
  it("filter adds portalVisible=false only when on", () => {
    expect(portalVisibleFilterParam(true)).toEqual({ portalVisible: false });
    expect(portalVisibleFilterParam(false)).toEqual({});
  });
  it("badge: own flag beats parent; hidden parent marks the variant", () => {
    expect(portalBadge({ portalVisible: false, parent: { portalVisible: true } })).toBe("hidden");
    expect(portalBadge({ portalVisible: false, parent: { portalVisible: false } })).toBe("hidden");
    expect(portalBadge({ portalVisible: true, parent: { portalVisible: false } })).toBe(
      "hidden-by-parent",
    );
    expect(portalBadge({ portalVisible: true, parent: null })).toBeNull();
    expect(portalBadge({})).toBeNull();
  });
  it("bulk controls only for TENANT_ADMIN with a selection", () => {
    expect(canBulkSetPortalVisibility("TENANT_ADMIN", 2)).toBe(true);
    expect(canBulkSetPortalVisibility("TENANT_ADMIN", 0)).toBe(false);
    expect(canBulkSetPortalVisibility("OPERATOR", 2)).toBe(false);
    expect(canBulkSetPortalVisibility(undefined, 2)).toBe(false);
  });
  it("bulk payload is the selected ids", () => {
    expect(bulkPortalPayload(new Set(["a", "b"]), false)).toEqual({
      ids: ["a", "b"],
      portalVisible: false,
    });
  });
});

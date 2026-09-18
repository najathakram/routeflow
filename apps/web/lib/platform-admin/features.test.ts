// Regression coverage for the wrapper-shape mismatch caught against the real local backend:
// `GET /platform-admin/tenants/:id/features/effective` returns `{ effective: [...] }`, not a
// bare array. Mocks the HTTP client itself (not this module) so a future contract drift back
// to a bare array — or a change on the API side — shows up here first.
import {
  enableTenantAddon,
  fetchTenantBillingInfo,
  fetchTenantFeaturesEffective,
} from "./features";
import { superAdminClient } from "@/lib/admin-api";
import type { EffectiveFeature } from "@/app/(platform-admin)/admin/tenants/[id]/_features/types";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: jest.fn(), post: jest.fn() },
}));

const mockGet = superAdminClient.get as jest.Mock;
const mockPost = superAdminClient.post as jest.Mock;

const ROW: EffectiveFeature = {
  key: "msrp",
  area: "compliance",
  serving: true,
  resolver: true,
  source: "PRESET",
  detail: { planKey: "GROWTH", catalogVersionId: "catalog-v11", enforced: true },
  billing: { charged: false },
};

describe("fetchTenantFeaturesEffective", () => {
  beforeEach(() => mockGet.mockReset());

  it("unwraps the real `{ effective: [...] }` wrapper into a bare array", async () => {
    mockGet.mockResolvedValueOnce({ data: { effective: [ROW] } });

    const result = await fetchTenantFeaturesEffective("tenant-1");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([ROW]);
  });

  it("requests the tenant-scoped endpoint", async () => {
    mockGet.mockResolvedValueOnce({ data: { effective: [] } });

    await fetchTenantFeaturesEffective("tenant-1");

    expect(mockGet).toHaveBeenCalledWith("/platform-admin/tenants/tenant-1/features/effective");
  });
});

describe("fetchTenantBillingInfo", () => {
  beforeEach(() => mockGet.mockReset());

  it("reads the existing tenant billing endpoint and coerces stripeConfigured to a boolean", async () => {
    mockGet.mockResolvedValueOnce({ data: { stripeConfigured: true, tenant: {} } });

    const result = await fetchTenantBillingInfo("tenant-1");

    expect(mockGet).toHaveBeenCalledWith("/platform-admin/tenants/tenant-1/billing");
    expect(result).toEqual({ stripeConfigured: true });
  });

  it("defaults to false when the field is missing", async () => {
    mockGet.mockResolvedValueOnce({ data: {} });

    expect(await fetchTenantBillingInfo("tenant-1")).toEqual({ stripeConfigured: false });
  });
});

describe("enableTenantAddon", () => {
  beforeEach(() => mockPost.mockReset());

  it("posts to the existing /addons/enable endpoint — never /feature-overrides", async () => {
    mockPost.mockResolvedValueOnce({ data: { id: "addon-1" } });

    await enableTenantAddon("tenant-1", "ocr", "price_123");

    expect(mockPost).toHaveBeenCalledWith("/platform-admin/tenants/tenant-1/addons/enable", {
      addonKey: "ocr",
      stripePriceId: "price_123",
    });
  });

  it("omits stripePriceId entirely for a free grant (never sends an empty string)", async () => {
    mockPost.mockResolvedValueOnce({ data: { id: "addon-1" } });

    await enableTenantAddon("tenant-1", "ocr");

    expect(mockPost).toHaveBeenCalledWith("/platform-admin/tenants/tenant-1/addons/enable", {
      addonKey: "ocr",
    });
  });
});

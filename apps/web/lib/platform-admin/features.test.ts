// Regression coverage for the wrapper-shape mismatch caught against the real local backend:
// `GET /platform-admin/tenants/:id/features/effective` returns `{ effective: [...] }`, not a
// bare array. Mocks the HTTP client itself (not this module) so a future contract drift back
// to a bare array — or a change on the API side — shows up here first.
import { fetchTenantFeaturesEffective } from "./features";
import { superAdminClient } from "@/lib/admin-api";
import type { EffectiveFeature } from "@/app/(platform-admin)/admin/tenants/[id]/_features/types";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: jest.fn() },
}));

const mockGet = superAdminClient.get as jest.Mock;

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

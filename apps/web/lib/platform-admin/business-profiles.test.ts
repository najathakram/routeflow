import { fetchBusinessCapabilities } from "./business-profiles";
import { superAdminClient } from "@/lib/admin-api";
import type { BusinessCapabilities } from "@routeflow/types";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: jest.fn(), post: jest.fn() },
}));

const mockGet = superAdminClient.get as jest.Mock;

describe("fetchBusinessCapabilities", () => {
  beforeEach(() => mockGet.mockReset());

  it("reads the tenant's ticks from its business-capabilities route", async () => {
    const body: BusinessCapabilities = {
      configured: true,
      delivery: true,
      doorPayments: true,
      shipping: false,
      counter: true,
      opensAs: "order",
      opensAsChoosable: false,
      counterCapability: "optional",
      fleetHeld: true,
      matchedPreset: "delivery_pos",
    };
    mockGet.mockResolvedValueOnce({ data: body });

    const result = await fetchBusinessCapabilities("tenant-acme");

    expect(mockGet).toHaveBeenCalledWith(
      "/platform-admin/tenants/tenant-acme/business-capabilities",
    );
    expect(result).toEqual(body);
  });
});

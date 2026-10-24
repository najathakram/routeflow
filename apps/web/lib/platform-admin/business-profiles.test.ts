import {
  applyBusinessCapabilities,
  fetchBusinessCapabilities,
  previewBusinessCapabilities,
} from "./business-profiles";
import { superAdminClient } from "@/lib/admin-api";
import type { BusinessCapabilities } from "@routeflow/types";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: jest.fn(), post: jest.fn() },
}));

const mockGet = superAdminClient.get as jest.Mock;
const mockPost = superAdminClient.post as jest.Mock;

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

describe("previewBusinessCapabilities / applyBusinessCapabilities (BO-04)", () => {
  beforeEach(() => mockPost.mockReset());

  it("previews the ticks on the tenant's business-capabilities/preview route, sending only what was ticked", async () => {
    mockPost.mockResolvedValueOnce({ data: { planFingerprint: "f".repeat(64), blocked: null } });
    const ticks = { delivery: true, doorPayments: false, shipping: true, counter: false };

    const res = await previewBusinessCapabilities("tenant-acme", ticks);

    expect(mockPost).toHaveBeenCalledWith(
      "/platform-admin/tenants/tenant-acme/business-capabilities/preview",
      ticks,
    );
    expect(res.planFingerprint).toBe("f".repeat(64));
  });

  it("confirms with the preview's planFingerprint on the business-capabilities route", async () => {
    mockPost.mockResolvedValueOnce({ data: { preset: null, changed: [] } });
    const ticks = { shipping: true, counter: true, opensAs: "order" as const };

    await applyBusinessCapabilities("tenant-acme", ticks, "a".repeat(64), "moved to carrier");

    expect(mockPost).toHaveBeenCalledWith(
      "/platform-admin/tenants/tenant-acme/business-capabilities",
      {
        ...ticks,
        planFingerprint: "a".repeat(64),
        reason: "moved to carrier",
      },
    );
  });

  it("omits the reason when none is given", async () => {
    mockPost.mockResolvedValueOnce({ data: {} });
    await applyBusinessCapabilities("tenant-acme", { counter: true }, "b".repeat(64));
    expect(mockPost.mock.calls[0][1]).toEqual({ counter: true, planFingerprint: "b".repeat(64) });
  });
});

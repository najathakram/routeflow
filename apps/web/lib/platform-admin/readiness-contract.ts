// TEMPORARY: replace with packages/types/api/profiles.ts + business-profiles.ts when fix/mb-bo-api lands.
// The Readiness card's one read of the server's capability answer (BO-02). Shape and route are the
// API contract the MacBook lane ships: GET /platform-admin/tenants/:id/business-capabilities
// (503 FEATURES_UNAVAILABLE on a failed read, which the card shows as "Couldn't check").
import { superAdminClient } from "@/lib/admin-api";
import type { BusinessCapabilities } from "./capabilities-contract";

// One shape for both cards: BO-05's capabilities-contract owns it.
export type { BusinessCapabilities };

/** `GET /platform-admin/tenants/:id/business-capabilities`. A reply without a boolean `configured` throws. */
export async function fetchBusinessCapabilities(tenantId: string): Promise<BusinessCapabilities> {
  const res = await superAdminClient.get<BusinessCapabilities>(
    `/platform-admin/tenants/${tenantId}/business-capabilities`,
  );
  const data = res.data;
  if (!data || typeof data !== "object" || typeof data.configured !== "boolean") {
    throw new Error("Unexpected business-capabilities response");
  }
  if (data.configured && !["always", "optional", "off"].includes(data.counterCapability)) {
    throw new Error("Unexpected business-capabilities response");
  }
  return data;
}

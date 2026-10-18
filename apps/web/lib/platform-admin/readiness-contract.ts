// TEMPORARY: replace with packages/types/api/profiles.ts + business-profiles.ts when fix/mb-bo-api lands.
// The Readiness card's one read of the server's capability answer (BO-02). Shape and route are the
// API contract the MacBook lane ships: GET /platform-admin/tenants/:id/business-capabilities
// (503 FEATURES_UNAVAILABLE on a failed read, which the card shows as "Couldn't check").
import { superAdminClient } from "@/lib/admin-api";

export type CounterCapabilityLevel = "always" | "optional" | "off";

export interface BusinessCapabilities {
  /** false = fulfilment_model is still unset: nothing is chosen yet (every tick is false). */
  configured: boolean;
  delivery: boolean;
  doorPayments: boolean;
  shipping: boolean;
  counter: boolean;
  opensAs: string | null;
  opensAsChoosable: boolean;
  counterCapability: CounterCapabilityLevel;
  fleetHeld: boolean;
  matchedPreset: string | null;
}

/** `GET /platform-admin/tenants/:id/business-capabilities`. A reply without a boolean `configured` throws. */
export async function fetchBusinessCapabilities(tenantId: string): Promise<BusinessCapabilities> {
  const res = await superAdminClient.get<BusinessCapabilities>(
    `/platform-admin/tenants/${tenantId}/business-capabilities`,
  );
  const data = res.data;
  if (!data || typeof data !== "object" || typeof data.configured !== "boolean") {
    throw new Error("Unexpected business-capabilities response");
  }
  return data;
}

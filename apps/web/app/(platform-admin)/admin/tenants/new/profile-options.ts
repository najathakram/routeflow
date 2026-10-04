/** The business profiles a NEW account can start with. "Pickup counter" is not offered yet (the API refuses it). */
export const CREATE_TENANT_PROFILES = [
  { key: "delivery_distributor", fallbackLabel: "Own delivery" },
  { key: "shipping_wholesaler", fallbackLabel: "Ship by carrier" },
] as const;

export type CreateTenantProfile = (typeof CREATE_TENANT_PROFILES)[number]["key"];

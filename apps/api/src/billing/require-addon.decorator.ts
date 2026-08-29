import { SetMetadata } from "@nestjs/common";

export const REQUIRE_ADDON_KEY = "requireAddon";

/**
 * Gate a controller/handler on a tenant addon (e.g. "tobacco_dealer"), or on ANY of several
 * addons (e.g. `@RequireAddon("recurring_routes", "order_delivery", "developer_mode")`).
 * Must be paired with AddonGuard AFTER JwtAuthGuard in @UseGuards.
 */
export const RequireAddon = (...addonKeys: string[]) => SetMetadata(REQUIRE_ADDON_KEY, addonKeys);

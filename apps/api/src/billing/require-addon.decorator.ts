import { SetMetadata } from "@nestjs/common";

export const REQUIRE_ADDON_KEY = "requireAddon";

/**
 * Gate a controller/handler on a tenant addon (e.g. "tobacco_dealer").
 * Must be paired with AddonGuard AFTER JwtAuthGuard in @UseGuards.
 */
export const RequireAddon = (addonKey: string) => SetMetadata(REQUIRE_ADDON_KEY, addonKey);

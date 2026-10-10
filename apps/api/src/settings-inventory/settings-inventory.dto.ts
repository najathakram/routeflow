import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional } from "class-validator";

/**
 * `PATCH /settings/inventory`. The global pipe is `whitelist + forbidNonWhitelisted`, so an unknown
 * field is a 400 and Swagger shows the body. The VALUES are deliberately not typed by
 * class-validator: `SettingsInventoryService` validates them itself so a bad value is the coded
 * 400 `INVENTORY_SETTING_INVALID` with `details.field`, not the pipe's generic message.
 * `@IsOptional()` is what keeps each property past the whitelist.
 */
export class UpdateInventorySettingsDto {
  @ApiPropertyOptional({
    enum: ["off", "backorder"],
    description: "Out-of-stock ordering for buyers.",
  })
  @IsOptional()
  buyerOversell?: "off" | "backorder";

  @ApiPropertyOptional({
    enum: ["show", "hide"],
    description: "What buyers see about backordered items (needs out-of-stock ordering on).",
  })
  @IsOptional()
  buyerBackorderVisibility?: "show" | "hide";

  @ApiPropertyOptional({ maxLength: 500, description: "Note stored on the policy row and audit." })
  @IsOptional()
  reason?: string;
}

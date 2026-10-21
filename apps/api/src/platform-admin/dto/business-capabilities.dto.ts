import {
  IsBoolean,
  IsHexadecimal,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type {
  BusinessCapabilitiesRequest,
  ConfirmBusinessCapabilitiesRequest,
} from "@routeflow/types";

/**
 * `POST /platform-admin/tenants/:id/business-capabilities[/preview]` (BO-04). Every field is optional on
 * purpose: an empty body must reach the service so it gets the API's own 400 `BUSINESS_CAPABILITIES_EMPTY`
 * (which the web maps to fixed copy), not a generic validation message.
 */
export class BusinessCapabilitiesDto implements BusinessCapabilitiesRequest {
  @ApiPropertyOptional({ description: "Delivers on its own trucks" })
  @IsOptional()
  @IsBoolean()
  delivery?: boolean;

  @ApiPropertyOptional({
    description: "Collect payment at the door. Default true with Delivery; ignored without it",
  })
  @IsOptional()
  @IsBoolean()
  doorPayments?: boolean;

  @ApiPropertyOptional({ description: "Ships by carrier" })
  @IsOptional()
  @IsBoolean()
  shipping?: boolean;

  @ApiPropertyOptional({ description: "Sells at the counter" })
  @IsOptional()
  @IsBoolean()
  counter?: boolean;

  @ApiPropertyOptional({
    enum: ["order", "counter"],
    description:
      "Where new staff orders open; honoured only for Shipping + Counter without Delivery",
  })
  @IsOptional()
  @IsIn(["order", "counter"])
  opensAs?: "order" | "counter";

  @ApiPropertyOptional({ description: 'Audit reason; defaults to "Business profile: <label>"' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Confirm: the preview's `planFingerprint` is required, so the server applies only what was shown. */
export class ConfirmBusinessCapabilitiesDto
  extends BusinessCapabilitiesDto
  implements ConfirmBusinessCapabilitiesRequest
{
  @ApiProperty({ description: "planFingerprint from the preview this confirm follows" })
  @IsString()
  @IsHexadecimal()
  @Length(64, 64)
  planFingerprint: string;
}

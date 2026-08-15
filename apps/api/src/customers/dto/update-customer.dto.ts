import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Transform } from "class-transformer";
import { FulfillPath } from "@prisma/client";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import { emptyToNull } from "../../common/dto-transforms";

export class UpdateCustomerDto {
  // RF-110: strip HTML to prevent stored XSS via businessName
  @IsOptional() @StripHtml() @IsString() businessName?: string;
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(FulfillPath) fulfillPath?: FulfillPath;
  @IsOptional() @IsString() deliveryWindowStart?: string;
  @IsOptional() @IsString() deliveryWindowEnd?: string;
  // "" clears the stored email (→ null) so an import sentinel or stale address can
  // actually be removed; previously an empty string was either dropped client-side
  // or stored verbatim, making the email impossible to clear from the UI.
  @IsOptional() @Transform(emptyToNull) @IsString() email?: string | null;
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @IsString() customerType?: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsString() salutation?: string;
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() taxId?: string;
  @IsOptional() @IsBoolean() isTaxExempt?: boolean;
  @IsOptional() creditLimit?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) pricingTier?: number;
}

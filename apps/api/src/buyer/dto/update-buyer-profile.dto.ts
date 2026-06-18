import { IsOptional, IsString } from "class-validator";
import { StripHtml } from "../../common/transforms/strip-html.transform";

/**
 * SECURITY (F4-001): buyers may edit ONLY their own contact/profile fields.
 * Seller-controlled commercial terms — pricingTier, creditLimit, isTaxExempt,
 * taxId, currency, customerType, fulfillPath — are intentionally EXCLUDED so a
 * buyer cannot self-assign a cheaper price tier, tax exemption, or credit limit.
 * Because the @Body() param now has a concrete DTO type, the global
 * ValidationPipe (whitelist + forbidNonWhitelisted) strips/rejects any other key,
 * and @StripHtml prevents stored XSS via businessName.
 */
export class UpdateBuyerProfileDto {
  @IsOptional() @StripHtml() @IsString() businessName?: string;
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @StripHtml() @IsString() displayName?: string;
  @IsOptional() @IsString() salutation?: string;
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() deliveryWindowStart?: string;
  @IsOptional() @IsString() deliveryWindowEnd?: string;
  @IsOptional() @StripHtml() @IsString() notes?: string;
}

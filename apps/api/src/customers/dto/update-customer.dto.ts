import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { Transform } from "class-transformer";
import { FulfillPath } from "@prisma/client";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import { emptyToNull } from "../../common/dto-transforms";
import { VALID_TERMS } from "../../system-config/dto/update-invoice-settings.dto";

// Canonical list plus "" to CLEAR a previously-set override back to "use the
// tenant default".
const VALID_CUSTOMER_TERMS = [...VALID_TERMS, ""];

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
  /**
   * Per-customer default payment terms ("this customer is always Net 60") — wins
   * over the tenant SystemConfig default in resolveDefaultTerms(). "" clears the
   * override back to "use the tenant default".
   */
  @IsOptional()
  @IsString()
  @IsIn(VALID_CUSTOMER_TERMS, {
    message: "defaultPaymentTerms must be one of: " + VALID_CUSTOMER_TERMS.join(", "),
  })
  defaultPaymentTerms?: string;
  /**
   * Per-customer default deposit percent ("50% upfront, remainder on terms").
   * `null` clears the default back to "no deposit"; a number sets/replaces it.
   */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  defaultDepositPercent?: number | null;
}

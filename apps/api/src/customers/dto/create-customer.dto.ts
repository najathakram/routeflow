import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { FulfillPath } from "@prisma/client";
import { CreateAddressDto } from "./create-address.dto";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import { VALID_TERMS } from "../../system-config/dto/update-invoice-settings.dto";

// Canonical list plus "" to allow explicitly leaving this customer on the
// tenant default at create time.
const VALID_CUSTOMER_TERMS = [...VALID_TERMS, ""];

export class CreateCustomerDto {
  // BUG-B1-5: bound free-text fields server-side. The audit POSTed a
  // 4000-char businessName and the API stored it; both display and DB
  // index performance suffer with unbounded TEXT. Limits chosen to match
  // typical UI affordances and column widths.
  // Email is OPTIONAL — operator-managed customers may have no email on file.
  // When absent, the service generates an internal placeholder for the linked
  // User record (User.email is required + unique) and leaves Customer.email null.
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsString() @MinLength(3) @MaxLength(64) username: string;
  // RF-110: strip HTML to prevent stored XSS via businessName
  @StripHtml() @IsString() @MaxLength(200) businessName: string;
  @IsString() @MaxLength(120) contactName: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsEnum(FulfillPath) fulfillPath?: FulfillPath;
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateAddressDto)
  addresses?: CreateAddressDto[];
  @IsOptional() @IsString() @MaxLength(40) mobile?: string;
  @IsOptional() @IsString() @MaxLength(40) customerType?: string;
  @IsOptional() @IsString() @MaxLength(120) displayName?: string;
  @IsOptional() @IsString() @MaxLength(20) salutation?: string;
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string;
  @IsOptional() @IsBoolean() isTaxExempt?: boolean;
  @IsOptional() @Min(0) @Max(1_000_000_000) creditLimit?: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) pricingTier?: number;
  /**
   * Per-customer default payment terms ("this customer is always Net 60") — wins
   * over the tenant SystemConfig default in resolveDefaultTerms(). "" (or
   * omitted) leaves the customer on the tenant default.
   */
  @IsOptional()
  @IsString()
  @IsIn(VALID_CUSTOMER_TERMS, {
    message: "defaultPaymentTerms must be one of: " + VALID_CUSTOMER_TERMS.join(", "),
  })
  defaultPaymentTerms?: string;
  /**
   * Sales agents & commissions: opens the customer's first attribution window
   * (AgentAssignment, effectiveFrom = now) inside the create tx.
   */
  @IsOptional() @IsUUID() salesAgentId?: string;
}

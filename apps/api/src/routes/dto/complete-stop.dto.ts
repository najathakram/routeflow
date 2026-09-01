import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { IDENTITY_TYPES } from "../../common/regulated-delivery";

/**
 * Route-run delivery line. Kept lenient (string `type`, plain number qty) to
 * preserve the pre-DTO inline-body contract that mobile/web already send; the
 * service casts `type` to MutationType.
 */
export class RunDeliveryDto {
  @IsString() orderItemId: string;
  @IsString() type: string;
  @IsNumber() quantityDelivered: number;
  @IsOptional() @IsString() note?: string;
  // B148/R3: the mobile client (payment.tsx, short-pick.ts) sends productId on
  // every delivery line, so the whitelist must accept the key or
  // `forbidNonWhitelisted` 400s the whole completion. class-validator's
  // @IsOptional() skips validation (including @IsString()) when the value is
  // `null`, so an explicit null is accepted alongside a real id or an omitted
  // key. The value itself is ADVISORY: `DeliveryMutation.productId` is a real
  // Product FK, so the service persists the order item's own productId read
  // through the tenant-scoped transaction, never this field.
  @IsOptional() @IsString() productId?: string | null;
}

/**
 * Phase 4 (W7b): promoted from the inline `@Body()` on
 * POST /route-runs/:id/stops/:stopId/complete. Adds validated regulated-delivery
 * POD capture fields; identityVerifiedAt is stamped server-side, never accepted
 * from the client.
 */
export class CompleteStopDto {
  @IsOptional() @IsString() driverNote?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) podPhotoUrls?: string[];
  @IsOptional() @IsString() signatureUrl?: string;
  @IsOptional() @IsBoolean() safeDropEnabled?: boolean;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RunDeliveryDto)
  deliveries?: RunDeliveryDto[];

  @IsOptional() @IsBoolean() ageVerified?: boolean;
  @IsOptional() @IsBoolean() identityVerified?: boolean;
  @IsOptional() @IsIn(IDENTITY_TYPES) identityType?: string;
}

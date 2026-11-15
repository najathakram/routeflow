import { IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/**
 * The super-admin checkout link. SA-1146 B-1: no success or cancel override; the service always returns to the Billing
 * page (billing-return-paths.ts), and no first-party client ever sent one.
 */
export class CreateCheckoutDto {
  @ApiProperty({ description: "Tenant ID to create checkout for" })
  @IsString()
  tenantId: string;
}

import { IsString, IsOptional } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  API_BILLING_CANCEL_PATH,
  API_BILLING_RETURN_PATHS,
  billingReturnUrl,
} from "../billing-return-paths";

const EXAMPLE_BASE = "https://app.routeflow.io";

export class CreateCheckoutDto {
  @ApiProperty({ description: "Tenant ID to create checkout for" })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({
    description: "Override the default success URL",
    example: billingReturnUrl(EXAMPLE_BASE, API_BILLING_RETURN_PATHS.plan),
  })
  @IsOptional()
  @IsString()
  successUrl?: string;

  @ApiPropertyOptional({
    description: "Override the default cancel URL",
    example: billingReturnUrl(EXAMPLE_BASE, API_BILLING_CANCEL_PATH),
  })
  @IsOptional()
  @IsString()
  cancelUrl?: string;
}

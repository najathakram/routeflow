import { IsString, IsOptional } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateCheckoutDto {
  @ApiProperty({ description: "Tenant ID to create checkout for" })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({
    description: "Override the default success URL",
    example: "https://app.routeflow.io/billing/success",
  })
  @IsOptional()
  @IsString()
  successUrl?: string;

  @ApiPropertyOptional({
    description: "Override the default cancel URL",
    example: "https://app.routeflow.io/billing/cancel",
  })
  @IsOptional()
  @IsString()
  cancelUrl?: string;
}

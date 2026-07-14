import { IsOptional, IsString, MaxLength } from "class-validator";

// Seller remit-to / how-to-pay info (P5-14). All fields optional; "" clears a
// field (see SystemConfigService.setRemittanceConfig PATCH semantics).
export class RemittanceConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  payToName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  accountName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  routingNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  achInstructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  wireInstructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  checkInstructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  mailingAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

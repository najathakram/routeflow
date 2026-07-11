import { IsOptional, IsString } from "class-validator";
import { StripHtml } from "../../common/transforms/strip-html.transform";

/**
 * SECURITY: buyers may edit ONLY these contact fields on their own
 * BuyerAccount. The service previously spread an UNTYPED body straight into
 * `prisma.buyerAccount.update`, so any column (emailVerified, passwordHash,
 * email, …) was assignable — the concrete DTO type makes the global
 * ValidationPipe (whitelist + forbidNonWhitelisted) reject everything else.
 */
export class BuyerUpdateAccountDto {
  @IsOptional() @StripHtml() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() mobile?: string;
}

import { IsNotEmpty, IsString } from "class-validator";

/**
 * Typed confirmation for the irreversible financial-data wipe. The caller must
 * echo their OWN tenantId, which proves both intent and that they know which
 * tenant they are clearing. Compared server-side against prisma.getTenantId().
 */
export class ClearFinancialDataDto {
  @IsString()
  @IsNotEmpty()
  confirmTenantId!: string;
}

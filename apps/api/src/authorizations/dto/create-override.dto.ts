import { IsNotEmpty, IsString, IsUUID } from "class-validator";

export class CreateOverrideDto {
  @IsUUID()
  trackedCategoryId!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;

  // "ORDER:<id>" | "UNTIL:<iso>" — validated by isScopeActive at guard time.
  @IsString()
  @IsNotEmpty()
  scope!: string;

  // The tenant name the operator typed into the acknowledgment checkbox — an
  // immutable attestation snapshot on the §8 responsibility record.
  @IsString()
  @IsNotEmpty()
  acknowledgedTenant!: string;
}

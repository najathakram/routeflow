import { IsEmail, IsIn, IsOptional, IsString } from "class-validator";
import { UserRole } from "@prisma/client";

/** The roles a staff invite may create. Never TENANT_ADMIN or CUSTOMER (B862). */
export const CREATABLE_STAFF_ROLES = [UserRole.OPERATOR, UserRole.DRIVER] as const;
export type CreatableStaffRole = (typeof CREATABLE_STAFF_ROLES)[number];

export class CreateOperatorDto {
  @IsEmail() email: string;
  @IsString() username: string;
  /** OPERATOR when absent, so callers written before B862 are unchanged. */
  @IsOptional() @IsIn(CREATABLE_STAFF_ROLES) role?: CreatableStaffRole;
}

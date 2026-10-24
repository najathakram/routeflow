import { Allow, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { PolicyScopeType } from "@prisma/client";

const SCOPE_TYPES = Object.values(PolicyScopeType);

/**
 * `PUT /policies/:key`. `value` is deliberately NOT typed by class-validator: its shape depends on
 * the key and is validated by the registry's own schema inside PolicyService.set (400 on failure).
 * `@Allow()` keeps it past the global whitelist + forbidNonWhitelisted pipe (it may be `null`).
 */
export class SetPolicyDto {
  @IsIn(SCOPE_TYPES)
  scopeType!: PolicyScopeType;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  scopeId?: string | null;

  @Allow()
  value!: unknown;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** `DELETE /policies/:key` query — which scope to clear. */
export class ClearPolicyQueryDto {
  @IsIn(SCOPE_TYPES)
  scopeType!: PolicyScopeType;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  scopeId?: string;
}

/** `DELETE /policies/:key` body — a clear needs a reason, like a set. */
export class ClearPolicyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

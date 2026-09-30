import { IsEnum, IsInt, IsOptional, Min } from "class-validator";
import { Type } from "class-transformer";
import { CrmHandoffStatus } from "@prisma/client";

/** `GET /crm/gohighlevel/handoffs` request shape (spec R22). */
export class ListHandoffsDto {
  @IsOptional() @IsEnum(CrmHandoffStatus) status?: CrmHandoffStatus;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number;
}

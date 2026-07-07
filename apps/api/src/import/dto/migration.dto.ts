import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { MigrationSource } from "@prisma/client";

export class CreateJobDto {
  @IsEnum(MigrationSource)
  source!: MigrationSource;
}

export class StageRowDto {
  /** An ImportEntityType value (CUSTOMER | PRODUCT | SUPPLIER | INVOICE | ...). */
  @IsString()
  entityType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalId?: string;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class StageRecordsDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => StageRowDto)
  rows!: StageRowDto[];
}

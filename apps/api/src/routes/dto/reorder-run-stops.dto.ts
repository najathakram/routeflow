import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";

/** One stop of a run and the position it takes. */
export class ReorderRunStopItemDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsInt()
  @Min(1)
  stopNumber!: number;
}

/**
 * PATCH /route-runs/:id/stops/reorder (#2135). The body is the run's COMPLETE new order: the
 * service requires the ids to equal the run's stops and the numbers to be exactly 1..N, and
 * scopes every write to the run (a body naming another run's stop can never renumber it).
 */
export class ReorderRunStopsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderRunStopItemDto)
  order!: ReorderRunStopItemDto[];
}

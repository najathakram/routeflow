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

/** One stop of a route template and the position it takes. */
export class ReorderRouteStopItemDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsInt()
  @Min(1)
  stopNumber!: number;
}

/**
 * PATCH /routes/:id/stops/reorder. The body is the route's COMPLETE new order: the service requires
 * the ids to equal the route's stops and the numbers to be exactly 1..N, and scopes every write to the
 * route (a body naming another route's stop can never renumber it).
 */
export class ReorderRouteStopsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderRouteStopItemDto)
  order!: ReorderRouteStopItemDto[];
}

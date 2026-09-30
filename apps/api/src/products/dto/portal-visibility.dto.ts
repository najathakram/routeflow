import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsString,
} from "class-validator";

/** PATCH /products/:id/portal-visibility body. Strict boolean (no "true" string coercion). */
export class SetPortalVisibilityDto {
  @IsBoolean()
  portalVisible: boolean;
}

/** PATCH /products/portal-visibility body: 1..200 unique ids, one all-or-nothing transaction. */
export class BulkSetPortalVisibilityDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsString({ each: true })
  ids: string[];

  @IsBoolean()
  portalVisible: boolean;
}

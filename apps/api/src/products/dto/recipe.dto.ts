import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * Numbers are validated as numbers here, not as whole positives: the recipe rules
 * (recipe-rules.ts) own "whole number above 0" so every rejection is one RECIPE_INVALID body with a
 * reason a client can branch on.
 */
export class RecipeComponentInputDto {
  @IsUUID() componentProductId: string;
  @IsNumber() qty: number;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

export class CreateRecipeDto {
  @IsUUID() recipeProductId: string;
  @IsUUID() familyProductId: string;
  @IsNumber() unitsPerPack: number;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RecipeComponentInputDto)
  components: RecipeComponentInputDto[];
}

/** DRAFT-only edit: either field may be sent; `components` replaces the whole list. */
export class UpdateRecipeDto {
  @IsOptional() @IsNumber() unitsPerPack?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RecipeComponentInputDto)
  components?: RecipeComponentInputDto[];
}

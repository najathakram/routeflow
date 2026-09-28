import {
  Equals,
  IsBoolean,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";
import { IntakeSectionKey } from "@prisma/client";

// Values from the generated Prisma enum — `@routeflow/types` is TYPE-ONLY at API runtime.
const SECTION_KEY_VALUES = Object.values(IntakeSectionKey);

/** The token is only ever a POST body field (L-188). Length bounds match resolve()'s shape check. */
export class IntakeTokenDto {
  @IsString() @MinLength(16) @MaxLength(300) token!: string;
}

export class SaveIntakeSectionDto extends IntakeTokenDto {
  @IsIn(SECTION_KEY_VALUES) key!: IntakeSectionKey;
  /** Validated per section by validateSectionAnswers (partial for a draft). */
  @IsObject() answers!: Record<string, unknown>;
}

export class SubmitIntakeSectionDto extends IntakeTokenDto {
  @IsIn(SECTION_KEY_VALUES) key!: IntakeSectionKey;
}

export class AcceptIntakeOrderDto extends IntakeTokenDto {
  @IsString() @MinLength(2) @MaxLength(200) acceptedName!: string;
  @IsEmail() @MaxLength(254) acceptedEmail!: string;
  @Equals(true, { message: "You must agree to the Terms and Privacy Policy" }) agree!: true;
}

export class DeleteIntakeFileDto extends IntakeTokenDto {
  @IsUUID() fileId!: string;
}

/** Multipart text fields that travel with an uploaded file. */
export class UploadIntakeFileFieldsDto {
  @IsIn(SECTION_KEY_VALUES) sectionKey!: IntakeSectionKey;
  @IsString() @MaxLength(40) kind!: string;
}

export class PublicUploadIntakeFileDto extends UploadIntakeFileFieldsDto {
  @IsString() @MinLength(16) @MaxLength(300) token!: string;
}

export class IssueIntakeLinkDto {
  @IsOptional() @IsBoolean() send?: boolean;
}

export class ReviewIntakeSectionDto {
  @IsIn(["approve", "request_changes", "waive"]) action!: "approve" | "request_changes" | "waive";
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

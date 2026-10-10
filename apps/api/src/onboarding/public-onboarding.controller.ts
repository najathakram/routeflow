import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { memoryStorage } from "multer";
import { MB, uploadLimits } from "../common/upload-limits";
import { OnboardingIntakeService, INTAKE_UPLOAD_TYPES } from "./onboarding-intake.service";
import {
  AcceptIntakeOrderDto,
  DeleteIntakeFileDto,
  IntakeTokenDto,
  PublicUploadIntakeFileDto,
  SaveIntakeSectionDto,
  SubmitIntakeSectionDto,
} from "./dto/intake.dto";

/**
 * The wholesaler's secure intake link (#2159 S2). Public and tenant-less — deliberately no
 * `@UseGuards` (this API applies JwtAuthGuard per controller, not globally; same posture as
 * public-demo-booking.controller.ts). The link token is the only credential and travels ONLY in
 * POST bodies (L-188): no route reads a query string or a path parameter. Every token failure is
 * the same 404 "Link not found or expired." Every route is throttled.
 */
@ApiTags("public/onboarding")
@Controller("public/onboarding")
export class PublicOnboardingController {
  constructor(private readonly intake: OnboardingIntakeService) {}

  @Post("session")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Open the intake page: case, sections, files, live order, current acceptance",
  })
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  session(@Body() dto: IntakeTokenDto) {
    return this.intake.session(dto.token);
  }

  @Post("sections/save")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Save a section's draft answers (partial allowed)" })
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  save(@Body() dto: SaveIntakeSectionDto) {
    return this.intake.saveSection(dto.token, dto.key, dto.answers);
  }

  @Post("sections/submit")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Submit a section for review (full validation)" })
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  submit(@Body() dto: SubmitIntakeSectionDto) {
    return this.intake.submitSection(dto.token, dto.key);
  }

  @Post("accept")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Click-accept the order summary + Terms/Privacy (snapshot computed server-side)",
  })
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  accept(@Body() dto: AcceptIntakeOrderDto, @Req() req: Request) {
    return this.intake.accept(dto.token, {
      acceptedName: dto.acceptedName,
      acceptedEmail: dto.acceptedEmail,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });
  }

  @Post("files")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Upload a data file (≤ 25 MB; CSV, XLSX, PDF, PNG, JPG)" })
  @Throttle({ default: { ttl: 3_600_000, limit: 60 } })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: uploadLimits(MB(25)),
      fileFilter: intakeFileFilter,
    }),
  )
  upload(
    @Body() dto: PublicUploadIntakeFileDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.intake.uploadAsCustomer(dto.token, dto.sectionKey, dto.kind, file);
  }

  @Post("files/delete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a file the customer uploaded" })
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  deleteFile(@Body() dto: DeleteIntakeFileDto) {
    return this.intake.deleteAsCustomer(dto.token, dto.fileId);
  }
}

/** Fail closed at the multer layer too: extension AND content type must both be on the allowlist. */
export function intakeFileFilter(
  _req: unknown,
  file: { originalname: string; mimetype: string },
  cb: (err: Error | null, accept: boolean) => void,
): void {
  const dot = file.originalname.lastIndexOf(".");
  const ext = dot >= 0 ? file.originalname.slice(dot).toLowerCase() : "";
  const ok = INTAKE_UPLOAD_TYPES[ext]?.includes((file.mimetype ?? "").toLowerCase()) ?? false;
  if (!ok)
    return cb(
      new BadRequestException("Only CSV, XLSX, PDF, PNG or JPG files can be uploaded"),
      false,
    );
  cb(null, true);
}

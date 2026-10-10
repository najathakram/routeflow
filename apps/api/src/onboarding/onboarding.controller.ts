import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { IntakeSectionKey } from "@prisma/client";
import { memoryStorage } from "multer";
import { MB, uploadLimits } from "../common/upload-limits";
import { OnboardingIntakeService } from "./onboarding-intake.service";
import { intakeFileFilter } from "./public-onboarding.controller";
import {
  IssueIntakeLinkDto,
  ReviewIntakeSectionDto,
  UploadIntakeFileFieldsDto,
} from "./dto/intake.dto";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { OnboardingService } from "./onboarding.service";
import { OnboardingLifecycleService } from "./onboarding-lifecycle.service";
import {
  CompleteOnboardingStepDto,
  CreateOnboardingCaseDto,
  ListDemoBookingsQueryDto,
  ListOnboardingCasesQueryDto,
  OnboardingFunnelQueryDto,
  UpdateOnboardingCaseDto,
  WaiveOnboardingStepDto,
} from "./dto/onboarding.dto";

/**
 * Back-office onboarding tracker (#2159 S1). Super-admin only; the shared contract is
 * packages/types/api/onboarding.ts.
 */
@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("platform-admin")
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly intake: OnboardingIntakeService,
    private readonly lifecycle: OnboardingLifecycleService,
  ) {}

  @Get("onboarding/cases")
  list(@Query() q: ListOnboardingCasesQueryDto) {
    return this.onboarding.list(q);
  }

  @Get("onboarding/cases/counts")
  counts() {
    return this.onboarding.counts();
  }

  /** #2159 S5: demo → signed → paid → live, and median days per stage, for a cohort window. */
  @Get("onboarding/funnel")
  funnel(@Query() q: OnboardingFunnelQueryDto) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
    if (!(from < to)) throw new BadRequestException("`from` must be before `to`");
    return this.lifecycle.funnel(from, to);
  }

  @Post("onboarding/cases")
  create(@Body() dto: CreateOnboardingCaseDto, @CurrentUser() admin: JwtPayload) {
    return this.onboarding.create(dto, admin.sub);
  }

  @Get("onboarding/cases/:id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.onboarding.get(id);
  }

  @Patch("onboarding/cases/:id")
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateOnboardingCaseDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.onboarding.update(id, dto, admin.sub);
  }

  @Post("onboarding/cases/:id/advance")
  @HttpCode(200)
  advance(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() admin: JwtPayload) {
    return this.onboarding.advance(id, admin.sub);
  }

  @Post("onboarding/cases/:id/steps/:key/complete")
  @HttpCode(200)
  complete(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("key") key: string,
    @Body() dto: CompleteOnboardingStepDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.onboarding.completeStep(id, key, dto.evidence, admin.sub);
  }

  @Post("onboarding/cases/:id/steps/:key/waive")
  @HttpCode(200)
  waive(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("key") key: string,
    @Body() dto: WaiveOnboardingStepDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.onboarding.waiveStep(id, key, dto.reason, admin.sub);
  }

  @Post("onboarding/cases/:id/steps/:key/reopen")
  @HttpCode(200)
  reopen(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("key") key: string,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.onboarding.reopenStep(id, key, admin.sub);
  }

  @Post("onboarding/cases/:id/auto-checks")
  @HttpCode(200)
  runAutoChecks(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() admin: JwtPayload) {
    return this.onboarding.runAutoChecks(id, admin.sub);
  }

  @Post("onboarding/cases/:id/adopt-catalog")
  @HttpCode(200)
  adoptCatalog(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() admin: JwtPayload) {
    return this.onboarding.adoptCatalog(id, admin.sub);
  }

  // ─── S2: the intake link ───────────────────────────────────────────────────

  @Post("onboarding/cases/:id/intake-link")
  @HttpCode(200)
  issueLink(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: IssueIntakeLinkDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.intake.issueLink(id, admin.sub, dto.send === true);
  }

  @Post("onboarding/cases/:id/intake-link/revoke")
  @HttpCode(200)
  revokeLink(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() admin: JwtPayload) {
    return this.intake.revokeLink(id, admin.sub);
  }

  @Get("onboarding/cases/:id/intake")
  intakeView(@Param("id", ParseUUIDPipe) id: string) {
    return this.intake.adminView(id);
  }

  @Post("onboarding/cases/:id/sections/:key/review")
  @HttpCode(200)
  reviewSection(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("key", new ParseEnumPipe(IntakeSectionKey)) key: IntakeSectionKey,
    @Body() dto: ReviewIntakeSectionDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.intake.review(id, key, dto.action, dto.note, admin.sub);
  }

  @Post("onboarding/cases/:id/files")
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: uploadLimits(MB(25)),
      fileFilter: intakeFileFilter,
    }),
  )
  uploadFile(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UploadIntakeFileFieldsDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.intake.uploadAsAdmin(id, dto.sectionKey, dto.kind, file, admin.sub);
  }

  @Get("onboarding/cases/:id/files/:fileId/url")
  fileUrl(@Param("id", ParseUUIDPipe) id: string, @Param("fileId", ParseUUIDPipe) fileId: string) {
    return this.intake.signedFileUrl(id, fileId);
  }

  @Get("demo-bookings")
  demoBookings(@Query() q: ListDemoBookingsQueryDto) {
    return this.onboarding.listDemoBookings(q);
  }
}

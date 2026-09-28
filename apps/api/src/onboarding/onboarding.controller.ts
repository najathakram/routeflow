import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { OnboardingService } from "./onboarding.service";
import {
  CompleteOnboardingStepDto,
  CreateOnboardingCaseDto,
  ListDemoBookingsQueryDto,
  ListOnboardingCasesQueryDto,
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
  constructor(private readonly onboarding: OnboardingService) {}

  @Get("onboarding/cases")
  list(@Query() q: ListOnboardingCasesQueryDto) {
    return this.onboarding.list(q);
  }

  @Get("onboarding/cases/counts")
  counts() {
    return this.onboarding.counts();
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

  @Get("demo-bookings")
  demoBookings(@Query() q: ListDemoBookingsQueryDto) {
    return this.onboarding.listDemoBookings(q);
  }
}

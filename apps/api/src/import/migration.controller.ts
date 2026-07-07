import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { MigrationService } from "./migration.service";
import { CreateJobDto, StageRecordsDto } from "./dto/migration.dto";

/**
 * Migration hub (spec §3): create a job, stage rows to review, confirm to live,
 * or undo within 24h. Import history = the job list. TENANT_ADMIN satisfies
 * @Roles(OPERATOR).
 */
@Controller("import/migration")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}

  /** Import history — recent migration runs. */
  @Get()
  list() {
    return this.migration.listJobs();
  }

  @Post()
  create(@Body() dto: CreateJobDto, @CurrentUser() user: JwtPayload) {
    return this.migration.createJob({ source: dto.source, createdById: user.sub });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.migration.getJob(id);
  }

  @Post(":id/stage")
  stage(@Param("id") id: string, @Body() dto: StageRecordsDto) {
    return this.migration.stageRecords(id, dto.rows);
  }

  @Post(":id/confirm")
  confirm(@Param("id") id: string) {
    return this.migration.confirmJob(id);
  }

  @Post(":id/undo")
  undo(@Param("id") id: string) {
    return this.migration.undoJob(id);
  }
}

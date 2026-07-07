/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { BatchImportService } from "./batch-import.service";
import { CreateBatchDto } from "./dto/create-batch.dto";

/**
 * Batch invoice import queue (spec §4). TENANT_ADMIN satisfies @Roles(OPERATOR).
 */
@Controller("import/batch")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class BatchController {
  constructor(private readonly batch: BatchImportService) {}

  @Post()
  create(@Body() dto: CreateBatchDto, @CurrentUser() user: JwtPayload) {
    return this.batch.createBatch({ kind: dto.kind, createdById: user.sub });
  }

  /** Scan one invoice (its page files) into the batch queue. */
  @Post(":id/scan")
  @UseInterceptors(FilesInterceptor("files", 20, { limits: { fileSize: 25 * 1024 * 1024 } }))
  scan(@Param("id") id: string, @UploadedFiles() files: Express.Multer.File[]) {
    if (!files?.length) throw new BadRequestException("No files uploaded");
    return this.batch.scanAndRecord(
      id,
      files.map((f) => ({ buffer: f.buffer, mimeType: f.mimetype })),
      files[0]?.originalname,
    );
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.batch.getBatch(id);
  }

  @Post("items/:itemId/resolve")
  resolve(@Param("itemId") itemId: string) {
    return this.batch.resolveItem(itemId);
  }

  @Post(":id/post")
  post(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.batch.postBatch(id, user.sub);
  }
}

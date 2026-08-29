/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import { BatchImportService } from "./batch-import.service";
import { CreateBatchDto } from "./dto/create-batch.dto";
import { UpdateBatchItemDto } from "./dto/update-batch-item.dto";

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

  /** Recent batches, most-active first — lets the web page restore its place after a refresh. */
  @Get()
  list() {
    return this.batch.listBatches();
  }

  /**
   * Scan one invoice (its page files) into the batch queue. AI OCR is
   * entitlement-gated (owner decision 2026-08-28) — OCR_ADDON in
   * packages/types is the client-side mirror of this key.
   */
  @Post(":id/scan")
  @UseGuards(AddonGuard)
  @RequireAddon("ocr")
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

  /** Review UI: remap a line to a product, keep it custom, and/or link the supplier. */
  @Patch("items/:itemId")
  updateItem(@Param("itemId") itemId: string, @Body() dto: UpdateBatchItemDto) {
    return this.batch.updateItemLines(itemId, dto);
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

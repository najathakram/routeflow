import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
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
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import { SupplierStatementsService } from "./supplier-statements.service";
import { StatementApplyService } from "./statement-apply.service";
import { ApplyStatementBodyDto } from "./dto/statement.dto";
import { MB, uploadLimits } from "../common/upload-limits";

// AddonGuard passes handlers without @RequireAddon metadata — only the AI scan
// endpoint is addon-gated; listing/reviewing/applying existing scans is not.
@Controller("supplier-statements")
@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
@Roles(UserRole.OPERATOR)
export class SupplierStatementsController {
  constructor(
    private readonly supplierStatementsService: SupplierStatementsService,
    private readonly statementApplyService: StatementApplyService,
  ) {}

  @Get() findAll(
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.supplierStatementsService.listScans(status, page ? +page : 1, limit ? +limit : 20);
  }

  @Get(":id") findOne(@Param("id") id: string) {
    return this.supplierStatementsService.getScan(id);
  }

  // AI OCR is entitlement-gated (owner decision 2026-08-28) — OCR_ADDON in
  // packages/types is the client-side mirror of this key.
  @Post("scan")
  @RequireAddon("ocr")
  @UseInterceptors(
    // Up to 10 pages, 25MB per file, under the field name `files` (multer
    // matches the field name exactly — clients MUST use "files").
    FilesInterceptor("files", 10, { limits: uploadLimits(MB(25)) }),
  )
  scanStatement(
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: { id: string },
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException("No file provided");
    }
    // Multer's fileSize limit is per file only — cap the aggregate so 10×25MB
    // can't buffer 250MB in memory / ship an oversized payload to Anthropic.
    const totalBytes = files.reduce((s, f) => s + (f.size ?? f.buffer?.length ?? 0), 0);
    if (totalBytes > 60 * 1024 * 1024) {
      throw new BadRequestException(
        "Combined upload is too large (max 60MB per scan). Split the pages across scans.",
      );
    }
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/heic",
      "image/heif",
      "application/pdf",
    ];
    for (const f of files) {
      const mt = f.mimetype || "image/jpeg";
      if (!allowed.includes(mt)) {
        throw new BadRequestException(
          `Unsupported file type "${mt}" — accepted: JPEG, PNG, WebP, GIF, HEIC, PDF`,
        );
      }
    }
    return this.supplierStatementsService.scanStatement(
      files.map((f) => ({
        buffer: f.buffer,
        mimeType: f.mimetype || "image/jpeg",
        fileName: f.originalname,
        size: f.size,
      })),
      user.id,
    );
  }

  /**
   * The ONE write for a reviewed statement — everything the operator
   * confirmed, plus (separately) any implied-paid bills, in a single
   * transaction. Idempotent: re-posting an already-`APPLIED` scan writes
   * nothing and returns the payment group the first apply wrote, so a
   * double-click or a retried request can never pay twice.
   */
  @Post(":id/apply")
  applyStatement(
    @Param("id") id: string,
    @Body() dto: ApplyStatementBodyDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.statementApplyService.applyStatement(id, dto, user);
  }
}

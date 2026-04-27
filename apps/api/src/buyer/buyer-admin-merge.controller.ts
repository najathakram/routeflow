import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { BuyerMergeService } from "./buyer-merge.service";

@ApiTags("platform-admin-buyer-merge")
@ApiBearerAuth()
@Controller("platform-admin/buyer-merge-requests")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class BuyerAdminMergeController {
  constructor(private readonly mergeService: BuyerMergeService) {}

  @Get()
  @ApiOperation({ summary: "List all merge requests" })
  list(@Query() query: { page?: string; limit?: string; status?: string }) {
    return this.mergeService.listMergeRequests({
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 20,
      status: query.status,
    });
  }

  @Get(":id")
  @ApiOperation({ summary: "Get merge request with conflict preview" })
  getOne(@Param("id") id: string) {
    return this.mergeService.getMergeRequestPreview(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Admin creates a merge request directly (no buyer verification needed)" })
  create(@Body() dto: { primaryAccountId: string; secondaryAccountId: string; adminNotes?: string }) {
    return this.mergeService.createAdminMergeRequest(dto.primaryAccountId, dto.secondaryAccountId, dto.adminNotes);
  }

  @Post(":id/execute")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Execute the merge (atomic transaction)" })
  execute(@Param("id") id: string) {
    return this.mergeService.executeMerge(id);
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reject a merge request" })
  reject(@Param("id") id: string, @Body() dto: { adminNotes?: string }) {
    return this.mergeService.rejectMerge(id, dto.adminNotes);
  }
}

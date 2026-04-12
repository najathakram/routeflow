import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { BuyerMergeService } from "./buyer-merge.service";
import { BuyerJwtAuthGuard } from "./guards/buyer-jwt-auth.guard";
import { CurrentBuyer } from "./decorators/current-buyer.decorator";
import type { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";

@ApiTags("buyer-merge")
@Controller("buyer/auth")
export class BuyerMergeController {
  constructor(private readonly mergeService: BuyerMergeService) {}

  @Post("merge-request")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Initiate a merge request (logged-in buyer is the primary)" })
  initiateMerge(
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @Body() dto: { secondaryEmail: string; notes?: string },
  ) {
    return this.mergeService.initiateMerge(buyer.sub, dto.secondaryEmail, dto.notes);
  }

  @Get("verify-merge/:token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify ownership of secondary account via email link" })
  verifyMerge(@Param("token") token: string) {
    return this.mergeService.verifyMergeToken(token);
  }
}

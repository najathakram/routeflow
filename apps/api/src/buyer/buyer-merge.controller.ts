import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { BuyerMergeService } from "./buyer-merge.service";
import { BuyerJwtAuthGuard } from "./guards/buyer-jwt-auth.guard";
import { CurrentBuyer } from "./decorators/current-buyer.decorator";
import type { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";
import { BuyerVerifyMergeDto } from "./dto/buyer-verify-merge.dto";

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

  // Rows 404 / 413: a link scanner's prefetch must not complete the merge, so there is NO GET for the
  // token: the single-use consume is this POST only, sent by a human click on the confirm page.
  @Post("verify-merge")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per IP — matches verify-email
  @ApiOperation({ summary: "Confirm ownership of the secondary account with the emailed token" })
  verifyMerge(@Body() dto: BuyerVerifyMergeDto) {
    return this.mergeService.verifyMergeToken(dto.token);
  }
}

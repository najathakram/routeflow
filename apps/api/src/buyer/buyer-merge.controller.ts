import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { BuyerMergeService } from "./buyer-merge.service";
import { BuyerJwtAuthGuard } from "./guards/buyer-jwt-auth.guard";
import { CurrentBuyer } from "./decorators/current-buyer.decorator";
import type { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";
import { BuyerVerifyMergeDto } from "./dto/buyer-verify-merge.dto";
import { legacyMergeLinkAccepted } from "../auth/legacy-link-windows";

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

  @Post("verify-merge")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per IP — matches verify-email
  @ApiOperation({ summary: "Verify ownership of secondary account via emailed token (POST body)" })
  verifyMergeByBody(@Body() dto: BuyerVerifyMergeDto) {
    return this.mergeService.verifyMergeToken(dto.token);
  }

  /**
   * LEGACY (path token): links emailed before the fragment format carry the token in the URL
   * path. Kept only until `LEGACY_MERGE_LINK_ACCEPT_UNTIL` (audit redacts the path by route
   * template); remove together with the web page's legacy query read.
   */
  @Get("verify-merge/:token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Verify ownership of secondary account via a legacy emailed link (deprecated)",
    deprecated: true,
  })
  verifyMerge(@Param("token") token: string) {
    this.assertLegacyMergePathOpen(new Date());
    return this.mergeService.verifyMergeToken(token);
  }

  /** After the legacy window the path form answers exactly like any unknown token. */
  private assertLegacyMergePathOpen(now: Date): void {
    if (!legacyMergeLinkAccepted(now)) throw new NotFoundException("Invalid verification token");
  }
}

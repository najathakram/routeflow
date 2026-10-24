import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CommitEditRuleDto, EditRuleDto } from "./dto/edit-rule.dto";
import { RuleEditService } from "./rule-edit.service";

// Row 509 PR3. OPERATOR (TENANT_ADMIN satisfies it in RolesGuard; CUSTOMER, DRIVER and buyer tokens are 403).
// An all-customer rule, or an edit INTO one, is TENANT_ADMIN-only: the service refuses an operator with 403.
@ApiTags("selling-restrictions")
@ApiBearerAuth()
@Controller("selling-restrictions")
@UseGuards(JwtAuthGuard, RolesGuard)
export class RuleEditController {
  constructor(private readonly edits: RuleEditService) {}

  @Post(":id/edit-preview")
  @Roles(UserRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Preview an in-place edit of a rule's settings: which way each change moves it, how many open orders and drafts it newly reaches, and the impact fingerprint to confirm with. Writes nothing.",
  })
  @ApiBody({ type: EditRuleDto })
  preview(@Param("id") id: string, @Body() dto: EditRuleDto, @CurrentUser() user: JwtPayload) {
    return this.edits.preview(id, dto, user);
  }

  @Put(":id")
  @Roles(UserRole.OPERATOR)
  @ApiOperation({
    summary:
      "Edit a rule's settings in place (new revision, audited). 409 RULE_STALE / RULE_IMPACT_CHANGED / RULE_NOT_EDITABLE; open orders are not touched.",
  })
  @ApiBody({ type: CommitEditRuleDto })
  commit(@Param("id") id: string, @Body() dto: CommitEditRuleDto, @CurrentUser() user: JwtPayload) {
    return this.edits.commit(id, dto, user);
  }
}

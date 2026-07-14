import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { MessagingService } from "./messaging.service";
import { MessagingConfigService } from "./messaging-config.service";
import { SendMessageDto } from "./dto/send-message.dto";
import { NotifyDto } from "./dto/notify.dto";
import { UpdateRuleDto } from "./dto/update-rule.dto";
import { UpdateTemplateDto } from "./dto/update-template.dto";
import { PreviewTemplateDto } from "./dto/preview-template.dto";
import { UpdateMessagingSettingsDto } from "./dto/update-messaging-settings.dto";

/**
 * P6-2 thin operator surface for the messaging engine. Manual send + a
 * notify test hook + minimal thread reads — the rich inbox is a later
 * increment. All operator-scoped.
 *
 * P6-6 adds the Settings → Notifications config surface (event×channel
 * rules matrix, template editor + preview, quiet-hours): reads stay
 * OPERATOR (class default), writes are method-level TENANT_ADMIN (overrides
 * the class role — the settings/margin pattern; TENANT_ADMIN also satisfies
 * OPERATOR via RolesGuard's hierarchy).
 */
@ApiTags("messaging")
@ApiBearerAuth()
@Controller("messaging")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly config: MessagingConfigService,
  ) {}

  @Post("threads/:customerId/messages")
  @ApiOperation({ summary: "Send a message to a customer over a channel (P6-2 engine)" })
  send(
    @Param("customerId") customerId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.messaging.sendMessage({
      customerId,
      channel: dto.channel,
      body: dto.body,
      eventKey: dto.eventKey,
      senderId: user.id,
      senderRole: "OPERATOR",
    });
  }

  @Post("notify")
  @ApiOperation({ summary: "Fire an event notification across its enabled channels" })
  notify(@Body() dto: NotifyDto, @CurrentUser() user: { id: string }) {
    return this.messaging.notify(dto.eventKey, {
      customerId: dto.customerId,
      senderId: user.id,
      vars: dto.vars,
    });
  }

  @Get("threads")
  listThreads() {
    return this.messaging.listThreads();
  }

  @Get("threads/:id")
  getThread(@Param("id") id: string) {
    return this.messaging.getThread(id);
  }

  // ─── Notifications config (P6-6) ─────────────────────────────────────────

  @Get("config")
  @ApiOperation({
    summary: "Event×channel notification matrix + settings + MSGS meter (lazily seeds defaults)",
  })
  getConfig() {
    return this.config.getMatrix();
  }

  @Patch("rules/:id")
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: "Toggle a notification rule cell (refuses enabling an invoice WA/SMS pair — G12)",
  })
  updateRule(@Param("id") id: string, @Body() dto: UpdateRuleDto) {
    return this.config.setRuleEnabled(id, dto.enabled);
  }

  @Patch("templates/:id")
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: "Edit a message template body/waTemplateName/isActive (body edits re-parse {{vars}})",
  })
  updateTemplate(@Param("id") id: string, @Body() dto: UpdateTemplateDto) {
    return this.config.updateTemplate(id, dto);
  }

  @Post("templates/preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Render a template body against sample vars without persisting" })
  previewTemplate(@Body() dto: PreviewTemplateDto) {
    return this.config.preview(dto.body, dto.vars);
  }

  @Get("settings")
  @ApiOperation({ summary: "Quiet-hours + timezone messaging settings" })
  getSettings() {
    return this.config.getSettings();
  }

  @Patch("settings")
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: "Update quiet-hours + timezone messaging settings (create-on-first-save)",
  })
  updateSettings(@Body() dto: UpdateMessagingSettingsDto) {
    return this.config.updateSettings(dto);
  }
}

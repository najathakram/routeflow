import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { MessagingService } from "./messaging.service";
import { SendMessageDto } from "./dto/send-message.dto";
import { NotifyDto } from "./dto/notify.dto";

/**
 * P6-2 thin operator surface for the messaging engine. Manual send + a
 * notify test hook + minimal thread reads — the rich inbox is a later
 * increment. All operator-scoped.
 */
@ApiTags("messaging")
@ApiBearerAuth()
@Controller("messaging")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

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
}

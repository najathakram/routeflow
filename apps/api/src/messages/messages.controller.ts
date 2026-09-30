import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { MessagesService } from "./messages.service";
import { CreateMessageDto } from "./dto/create-message.dto";
import { ListMessagesDto } from "./dto/list-messages.dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";

// WP5c (R3b.3, R3b.9): flag.messaging ships dark (DARK_PLAN_FLAGS in
// plan-flag-policy.ts) — this class-level guard is a courtesy allow until the
// PLAN_FLAG_ENFORCEMENT switch flips on. notifications.controller.ts is untouched —
// operator device push, not this customer-facing messaging transport.
@ApiTags("messages")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlanFlagGuard)
@RequirePlanFlag("flag.messaging")
@Controller("messages")
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateMessageDto, @CurrentUser() user: { id: string; role: string }) {
    return this.messagesService.create(dto, user.id, user.role);
  }

  @Get()
  findAll(@Query() query: ListMessagesDto, @CurrentUser() user: { sub: string; role: string }) {
    return this.messagesService.findByRun(query, user);
  }
}

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

@ApiTags("messages")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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

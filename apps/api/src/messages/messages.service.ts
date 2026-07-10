import { Injectable } from "@nestjs/common";
import { MessageChannel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateMessageDto } from "./dto/create-message.dto";
import { ListMessagesDto } from "./dto/list-messages.dto";

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateMessageDto, userId: string, senderRole: string) {
    return this.prisma.forTenant().message.create({
      data: {
        runId: dto.runId ?? null,
        text: dto.text,
        senderId: userId,
        senderRole,
      },
      include: {
        sender: {
          select: { id: true, username: true, role: true },
        },
      },
    });
  }

  async findByRun(query: ListMessagesDto) {
    // Run-chat is the INTERNAL channel only. Scope the read to INTERNAL so the
    // P6-2 messaging engine's customer-facing rows (WHATSAPP/SMS/EMAIL/PORTAL,
    // runId=null) never leak into the driver↔operator chat — including the
    // no-runId "all messages" path (`where` was previously `undefined`).
    return this.prisma.forTenant().message.findMany({
      where: {
        channel: MessageChannel.INTERNAL,
        ...(query.runId ? { runId: query.runId } : {}),
      },
      orderBy: { createdAt: "asc" },
      include: {
        sender: {
          select: { id: true, username: true, role: true },
        },
      },
    });
  }
}

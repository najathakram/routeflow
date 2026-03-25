import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateMessageDto } from "./dto/create-message.dto";
import { ListMessagesDto } from "./dto/list-messages.dto";

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateMessageDto, userId: string, senderRole: string) {
    return this.prisma.message.create({
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
    return this.prisma.message.findMany({
      where: query.runId ? { runId: query.runId } : undefined,
      orderBy: { createdAt: "asc" },
      include: {
        sender: {
          select: { id: true, username: true, role: true },
        },
      },
    });
  }
}

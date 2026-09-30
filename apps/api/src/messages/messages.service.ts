import { ForbiddenException, Injectable } from "@nestjs/common";
import { MessageChannel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateMessageDto } from "./dto/create-message.dto";
import { ListMessagesDto } from "./dto/list-messages.dto";

/** Minimal identity shape the run-chat participant gate needs. */
interface MessageUser {
  sub: string;
  role: string;
}

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * F2-006: run-chat is an operator↔driver INTERNAL channel. Only office staff
   * (OPERATOR/TENANT_ADMIN) or the DRIVER assigned to `runId` may read or write it —
   * a CUSTOMER (or any non-participant) is denied, and a non-staff caller can never
   * touch the no-runId "all internal" firehose. Shared by the read + write paths.
   */
  private async assertRunChatParticipant(
    role: string,
    userId: string,
    runId: string | null | undefined,
  ): Promise<void> {
    if (role === "OPERATOR" || role === "TENANT_ADMIN") return;
    if (role !== "DRIVER" || !runId) throw new ForbiddenException();
    const [driver, run] = await Promise.all([
      this.prisma.forTenant().driver.findFirst({ where: { userId } }),
      this.prisma
        .forTenant()
        .routeRun.findFirst({ where: { id: runId }, select: { driverId: true } }),
    ]);
    if (!driver || !run || run.driverId !== driver.id) throw new ForbiddenException();
  }

  async create(dto: CreateMessageDto, userId: string, senderRole: string) {
    // F2-006 (write side): a CUSTOMER must not be able to INJECT a message into the
    // operator↔driver INTERNAL run-chat (create always writes an INTERNAL message).
    await this.assertRunChatParticipant(senderRole, userId, dto.runId);
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

  async findByRun(query: ListMessagesDto, user: MessageUser) {
    // F2-006: gate reads so a CUSTOMER can't enumerate a runId and read the internal
    // thread; a DRIVER may read only a run they're assigned to (never the firehose).
    await this.assertRunChatParticipant(user.role, user.sub, query.runId);

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

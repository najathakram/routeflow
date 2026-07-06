import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { SaveDraftDto } from "./dto/save-draft.dto";

/**
 * Minimize & resume drafts (pos-cost-roles-spec §2). Drafts are per-user and
 * tenant-scoped; `payload` holds the full builder state. Autosave upserts the
 * same draft repeatedly, so writes stay cheap and the dock always reflects the
 * latest state. Docked drafts never expire; deleting is explicit.
 */
@Injectable()
export class DraftsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The current user's drafts, newest first (cap 50 — matches the dock). */
  list(user: JwtPayload) {
    return this.prisma.forTenant().saleDraft.findMany({
      where: { userId: user.sub },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
  }

  create(user: JwtPayload, dto: SaveDraftDto) {
    return this.prisma.forTenant().saleDraft.create({
      data: {
        // forTenant() also injects tenantId at runtime; set it explicitly so the
        // create input is type-safe (same value, no conflict).
        tenantId: user.tenantId!,
        userId: user.sub,
        kind: dto.kind ?? "ORDER",
        customerId: dto.customerId ?? null,
        customerName: dto.customerName ?? null,
        title: dto.title ?? null,
        payload: (dto.payload ?? {}) as Prisma.InputJsonValue,
        device: dto.device ?? null,
      },
    });
  }

  async update(user: JwtPayload, id: string, dto: SaveDraftDto) {
    await this.assertOwned(user, id);
    const data: Prisma.SaleDraftUpdateInput = {};
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.customerId !== undefined) data.customerId = dto.customerId;
    if (dto.customerName !== undefined) data.customerName = dto.customerName;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.device !== undefined) data.device = dto.device;
    if (dto.payload !== undefined) data.payload = dto.payload as Prisma.InputJsonValue;
    return this.prisma.forTenant().saleDraft.update({ where: { id }, data });
  }

  async get(user: JwtPayload, id: string) {
    return this.assertOwned(user, id);
  }

  async remove(user: JwtPayload, id: string) {
    await this.assertOwned(user, id);
    await this.prisma.forTenant().saleDraft.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Load a draft and confirm the caller owns it. `forTenant()` blocks
   * cross-tenant ids; the userId check enforces per-user ownership. Returns
   * the draft so callers can reuse it.
   */
  private async assertOwned(user: JwtPayload, id: string) {
    const draft = await this.prisma.forTenant().saleDraft.findUnique({ where: { id } });
    if (!draft || draft.userId !== user.sub) throw new NotFoundException("Draft not found");
    return draft;
  }
}

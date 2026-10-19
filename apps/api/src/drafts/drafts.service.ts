import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { SaveDraftDto } from "./dto/save-draft.dto";

/**
 * SA-817 (A) 4: the order builder keeps ONE Idempotency-Key per draft in `payload._submitKey`, so a reload followed by a resubmit
 * replays the same key. The literal is a copy of `DRAFT_SUBMIT_KEY_FIELD` in `packages/types/draft-submit-key.ts` (the API never
 * value-imports `@routeflow/types` at runtime); `drafts.service.spec.ts` pins the two equal.
 *
 * The rule, in full:
 *  - the service keeps the key VERBATIM: it never generates, trims or rewrites one;
 *  - a PATCH whose payload omits the key keeps the stored one (an older client, or a poison-pill write, cannot erase it);
 *  - a payload whose key is already on ANOTHER draft of the same user is refused (400): a key identifies one cart, and carrying
 *    it onto a copy would make a second draft look like a replay of the first draft's order;
 *  - a key must be a legal Idempotency-Key header value (1-128 printable ASCII, no spaces).
 */
export const DRAFT_SUBMIT_KEY_FIELD = "_submitKey";
const SUBMIT_KEY_RULE = /^[\x21-\x7e]{1,128}$/;

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

  async create(user: JwtPayload, dto: SaveDraftDto) {
    await this.assertKeyNotOnOtherDraft(user, null, dto.payload);
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

  /**
   * PATCH. With `expectedUpdatedAt` (SA-817 A2) the write is a compare-and-set on `updatedAt`: this service is the only writer of
   * `SaleDraft`, so `updatedAt` is a valid precondition. A mismatch means another device wrote after the caller's last sync: 409
   * `DRAFT_CHANGED` carrying the current row, nothing written. Without it the write is last-write-wins, as before.
   */
  async update(user: JwtPayload, id: string, dto: SaveDraftDto) {
    const draft = await this.assertOwned(user, id);
    const data: Prisma.SaleDraftUpdateInput = {};
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.customerId !== undefined) data.customerId = dto.customerId;
    if (dto.customerName !== undefined) data.customerName = dto.customerName;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.device !== undefined) data.device = dto.device;
    if (dto.payload !== undefined) {
      await this.assertKeyNotOnOtherDraft(user, id, dto.payload);
      data.payload = this.keepStoredKey(draft.payload, dto.payload) as Prisma.InputJsonValue;
    }
    if (dto.expectedUpdatedAt === undefined) {
      return this.prisma.forTenant().saleDraft.update({ where: { id }, data });
    }
    const { count } = await this.prisma.forTenant().saleDraft.updateMany({
      where: { id, userId: user.sub, updatedAt: new Date(dto.expectedUpdatedAt) },
      data: data as Prisma.SaleDraftUpdateManyMutationInput,
    });
    const current = await this.assertOwned(user, id); // a draft deleted meanwhile is a 404, not a conflict
    if (count === 0) {
      throw new ConflictException({
        code: API_ERROR_CODES.DRAFT_CHANGED,
        message: "This draft was changed on another device.",
        current,
      });
    }
    return current;
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

  /** A payload that omits `_submitKey` keeps the one already stored (it is never erased by a write that does not know it). */
  private keepStoredKey(stored: Prisma.JsonValue, incoming: Record<string, unknown>) {
    if (DRAFT_SUBMIT_KEY_FIELD in incoming) return incoming;
    const key = this.keyOf(stored);
    return key === undefined ? incoming : { ...incoming, [DRAFT_SUBMIT_KEY_FIELD]: key };
  }

  private keyOf(payload: unknown): string | undefined {
    const key =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)[DRAFT_SUBMIT_KEY_FIELD]
        : undefined;
    return typeof key === "string" ? key : undefined;
  }

  /**
   * The key is a legal header value, and is not already on another of THIS user's drafts (tenant scope comes from `forTenant()`).
   * `exceptId` is the draft being written (its own key is fine).
   */
  private async assertKeyNotOnOtherDraft(
    user: JwtPayload,
    exceptId: string | null,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!payload || !(DRAFT_SUBMIT_KEY_FIELD in payload)) return;
    const key = payload[DRAFT_SUBMIT_KEY_FIELD];
    if (typeof key !== "string" || !SUBMIT_KEY_RULE.test(key)) {
      throw new BadRequestException("The draft's submit key is not valid.");
    }
    const other = await this.prisma.forTenant().saleDraft.findFirst({
      where: {
        userId: user.sub,
        ...(exceptId ? { id: { not: exceptId } } : {}),
        payload: { path: [DRAFT_SUBMIT_KEY_FIELD], equals: key },
      },
      select: { id: true },
    });
    if (other) throw new BadRequestException("That submit key belongs to another draft.");
  }
}

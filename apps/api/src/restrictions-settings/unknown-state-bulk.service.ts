import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import type { BulkStateResponse, BulkStateUndoResponse } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { AddressStateSnapshot } from "../customers/address-state";
import {
  createMinimalAddresses,
  deleteUntouchedAddress,
  restoreAddressState,
  setChosenAddressState,
} from "../customers/address-state-writes";
import { chosenStateOr400 } from "../customers/customer-address-state.service";
import { excludeWalkIn } from "../customers/walk-in-protected";
import { PrismaService } from "../prisma/prisma.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import {
  BULK_STATE_UNDO_MAX_ADDRESSES,
  BulkStateDto,
  BulkStateUndoDto,
} from "./dto/bulk-state.dto";
import {
  BULK_STATE_MAX,
  BULK_STATE_UNDO_WINDOW_MIN,
  placeUnknownState,
  type UnknownStateAddress,
} from "./unknown-state";
import { UNKNOWN_STATE_CUSTOMER_SELECT } from "./unknown-state-customers.service";

export const AUDIT_BULK_STATE_SET = "customer_address.bulk_state_set";
export const AUDIT_BULK_STATE_UNDONE = "customer_address.bulk_state_undone";

/** How many recent bulk-state audit rows an undo searches for its originating action. */
const UNDO_SEARCH_ROWS = 200;

/**
 * One address a bulk-state action touched, as its audit row stores it: whether the action CREATED the
 * address (a no-address customer's minimal address) or updated an existing one (then `prior` is the
 * three state columns as they were), and the `updatedAt` the write left — an undo acts on the address
 * only while that is unchanged ("untouched since").
 */
export interface BulkStateEntry {
  addressId: string;
  customerId: string;
  created: boolean;
  prior: AddressStateSnapshot | null;
  updatedAt: string;
}

/** The entries of a bulk-state audit row's `meta`; malformed ones are dropped, never guessed. */
export function bulkStateEntries(meta: unknown): BulkStateEntry[] {
  const list = (meta as { addresses?: unknown } | null)?.addresses;
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is BulkStateEntry => {
    if (!e || typeof e !== "object") return false;
    const x = e as Record<string, unknown>;
    const prior = x.prior as Record<string, unknown> | null | undefined;
    const priorOk =
      x.created === true
        ? prior === null
        : !!prior &&
          typeof prior.state === "string" &&
          (prior.stateCode === null || typeof prior.stateCode === "string") &&
          typeof prior.stateNeedsReview === "boolean";
    return (
      typeof x.addressId === "string" &&
      typeof x.customerId === "string" &&
      typeof x.created === "boolean" &&
      typeof x.updatedAt === "string" &&
      !Number.isNaN(Date.parse(x.updatedAt)) &&
      priorOk
    );
  });
}

/**
 * Bulk "Set state for all shown" on the customers-without-a-state card, and its 10-minute Undo.
 * Both are ONE tenant transaction with ONE audit row written inside it. Writes go through the shared
 * customer-address writers (`customers/address-state-writes.ts`).
 */
@Injectable()
export class UnknownStateBulkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: SellingRestrictionsService,
  ) {}

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  /**
   * POST .../bulk-state: sets `state` for every named customer that is STILL in `bucket` (a stale
   * selection is skipped, not an error): noAddress customers get a minimal default billing address;
   * unusableState / needsReview customers get the state on each governing address of that kind.
   * Customers of another tenant, deleted ones and the walk-in are never read, so they are skipped.
   */
  async bulkSet(dto: BulkStateDto, user: JwtPayload): Promise<BulkStateResponse> {
    const tenantId = this.requireTenant();
    const ids = [...new Set(dto.customerIds ?? [])];
    if (ids.length === 0) throw new BadRequestException("Choose at least one customer.");
    if (ids.length > BULK_STATE_MAX) {
      throw new BadRequestException(`Set a state for at most ${BULK_STATE_MAX} customers at once.`);
    }
    const code = chosenStateOr400(dto.state);
    const { addressPrecedence } = await this.engine.getPolicy(tenantId);

    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const customers = await tx.customer.findMany({
        where: excludeWalkIn({ tenantId, deletedAt: null, id: { in: ids } }),
        select: UNKNOWN_STATE_CUSTOMER_SELECT,
      });
      const updates: Array<{ customerId: string; address: UnknownStateAddress }> = [];
      const creates: Array<{ id: string; customerId: string; zip: null }> = [];
      for (const customer of customers) {
        const placed = placeUnknownState(customer, addressPrecedence)[dto.bucket];
        if (!placed) continue; // no longer in this bucket: skipped
        if (dto.bucket === "noAddress") {
          creates.push({ id: randomUUID(), customerId: customer.id, zip: null });
          continue;
        }
        const targets = [placed.address, ...placed.others].filter(
          (a): a is UnknownStateAddress => a !== null,
        );
        // A legacy address with no tenant id can't be written through the tenant client: skip the customer.
        if (targets.length === 0 || targets.some((a) => a.tenantId !== tenantId)) continue;
        for (const address of targets) updates.push({ customerId: customer.id, address });
      }
      const changedCustomerIds = [
        ...new Set([...updates.map((u) => u.customerId), ...creates.map((c) => c.customerId)]),
      ];
      if (changedCustomerIds.length === 0) return { changed: 0, changedAddressIds: [] };

      const updateIds = updates.map((u) => u.address.id);
      if (updateIds.length > 0) {
        const count = await setChosenAddressState(tx, tenantId, updateIds, code);
        if (count !== updateIds.length) {
          throw new ConflictException(
            "Some of these customers changed while you were saving. Nothing was changed. Reload and try again.",
          );
        }
      }
      if (creates.length > 0) await createMinimalAddresses(tx, tenantId, creates, code);

      const changedAddressIds = [...updateIds, ...creates.map((c) => c.id)];
      const written = await tx.customerAddress.findMany({
        where: { tenantId, id: { in: changedAddressIds } },
        select: { id: true, updatedAt: true },
      });
      const stamp = new Map(written.map((w) => [w.id, w.updatedAt.toISOString()]));
      const entries: BulkStateEntry[] = [
        ...updates.map((u) => ({
          addressId: u.address.id,
          customerId: u.customerId,
          created: false,
          prior: {
            state: u.address.state,
            stateCode: u.address.stateCode,
            stateNeedsReview: u.address.stateNeedsReview,
          },
          updatedAt: stamp.get(u.address.id) ?? "",
        })),
        ...creates.map((c) => ({
          addressId: c.id,
          customerId: c.customerId,
          created: true,
          prior: null,
          updatedAt: stamp.get(c.id) ?? "",
        })),
      ];
      if (entries.some((e) => e.updatedAt === "")) {
        throw new ConflictException(
          "The change could not be saved. Nothing was changed. Try again.",
        );
      }
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          impersonatedBy: user.impersonatedBy ?? null,
          action: AUDIT_BULK_STATE_SET,
          entityType: "CustomerAddress",
          entityId: null,
          meta: {
            bucket: dto.bucket,
            state: code,
            customerIds: changedCustomerIds,
            skippedCustomerIds: ids.filter((id) => !changedCustomerIds.includes(id)),
            addressIds: changedAddressIds,
            addresses: entries as unknown as Prisma.InputJsonValue,
          },
        },
      });
      return { changed: changedCustomerIds.length, changedAddressIds };
    });
  }

  /**
   * POST .../bulk-state/undo: within BULK_STATE_UNDO_WINDOW_MIN of the bulk write that produced these
   * address ids, restores each updated address's prior state columns and removes each address that
   * same action created — each only while untouched since (an address edited meanwhile is left alone).
   * The origin is the newest bulk action that recorded ALL the ids (else the newest naming any).
   * Idempotent: a repeat restores 0 and answers `{ restored: 0 }`. 404 when no bulk action of this
   * tenant names the ids; 409 (nothing changed) once the window has passed.
   */
  async undo(dto: BulkStateUndoDto, user: JwtPayload): Promise<BulkStateUndoResponse> {
    const tenantId = this.requireTenant();
    const ids = [...new Set(dto.changedAddressIds ?? [])];
    if (ids.length === 0) throw new BadRequestException("Name at least one address to restore.");
    if (ids.length > BULK_STATE_UNDO_MAX_ADDRESSES) {
      throw new BadRequestException("That is more addresses than one change can include.");
    }
    const wanted = new Set(ids);
    const now = Date.now();

    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const recent = await tx.auditLog.findMany({
        where: { tenantId, action: AUDIT_BULK_STATE_SET },
        orderBy: { createdAt: "desc" },
        take: UNDO_SEARCH_ROWS,
        select: { id: true, createdAt: true, meta: true },
      });
      // The action these ids came from: the newest one that recorded ALL of them, so a retried undo
      // of an earlier action never lands on a later action that shares an id (that would revert it).
      // Only when no single action recorded them all, the newest one naming any of them.
      const named = (r: (typeof recent)[number]) =>
        new Set(bulkStateEntries(r.meta).map((e) => e.addressId));
      const origin =
        recent.find((r) => {
          const has = named(r);
          return ids.every((id) => has.has(id));
        }) ?? recent.find((r) => ids.some((id) => named(r).has(id)));
      if (!origin) throw new NotFoundException("There is no change to undo for these addresses.");
      if (now - origin.createdAt.getTime() > BULK_STATE_UNDO_WINDOW_MIN * 60_000) {
        throw new ConflictException(
          `This change can no longer be undone: undo is available for ${BULK_STATE_UNDO_WINDOW_MIN} minutes after it is made. Nothing was changed.`,
        );
      }
      const restoredAddressIds: string[] = [];
      const skippedAddressIds: string[] = [];
      for (const e of bulkStateEntries(origin.meta)) {
        if (!wanted.has(e.addressId)) continue;
        const since = new Date(e.updatedAt);
        const n = e.created
          ? await deleteUntouchedAddress(tx, tenantId, e.addressId, since)
          : await restoreAddressState(
              tx,
              tenantId,
              e.addressId,
              since,
              e.prior as AddressStateSnapshot,
            );
        (n === 1 ? restoredAddressIds : skippedAddressIds).push(e.addressId);
      }
      if (restoredAddressIds.length > 0) {
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: user.sub,
            impersonatedBy: user.impersonatedBy ?? null,
            action: AUDIT_BULK_STATE_UNDONE,
            entityType: "CustomerAddress",
            entityId: null,
            meta: { bulkAuditId: origin.id, restoredAddressIds, skippedAddressIds },
          },
        });
      }
      return { restored: restoredAddressIds.length };
    });
  }
}

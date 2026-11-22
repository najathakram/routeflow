import { billLineLocked } from "@routeflow/pricing";
import { randomUUID } from "crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertRefsInTenant } from "../common/assert-refs-in-tenant";
import type { PrismaService } from "../prisma/prisma.service";
import { billItemPack, NO_IDENTITY, type StoredBillItemIdentity } from "./bill-item-data";

/**
 * SA-1207 S2b spec 6-7: who writes the three reserved line columns (`unitLabel`, `familyProductId`,
 * `familyGroupId`), and from where.
 *  - CREATE: the client names its own unit label, the family and a per-bill group ordinal; the server mints
 *    the group id and proves each group (one family, every product an active variant of it, all in-tenant).
 *  - EDIT: rows are paired by `id` and the three columns come from the STORED row, never the client.
 */

export async function resolveCreateIdentities(
  prisma: PrismaService,
  items: any[] | undefined | null,
): Promise<StoredBillItemIdentity[]> {
  const list = Array.isArray(items) ? items : [];
  const refuse = (message: string): never => {
    throw new BadRequestException(message);
  };
  const groups = new Map<number, { family: string; productIds: string[] }>();
  for (const i of list) {
    const hasFamily = i.familyProductId != null;
    if (hasFamily !== (i.familyGroup != null)) {
      refuse("A split line needs both its family and its group.");
    }
    if (!hasFamily) continue;
    if (!i.productId) refuse("A split line needs a product.");
    const g = groups.get(i.familyGroup) ?? {
      family: i.familyProductId,
      productIds: [] as string[],
    };
    if (g.family !== i.familyProductId) refuse("One split line comes from one family.");
    g.productIds.push(i.productId);
    groups.set(i.familyGroup, g);
  }
  const minted = new Map<number, string>();
  if (groups.size > 0) {
    const families = [...new Set([...groups.values()].map((g) => g.family))];
    const variants = [...new Set([...groups.values()].flatMap((g) => g.productIds))];
    await assertRefsInTenant(prisma, { productIds: [...families, ...variants] });
    const rows = await prisma.forTenant().product.findMany({
      where: { id: { in: [...families, ...variants] } },
      select: { id: true, parentProductId: true, isActive: true },
    });
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    for (const [ordinal, g] of groups) {
      if (!byId.has(g.family)) refuse("The family of this split line was not found.");
      for (const pid of g.productIds) {
        const v: any = byId.get(pid);
        if (!v || v.parentProductId !== g.family || v.isActive === false) {
          refuse("Every part of a split line must be an active variant of its family.");
        }
      }
      minted.set(ordinal, randomUUID());
    }
  }
  return list.map((i) => ({
    unitLabel: i.unitLabel?.trim() ? i.unitLabel.trim() : null,
    familyProductId: i.familyGroup != null ? i.familyProductId : null,
    familyGroupId: i.familyGroup != null ? (minted.get(i.familyGroup) ?? null) : null,
  }));
}

interface StoredLine extends StoredBillItemIdentity {
  id: string;
  productId: string | null;
  qty: Prisma.Decimal | number | string;
  packSize: number | null;
}

const locked = (message: string) =>
  new ConflictException({ code: API_ERROR_CODES.SPLIT_LINE_LOCKED, message });

/** Pair an edit's rows with the stored lines by id; one identity per incoming row, from the stored row. */
export function carryStoredIdentities(
  stored: StoredLine[],
  incoming: any[],
): StoredBillItemIdentity[] {
  const byId = new Map(stored.map((s) => [s.id, s]));
  const lockedLines = stored.filter(billLineLocked);
  if (lockedLines.length > 0 && incoming.every((i) => !i.id)) {
    throw locked("This bill has a split line. Edit this bill on the web.");
  }
  const echoed = new Set<string>();
  const out = incoming.map((i) => {
    if (!i.id) return NO_IDENTITY;
    const s = byId.get(i.id);
    if (!s) throw new BadRequestException("A line on this edit is not on this bill.");
    echoed.add(s.id);
    if (billLineLocked(s)) {
      const same =
        (billItemPack(i) ?? 0) === (s.packSize ?? 0) &&
        (i.productId || null) === s.productId &&
        new Prisma.Decimal(i.qty || 1).eq(new Prisma.Decimal(s.qty as Prisma.Decimal.Value));
      if (!same) throw locked("A split line can change its price only.");
    }
    return {
      unitLabel: s.unitLabel,
      familyProductId: s.familyProductId,
      familyGroupId: s.familyGroupId,
    };
  });
  const groupsKept = new Set(
    lockedLines.filter((s) => echoed.has(s.id)).map((s) => s.familyGroupId),
  );
  for (const s of lockedLines) {
    if (s.familyGroupId && !echoed.has(s.id) && groupsKept.has(s.familyGroupId)) {
      throw locked("A split line is edited or removed as a whole.");
    }
  }
  return out;
}

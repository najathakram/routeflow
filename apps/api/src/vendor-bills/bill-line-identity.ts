import { billLineLocked, billLineUnit } from "@routeflow/pricing";
import { randomUUID } from "crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertRefsInTenant } from "../common/assert-refs-in-tenant";
import { assertNoDuplicateLineIds } from "../common/duplicate-line-ids";
import type { PrismaService } from "../prisma/prisma.service";
import {
  billItemData,
  billItemPack,
  NO_IDENTITY,
  type StoredBillItemIdentity,
} from "./bill-item-data";

/** SA-1207 S2b spec 6-7: CREATE mints the group id and proves each group; EDIT carries identity from the STORED row. */

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
  list.forEach((i) => assertWholeLotQty({ ...i, unitLabel: billLineUnit(i).label }));
  return list.map((i) => ({
    unitLabel: billLineUnit(i).label,
    familyProductId: i.familyGroup != null ? i.familyProductId : null,
    familyGroupId: i.familyGroup != null ? (minted.get(i.familyGroup) ?? null) : null,
  }));
}

interface StoredLine extends StoredBillItemIdentity {
  id: string;
  productId: string | null;
  qty: Prisma.Decimal | number | string;
  packSize: number | null;
  description?: string | null;
  sku?: string | null;
  lineTotal?: Prisma.Decimal | number | string | null;
}

/** SA-1223 M2: a lot is counted in whole units. One rule for create, edit and every receive plan. */
const isLotLine = (item: { packSize?: unknown; unitLabel?: string | null }) =>
  billLineUnit({ packSize: billItemPack(item), unitLabel: item.unitLabel }).kind === "lot";

/** The one refusal text for a part lot: names the product and the pack, and a way out. */
export const wholeLotQtyMessage = (description: string, factor: number) =>
  `"${description}" comes in packs of ${factor}. Use a whole number of packs, or remove the line and add it again.`;

const wholeLot = (code: string, message: string) => new BadRequestException({ code, message });

/** A lot is counted in whole units: the ONE check for create and every edit row (the RESULTING row). */
export function assertWholeLotQty(item: {
  description?: string | null;
  packSize?: unknown;
  unitLabel?: string | null;
  qty?: unknown;
}) {
  if (isLotLine(item) && !Number.isInteger(Number(item.qty || 1))) {
    const name = item.description || "This line";
    throw wholeLot(API_ERROR_CODES.LOT_QTY_NOT_WHOLE, wholeLotQtyMessage(name, unitFactor(item)));
  }
}

/** Every planned receive pair (per-line and full-receive plans alike) passes through here. */
export function assertWholeLotReceive(
  item: { description: string; packSize: number | null; unitLabel: string | null },
  receiveQty: Prisma.Decimal,
) {
  if (isLotLine(item) && !receiveQty.isInteger()) {
    throw wholeLot(
      API_ERROR_CODES.RECEIVE_PARTIAL_UNIT,
      `"${item.description}" is one unit of ${billLineUnit(item).factor} pieces and can't be received in part. Add it again as a new line in whole packs, save, then remove this line.`,
    );
  }
}

const unitFactor = (x: { packSize?: unknown }) =>
  billLineUnit({ packSize: billItemPack(x) }).factor;

const locked = (message: string) =>
  new ConflictException({ code: API_ERROR_CODES.SPLIT_LINE_LOCKED, message });

/**
 * SA-1238 A2-A5: the pack the edit of a stored PO line writes. A labelled line carries its STORED pack and
 * label (its identity), so a product change on it is refused (409); an unlabelled line takes the incoming pack.
 * A lot line is judged only when its qty changed (an untouched legacy part lot is left to the receive check):
 * qty (pieces) must be whole packs by an exact Decimal remainder.
 */
export function editedLinePack(
  stored: {
    productId?: string | null;
    packSize?: unknown;
    unitLabel?: string | null;
    qtyOrdered: Prisma.Decimal.Value;
  },
  next: {
    productId?: string | null;
    packSize?: unknown;
    qty: Prisma.Decimal.Value;
    description: string;
  },
) {
  const labelled = billLineUnit({ unitLabel: stored.unitLabel }).stated;
  if (labelled && next.productId !== stored.productId) {
    throw locked("To change the product on this line, remove the line and add a new one.");
  }
  const pack = labelled ? stored.packSize : next.packSize;
  const row = { packSize: pack, unitLabel: stored.unitLabel };
  const changed = !new Prisma.Decimal(next.qty).eq(stored.qtyOrdered);
  if (changed && isLotLine(row) && !new Prisma.Decimal(next.qty).mod(unitFactor(row)).isZero()) {
    throw wholeLot(
      API_ERROR_CODES.LOT_QTY_NOT_WHOLE,
      wholeLotQtyMessage(next.description, unitFactor(row)),
    );
  }
  return pack;
}

/** An edit's identities: stored rows carry theirs; a NEW row gets the create rule's, never none (SA-1224 MED-1). */
export async function resolveEditIdentities(
  prisma: PrismaService,
  stored: StoredLine[],
  incoming: any[],
): Promise<StoredBillItemIdentity[]> {
  const carried = carryStoredIdentities(stored, incoming);
  const fresh = await resolveCreateIdentities(
    prisma,
    incoming.filter((i) => !i.id),
  );
  const out = carried.map((c, n) => (incoming[n].id ? c : fresh.shift()!));
  // New rows were judged by the create rule above; a locked echoed row is proven unchanged by the lock compare.
  out.forEach((o, n) => {
    const s = incoming[n].id && stored.find((x) => x.id === incoming[n].id);
    if (s && !billLineLocked(s)) assertWholeLotQty({ ...incoming[n], unitLabel: o.unitLabel });
  });
  return out;
}

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
  assertNoDuplicateLineIds(incoming, { keys: ["id"] });
  const echoed = new Set<string>();
  const out = incoming.map((i) => {
    if (!i.id) return NO_IDENTITY;
    const s = byId.get(i.id);
    if (!s) throw new BadRequestException("A line on this edit is not on this bill.");
    echoed.add(s.id);
    if (billLineLocked(s)) {
      const w = billItemData(i, null);
      const same =
        unitFactor(i) === unitFactor(s) &&
        (i.productId || null) === s.productId &&
        new Prisma.Decimal(i.qty || 1).eq(new Prisma.Decimal(s.qty as Prisma.Decimal.Value)) &&
        w.description.trim() === (s.description ?? "").trim() &&
        w.sku === (s.sku || null) &&
        (w.lineTotal === null
          ? s.lineTotal == null
          : s.lineTotal != null && w.lineTotal.eq(new Prisma.Decimal(s.lineTotal)));
      if (!same) throw locked("A split line can change its price only.");
    }
    // The stored label names the stored pack: a re-packed row takes the label the create rule gives it.
    const unitLabel = unitFactor(i) === unitFactor(s) ? s.unitLabel : billLineUnit(i).label;
    return {
      unitLabel,
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

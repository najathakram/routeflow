import {
  customerLinePrice,
  withinStaffOverrideTolerance,
  type CustomerLayerUnit,
} from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { customerLineSpecial } from "@/lib/order-line-unit";
import { payloadHash } from "./payload-hash";
import type { LocalDraftRecord } from "./storage";

/**
 * SA-817 (A) 3/7: what the order screen offers on open, and how a resumed order is re-priced for display.
 */

export const RESUME_PROMPT_TITLE = "Resume your unsent order?";

/** A server draft as `GET /drafts` returns it (only what resume needs). */
export interface ServerDraftSummary {
  id: string;
  updatedAt: string;
  payload: Record<string, unknown>;
}

export interface ResumeCandidate {
  record: LocalDraftRecord;
  /** The server draft changed after our last sync (device B): saving will offer "keep both", never overwrite. */
  serverMoved: boolean;
}

export interface ResumeScan {
  /** Local copies to offer: newer than their server draft, or with none. */
  resumable: ResumeCandidate[];
  /** Local copies with nothing left to keep: the server holds an identical payload, or the order was submitted. */
  obsolete: LocalDraftRecord[];
}

const submitted = (payload: unknown): boolean =>
  !!(payload as { submittedAt?: unknown } | null | undefined)?.submittedAt;

const parkable = (payload: Record<string, unknown>): boolean =>
  !!payload.customer && Array.isArray(payload.lineItems) && payload.lineItems.length > 0;

/**
 * A local copy is offered when it holds something the server lacks. Nothing is auto-deleted: only a copy the server already holds
 * byte-for-byte (same payload hash), or one whose order was submitted (`payload.submittedAt`, the existing poison pill), is
 * reported `obsolete`. No device clock is compared: "newer" is decided by the hash and by `serverUpdatedAt` (the server's own stamp).
 */
export function findResumable(
  records: readonly LocalDraftRecord[],
  serverDrafts: readonly ServerDraftSummary[],
): ResumeScan {
  const resumable: ResumeCandidate[] = [];
  const obsolete: LocalDraftRecord[] = [];
  for (const record of records) {
    if (submitted(record.payload)) {
      obsolete.push(record);
      continue;
    }
    const server = record.serverDraftId
      ? serverDrafts.find((d) => d.id === record.serverDraftId)
      : undefined;
    if (server && submitted(server.payload)) {
      obsolete.push(record);
      continue;
    }
    if (server && payloadHash(server.payload) === record.hash) {
      obsolete.push(record);
      continue;
    }
    if (!parkable(record.payload)) continue; // nothing worth offering; kept, not deleted
    resumable.push({
      record,
      serverMoved: !!server && server.updatedAt !== record.serverUpdatedAt,
    });
  }
  resumable.sort((a, b) => (a.record.savedAt < b.record.savedAt ? 1 : -1));
  return { resumable, obsolete };
}

// ─── Re-price for display ───────────────────────────────────────────────────

/** The line fields re-pricing reads/writes (the modal's `LineItem` and the draft's `DraftLineItem` both satisfy it). */
export interface ResumeLine {
  tempId: string;
  productId: string;
  unitPrice: number;
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  specialPrice?: number;
  discountedPrice?: number;
  overrideReason?: string;
  isUnlisted?: boolean;
  unitLabel?: string;
  tierPrices?: unknown;
  /** The price the line carried when the order was parked, set when today's price differs. */
  priceChangedFrom?: number;
}

export interface ResumeRepriceResult<T extends ResumeLine> {
  lines: T[];
  /** Lines whose price moved. */
  changed: number;
}

/**
 * Today's price for every non-overridden line of a resumed order, from the customer's price read (the same `customerLinePrice`
 * the order modal prices with; one batch read supplies `layerOf` and `tierFor`). Display only: the server prices again at submit,
 * so what is shown is what is billed.
 *
 * Left exactly as typed: an unlisted line, a unit line (its own picker prices it), a line with no tier snapshot, and any
 * staff override (`DISCOUNTED`, or a one-time `discountedPrice`) together with its `overrideReason`. A line whose price moved gets the
 * new price, its classification, and `priceChangedFrom` (the parked price) for the "Price changed since you started" note.
 */
export function repriceResumedLines<T extends ResumeLine>(
  lines: readonly T[],
  tierFor: (productId: string) => number,
  layerOf?: (productId: string) => readonly CustomerLayerUnit[] | undefined,
): ResumeRepriceResult<T> {
  let changed = 0;
  const next = lines.map((li) => {
    if (li.isUnlisted || li.unitLabel || !li.tierPrices) return li;
    if (li.priceType === "DISCOUNTED" || li.discountedPrice != null) return li; // a staff-typed override survives as typed
    const lp = customerLinePrice({
      product: li.tierPrices as Record<string, unknown>,
      tier: tierFor(li.productId),
      layer: layerOf?.(li.productId),
    });
    if (withinStaffOverrideTolerance(lp.price, li.unitPrice)) return li;
    changed += 1;
    return {
      ...li,
      unitPrice: lp.price,
      priceType: lp.priceType,
      specialPrice: customerLineSpecial(lp),
      priceChangedFrom: li.priceChangedFrom ?? li.unitPrice,
    };
  });
  return { lines: next, changed };
}

/** "Price changed since you started ($10.00 → $12.00)". */
export function priceChangedCopy(from: number, to: number): string {
  return `Price changed since you started (${formatMoney(from)} → ${formatMoney(to)})`;
}

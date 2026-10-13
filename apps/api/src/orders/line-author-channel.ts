import type { RestrictionChannel } from "@routeflow/types";
import {
  restrictionChannelForPrincipal,
  type ChannelPrincipal,
} from "../selling-restrictions/selling-restrictions.core";

/**
 * F1(i): which selling-restrictions channel a DRAFT line is judged on when the draft becomes a real sale
 * (changeStatus promotion) or an at-door ADD_ITEM is approved: the STRICTER of the acting principal's channel and
 * the channel of whoever AUTHORED the line, mirroring order-templates' `leastPrivilegedAuthor` (an unattended run
 * is STAFF only when the creator AND the last items-editor are both known staff).
 *
 * No order line records its author, and this change adds no column. What an order does record:
 *  - `Order.source` (APP / PHONE / ROUTE): written by `create()` from the creating principal
 *    (`orderSourceForRole`). APP = buyer, PHONE = office staff, ROUTE = driver. Every row that predates the write
 *    carries the column default APP, which reads as the buyer: the stricter side.
 *  - `OrderRevision` rows (editor role + the line snapshot AFTER each edit). Diffing consecutive snapshots says who
 *    added a line and who raised its quantity; a merge/sweep writes a revision with no editor, which reads as unknown.
 * Anything unknown is the BUYER channel. A staff edit never moves a buyer line to the staff channel.
 *
 * Pure: no I/O, no Prisma, no Nest. The callers read the order and its revisions.
 */

/** The strictest channel of the two: the buyer portal whenever either is (its rules always apply). */
export function stricterChannel(a: RestrictionChannel, b: RestrictionChannel): RestrictionChannel {
  return a === "STAFF" && b === "STAFF" ? "STAFF" : "BUYER_PORTAL";
}

/** A recorded role's channel: positively-staff roles are STAFF; a customer, an unknown or missing role is the buyer. */
export function channelOfRole(role: string | null | undefined): RestrictionChannel {
  return restrictionChannelForPrincipal({ role: role ?? null });
}

/** What `create()` stamps on `Order.source` for the principal that creates the order. */
export function orderSourceForRole(role: string | null | undefined): "APP" | "PHONE" | "ROUTE" {
  if (role === "DRIVER") return "ROUTE";
  return channelOfRole(role) === "STAFF" ? "PHONE" : "APP";
}

/** The creation channel an `Order.source` records; APP, a missing or unknown value is the buyer. */
export function channelOfOrderSource(source: string | null | undefined): RestrictionChannel {
  return source === "PHONE" || source === "ROUTE" ? "STAFF" : "BUYER_PORTAL";
}

/** The slice of an `OrderRevision` the derivation reads. */
export interface AuthorRevision {
  editedByRole?: string | null;
  /** `{ lineItems: [{ productId, qty }] }` after the edit (order-revisions.ts `revisionSnapshot`). */
  snapshot?: unknown;
}

export interface LineAuthors {
  /** The channel the line for `productId` was authored on. */
  channelOf(productId: string): RestrictionChannel;
}

/** productId -> total qty of a revision snapshot; null when the snapshot is not the shape the writer produces. */
function snapshotQuantities(snapshot: unknown): Map<string, number> | null {
  const lines = (snapshot as { lineItems?: unknown } | null | undefined)?.lineItems;
  if (!Array.isArray(lines)) return null;
  const out = new Map<string, number>();
  for (const l of lines as Array<{ productId?: unknown; qty?: unknown }>) {
    if (typeof l?.productId !== "string") continue; // an unlisted line has no product to judge
    out.set(l.productId, (out.get(l.productId) ?? 0) + (Number(l.qty) || 0));
  }
  return out;
}

/**
 * Derive each line's author channel from the order's creation `source` and its edit revisions, OLDEST FIRST.
 *  - The first edit cannot say which lines it added (its snapshot is the state AFTER it and nothing recorded the
 *    state before), so every line in it takes the stricter of the creation channel and the editor's.
 *  - Later edits are diffed against the previous snapshot: a NEW product takes the editor's channel; a RAISED
 *    quantity takes the stricter of its current author and the editor; anything else is untouched.
 *  - A product missing from the last snapshot, a revision with no editor role and a malformed snapshot are all
 *    unknown, so the buyer channel.
 */
export function resolveLineAuthors(
  order: { source?: string | null },
  revisions: readonly AuthorRevision[],
): LineAuthors {
  const creation = channelOfOrderSource(order.source);
  if (revisions.length === 0) return { channelOf: () => creation };

  let state: Map<string, { qty: number; channel: RestrictionChannel }> | null = null;
  for (const r of revisions) {
    const qtys = snapshotQuantities(r.snapshot);
    if (!qtys) return { channelOf: () => "BUYER_PORTAL" }; // history we cannot read: unknown
    const editor = channelOfRole(r.editedByRole);
    const next = new Map<string, { qty: number; channel: RestrictionChannel }>();
    for (const [productId, qty] of qtys) {
      const prev = state?.get(productId);
      const channel = !state
        ? stricterChannel(creation, editor)
        : !prev
          ? editor
          : qty > prev.qty
            ? stricterChannel(prev.channel, editor)
            : prev.channel;
      next.set(productId, { qty, channel });
    }
    state = next;
  }
  const last = state as Map<string, { qty: number; channel: RestrictionChannel }>;
  return { channelOf: (productId) => last.get(productId)?.channel ?? "BUYER_PORTAL" };
}

/**
 * The product ids to judge, grouped by the channel each is judged on: the stricter of its author's channel and
 * the promoter's. BUYER_PORTAL first (the always-applying side refuses before the optional one). One group when
 * every line lands on the same channel, so the common staff-on-staff promotion is still ONE choke-point call.
 */
export function channelsToJudge(
  productIds: readonly string[],
  authors: LineAuthors,
  promoter: RestrictionChannel,
): Array<{ channel: RestrictionChannel; productIds: string[] }> {
  const byChannel: Record<RestrictionChannel, string[]> = { BUYER_PORTAL: [], STAFF: [] };
  for (const id of productIds) byChannel[stricterChannel(authors.channelOf(id), promoter)].push(id);
  return (["BUYER_PORTAL", "STAFF"] as const)
    .filter((channel) => byChannel[channel].length > 0)
    .map((channel) => ({ channel, productIds: byChannel[channel] }));
}

/**
 * The principal an at-door change request is judged as: the resolver itself when BOTH the resolver and the
 * requester are positively staff (a driver's own add keeps staff judgement), else the buyer principal. Same rule as
 * `leastPrivilegedAuthor` in order-templates: an unknown requester is the buyer.
 */
export function leastPrivilegedPrincipal<P extends ChannelPrincipal>(
  resolver: P,
  requesterRole: string | null | undefined,
): P | { type: "BUYER" } {
  return restrictionChannelForPrincipal(resolver) === "STAFF" &&
    channelOfRole(requesterRole) === "STAFF"
    ? resolver
    : { type: "BUYER" };
}

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
 * SA ruling (#3418): a line records its author EXPLICITLY, `OrderItem.authorChannel` ('STAFF' | 'BUYER'). Every
 * line write of the new code sets it from the ACTING principal (`lineAuthorFor`); an edit keeps a line's prior
 * marker unless a buyer raises it (`editedLineAuthors` / `raisedBy`); a merge carries the folded line's own author
 * (`resolvedLineAuthor`). It is NEVER derived from a timestamp: Prisma stamps nested rows separately, so a line's
 * createdAt says nothing about who wrote it. A NULL marker (a line written before the column) falls back to what
 * the order records:
 *  - `Order.source` (APP / PHONE / ROUTE): written by every create site from the creating principal
 *    (`orderSourceForRole`) together with `Order.sourceRecorded: true`. APP = buyer, PHONE = office staff, ROUTE =
 *    driver. A row with `sourceRecorded: false` (every row that predates the column, or one a rolled-back build
 *    writes) carries the column default APP, which says nothing about who made it: such an order is UNKNOWN_LEGACY
 *    and its creation channel is STAFF (see `creationChannelOf`). No clock is involved.
 *  - `OrderRevision` rows (editor role + the line snapshot AFTER each edit). Diffing consecutive snapshots says who
 *    added a line and who raised its quantity; a merge/sweep writes a revision with no editor, which reads as unknown.
 *    A revision the new code writes carries `sourceRecorded: true` and each line's `authorChannel` in its snapshot
 *    (`revisionSnapshot`): RECORDED. A snapshot line's marker beats the diff; a missing field falls through to it.
 * Anything unknown is the BUYER channel. A staff edit never moves a buyer line to the staff channel.
 *
 * Pure: no I/O, no Prisma, no Nest. The callers read the order, its lines and its revisions.
 */

/** The values `OrderItem.authorChannel` holds (a nullable TEXT column; NULL = written before the marker). */
export const ORDER_ITEM_AUTHOR_CHANNELS = ["STAFF", "BUYER"] as const;
export type OrderItemAuthorChannel = (typeof ORDER_ITEM_AUTHOR_CHANNELS)[number];

/** The marker for a restriction channel: STAFF stays STAFF, the portal (and anything else) is BUYER. */
export function authorMarkerOf(channel: RestrictionChannel): OrderItemAuthorChannel {
  return channel === "STAFF" ? "STAFF" : "BUYER";
}

/**
 * THE helper every line write uses: the acting principal's marker. Positively-staff principals are STAFF; the buyer
 * principal, a customer, an unknown role and NO principal are BUYER (unknown author = buyer). A staff-initiated system
 * path with no principal passes the literal "STAFF" instead.
 */
export function lineAuthorFor(
  principal: ChannelPrincipal | null | undefined,
): OrderItemAuthorChannel {
  return authorMarkerOf(restrictionChannelForPrincipal(principal));
}

/** A marker as given, or the acting principal's (`lineAuthorFor`). */
export type AuthorOrPrincipal = OrderItemAuthorChannel | ChannelPrincipal | null | undefined;
const markerFrom = (a: AuthorOrPrincipal): OrderItemAuthorChannel =>
  typeof a === "string" ? a : lineAuthorFor(a);

/** Who authors the lines of a create(): an explicit `lineAuthor` marker (the change-request rollover), else the principal. */
export const authorOf = (
  options: { lineAuthor?: OrderItemAuthorChannel },
  principal: AuthorOrPrincipal,
): AuthorOrPrincipal => options.lineAuthor ?? principal;

/** Nested-create rows, each stamped with the author's marker (keeps every nested create site on one line). */
export function withAuthor<T extends object>(
  rows: readonly T[],
  author: AuthorOrPrincipal,
): Array<T & { authorChannel: OrderItemAuthorChannel }> {
  const authorChannel = markerFrom(author);
  return rows.map((row) => ({ ...row, authorChannel }));
}

/** A stored marker's channel; null for NULL and for any value that is not exactly a marker (read as unmarked). */
export function channelOfAuthorMarker(marker: unknown): RestrictionChannel | null {
  if (marker === "STAFF") return "STAFF";
  if (marker === "BUYER") return "BUYER_PORTAL";
  return null;
}

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

/** The slice of an `Order` the derivation reads. */
export interface AuthorOrder {
  source?: string | null;
  /** false = UNKNOWN_LEGACY. A caller that did not read the column (undefined) gets the recorded source. */
  sourceRecorded?: boolean | null;
  /** Accepted (callers pass whole rows) and NEVER read: no timestamp rule (SA ruling, #3418). */
  createdAt?: unknown;
}

/** UNKNOWN_LEGACY: the row says its `source` was NOT written from the creating principal. */
const isUnknownLegacy = (order: AuthorOrder): boolean => order.sourceRecorded === false;

/** A revision the new code wrote: `revisionSnapshot` stamps `sourceRecorded: true` on its snapshot. */
const isRecordedRevision = (r: AuthorRevision): boolean =>
  (r.snapshot as { sourceRecorded?: unknown } | null | undefined)?.sourceRecorded === true;

/**
 * The channel an order's creation is judged on: STAFF for an UNKNOWN_LEGACY order (`sourceRecorded` false), else
 * what the recorded `source` says (APP, missing or unknown = the buyer).
 */
export function creationChannelOf(order: AuthorOrder): RestrictionChannel {
  return isUnknownLegacy(order) ? "STAFF" : channelOfOrderSource(order.source);
}

/** A line's author as a marker: its own marker when set, else its order's order-level rule (`creationChannelOf`). */
export function resolvedLineAuthor(
  line: { authorChannel?: unknown },
  order: AuthorOrder,
): OrderItemAuthorChannel {
  return authorMarkerOf(channelOfAuthorMarker(line.authorChannel) ?? creationChannelOf(order));
}

/**
 * Every loser line of a merge, each carrying its RESOLVED author (its own marker, else its own order's order-level
 * rule): the loser order is deleted by the merge, so its rule must be read before the line moves.
 */
export function loserLinesOf<L extends { authorChannel?: string | null }>(
  losers: ReadonlyArray<AuthorOrder & { lineItems: readonly L[] }>,
): Array<L & { authorChannel: OrderItemAuthorChannel }> {
  return losers.flatMap((o) =>
    o.lineItems.map((li) => ({ ...li, authorChannel: resolvedLineAuthor(li, o) })),
  );
}

/** The slice of an `OrderRevision` the derivation reads. */
export interface AuthorRevision {
  editedByRole?: string | null;
  /** `{ sourceRecorded?, lineItems: [{ productId, qty, authorChannel? }] }` after the edit (`revisionSnapshot`). */
  snapshot?: unknown;
}

export interface LineAuthors {
  /** The channel the line for `productId` was authored on. */
  channelOf(productId: string): RestrictionChannel;
}

interface SnapshotProduct {
  qty: number;
  /** The stricter of the markers its lines carry; null when none carries one. */
  marked: RestrictionChannel | null;
  /** Some line carries the field set to null (written before the marker, recorded as such). */
  unmarked: boolean;
  /** Some line carries no `authorChannel` field at all (a snapshot from before the field). */
  unknown: boolean;
}

/** productId -> qty + markers of a revision snapshot; null when the snapshot is not the shape the writer produces. */
function snapshotProducts(snapshot: unknown): Map<string, SnapshotProduct> | null {
  const lines = (snapshot as { lineItems?: unknown } | null | undefined)?.lineItems;
  if (!Array.isArray(lines)) return null;
  const out = new Map<string, SnapshotProduct>();
  for (const l of lines as Array<{ productId?: unknown; qty?: unknown; authorChannel?: unknown }>) {
    if (typeof l?.productId !== "string") continue; // an unlisted line has no product to judge
    const p = out.get(l.productId) ?? { qty: 0, marked: null, unmarked: false, unknown: false };
    p.qty += Number(l.qty) || 0;
    const m = channelOfAuthorMarker(l.authorChannel);
    if (m) p.marked = p.marked ? stricterChannel(p.marked, m) : m;
    else if (l.authorChannel === null) p.unmarked = true;
    else p.unknown = true;
    out.set(l.productId, p);
  }
  return out;
}

/**
 * Each product's author channel, line by line:
 *  1. The live lines' `authorChannel` markers (`lines`): when every line of the product carries one, the stricter of
 *     them IS the answer, whatever the revisions or any timestamp say. A NULL-marker line falls back to step 2 and
 *     joins the marked lines at the stricter.
 *  2. The order-level rule: the creation `source` (`creationChannelOf`) and the edit revisions, OLDEST FIRST.
 *     - A snapshot line's own marker is taken as recorded. An unmarked (`authorChannel: null`) line in a recorded
 *       snapshot of an UNKNOWN_LEGACY order predates the marker, so it is legacy history: STAFF.
 *     - The first edit cannot say which lines it added (its snapshot is the state AFTER it and nothing recorded the
 *       state before), so every other line in it takes the stricter of the creation channel and the editor's.
 *     - Later edits are diffed against the previous snapshot: a NEW product takes the editor's channel; a RAISED
 *       quantity takes the stricter of its current author and the editor; anything else is untouched.
 *     - A product missing from the last snapshot, a revision with no editor role and a malformed snapshot are all
 *       unknown, so the buyer channel.
 *     On an UNKNOWN_LEGACY order (`sourceRecorded` false) an UNRECORDED revision (written before the new code, no
 *     marker in its snapshot) is unknown history: its editor reads STAFF and an unreadable one is skipped. Unknown
 *     is STAFF there unless a RECORDED revision has a non-staff editor (evidence of a buyer path through the new code).
 */
export function resolveLineAuthors(
  order: AuthorOrder,
  revisions: readonly AuthorRevision[],
  lines: ReadonlyArray<{
    productId?: string | null;
    authorChannel?: unknown;
    createdAt?: unknown;
  }> = [],
): LineAuthors {
  const fallback = orderLevelAuthors(order, revisions);
  const live = new Map<string, { marked: RestrictionChannel | null; unmarked: boolean }>();
  for (const l of lines) {
    if (!l.productId) continue;
    const e = live.get(l.productId) ?? { marked: null, unmarked: false };
    const m = channelOfAuthorMarker(l.authorChannel);
    if (m) e.marked = e.marked ? stricterChannel(e.marked, m) : m;
    else e.unmarked = true;
    live.set(l.productId, e);
  }
  return {
    channelOf: (productId) => {
      const e = live.get(productId);
      if (e?.marked && !e.unmarked) return e.marked;
      const fb = fallback(productId);
      return e?.marked ? stricterChannel(e.marked, fb) : fb;
    },
  };
}

/** Step 2 of `resolveLineAuthors`: the order-level rule (creation source + revision diff, snapshot markers first). */
function orderLevelAuthors(
  order: AuthorOrder,
  revisions: readonly AuthorRevision[],
): (productId: string) => RestrictionChannel {
  const creation = creationChannelOf(order);
  const legacy = isUnknownLegacy(order);
  if (revisions.length === 0) return () => creation;

  // On a legacy order an unrecorded revision is unknown history whose editor says nothing.
  const history = (r: AuthorRevision) => legacy && !isRecordedRevision(r);
  // What "unknown" reads as. A legacy order's lines are STAFF unless a RECORDED buyer path touched the order, so with
  // no such revision there is no evidence of a buyer and unknown is STAFF; everywhere else unknown is the buyer.
  const recordedBuyer = revisions.some(
    (r) => !history(r) && channelOfRole(r.editedByRole) !== "STAFF",
  );
  const unknown: RestrictionChannel = legacy && !recordedBuyer ? "STAFF" : "BUYER_PORTAL";

  let state: Map<string, { qty: number; channel: RestrictionChannel }> | null = null;
  for (const r of revisions) {
    const products = snapshotProducts(r.snapshot);
    if (!products) {
      if (history(r)) continue; // unreadable unrecorded history says nothing
      return () => unknown; // history we cannot read: unknown
    }
    const editor = history(r) ? "STAFF" : channelOfRole(r.editedByRole);
    // An unmarked line in a RECORDED snapshot of a legacy order was written before the marker: legacy history.
    const preMarker = legacy && isRecordedRevision(r);
    const next = new Map<string, { qty: number; channel: RestrictionChannel }>();
    for (const [productId, p] of products) {
      const prev = state?.get(productId);
      const derived = !state
        ? stricterChannel(creation, editor)
        : !prev
          ? editor
          : p.qty > prev.qty
            ? stricterChannel(prev.channel, editor)
            : prev.channel;
      // The stricter over what its lines say: a marker as recorded, an unmarked line per `preMarker`, a line from
      // before the field by the diff.
      const parts: RestrictionChannel[] = [];
      if (p.marked) parts.push(p.marked);
      if (p.unmarked) parts.push(preMarker ? "STAFF" : derived);
      if (p.unknown) parts.push(derived);
      const channel = parts.reduce(stricterChannel);
      next.set(productId, { qty: p.qty, channel });
    }
    state = next;
  }
  const last = state as Map<string, { qty: number; channel: RestrictionChannel }> | null;
  return (productId) => last?.get(productId)?.channel ?? unknown;
}

/** One line of the order before an edit, as `editedLineAuthors` reads it. */
interface PriorLine {
  productId?: string | null;
  qty?: unknown;
  authorChannel?: unknown;
}

/**
 * The marker each line of an EDIT writes (replace-all re-creates every line, so the marker must be carried, never
 * re-stamped from the editor): a product NEW to the order takes the editor's marker; a product the order already had
 * keeps its prior marker (the stricter over its prior lines: BUYER, then NULL, then STAFF), unless a BUYER editor
 * RAISED its total quantity, which makes it BUYER. A staff edit never launders a buyer line; a NULL prior stays NULL
 * (the order-level rule keeps reading it). An unlisted line (no product) takes the editor's marker.
 */
export function editedLineAuthors(
  prior: readonly PriorLine[],
  next: ReadonlyArray<{ productId?: string | null; qty?: unknown }>,
  by: AuthorOrPrincipal,
): LineAuthorLookup {
  const editor = markerFrom(by);
  const before = new Map<string, { qty: number; marker: OrderItemAuthorChannel | null }>();
  for (const l of prior) {
    if (!l.productId) continue;
    const m = channelOfAuthorMarker(l.authorChannel);
    const marker: OrderItemAuthorChannel | null = m ? authorMarkerOf(m) : null;
    const e = before.get(l.productId);
    if (!e) {
      before.set(l.productId, { qty: Number(l.qty) || 0, marker });
      continue;
    }
    e.qty += Number(l.qty) || 0;
    e.marker =
      e.marker === "BUYER" || marker === "BUYER"
        ? "BUYER"
        : e.marker === null || marker === null
          ? null
          : "STAFF";
  }
  const after = new Map<string, number>();
  for (const l of next)
    if (l.productId) after.set(l.productId, (after.get(l.productId) ?? 0) + (Number(l.qty) || 0));
  const lookup = (productId: string | null | undefined) => {
    if (!productId) return editor;
    const e = before.get(productId);
    if (!e) return editor;
    return editor === "BUYER" && (after.get(productId) ?? 0) > e.qty ? "BUYER" : e.marker;
  };
  return Object.assign(lookup, { editor });
}

/** `editedLineAuthors`' answer: the marker per product, and the editor's own marker (a fresh line's). */
export type LineAuthorLookup = ((
  productId: string | null | undefined,
) => OrderItemAuthorChannel | null) & {
  editor: OrderItemAuthorChannel;
};

/** An in-place quantity write: a BUYER raise stamps the line BUYER; anything else leaves the marker untouched. */
export function raisedBy(
  editor: OrderItemAuthorChannel,
  before: unknown,
  after: unknown,
): { authorChannel?: "BUYER" } {
  return editor === "BUYER" && (Number(after) || 0) > (Number(before) || 0)
    ? { authorChannel: "BUYER" }
    : {};
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

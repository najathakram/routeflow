import { Logger } from "@nestjs/common";
import { AmbiguousLineError, buildLine } from "@routeflow/pricing";

/**
 * SA-982 PR-2, the WARN phase of the buildLine rollout (D-27 / B682). A hand-built pack-axis NEW-write builder (the class
 * pinned in no-bare-line-math.spec.ts) calls this with its RAW client input BEFORE its own `normalizeBoxesPieces`. It
 * dry-runs `buildLine` and, on an `AmbiguousLineError`, logs ONE line:
 *
 *   line-ambiguity site=<id> reason=<code> tenant=<tenantId> role=<role>
 *
 * It NEVER changes the write, never throws and logs no names or amounts. The prod census of what a later flip would
 * refuse IS this log (stored rows cannot show the raw shape: every writer normalizes before storing); a domain converts
 * to `buildLine` only after 7 clean days at its site. There is no second classifier: `buildLine` itself decides.
 */

/**
 * The class sites: a closed list, so the compiler (not free text) finds every caller. The orders ids ARE the `warnSplit`
 * path strings (SA-982a), so one name per site reads the same in both logs. A conversion removes its entry (and its
 * `warnSplit` call) in the same diff; delete the union when it is empty.
 */
export const LINE_GUARD_SITES = [
  "invoices.manual",
  "orders.create.lines",
  "counter.sale",
  "orders.replace-all",
  "orders.update.substitute",
  "orders.cr.add",
] as const;
export type LineGuardSite = (typeof LINE_GUARD_SITES)[number];

const log = new Logger("LineAmbiguity");

/** The raw fields of a pack-axis line as the client sent them (any may be absent or junk: this never throws). */
export interface RawPackLine {
  boxes?: unknown;
  pieces?: unknown;
  qty?: unknown;
  unitsPerBox?: unknown;
  unitPrice?: unknown;
}

export function warnLineAmbiguity(
  site: LineGuardSite,
  raw: RawPackLine,
  ctx: { tenantId?: string | null; role?: string | null },
): void {
  try {
    buildLine({
      axis: {
        kind: "pack",
        boxes: raw.boxes as number | null | undefined,
        pieces: raw.pieces as number | null | undefined,
        qty: raw.qty as number | null | undefined,
        unitsPerBox: raw.unitsPerBox as number | null | undefined,
      },
      unitPrice: Number(raw.unitPrice ?? 0),
    });
  } catch (err) {
    if (!(err instanceof AmbiguousLineError)) return; // a non-ambiguity failure is not this census's business
    try {
      log.warn(
        `line-ambiguity site=${site} reason=${err.reason} tenant=${ctx?.tenantId || "unknown"} role=${ctx?.role || "unknown"}`,
      );
    } catch {
      // logging must never fail a write
    }
  }
}

/** The census context of a request: the tenant and the actor's role, read once at a site (`prisma.getTenantId()`, `user.role`). */
export function lineGuardCtx(
  prisma: { getTenantId(): string | null | undefined },
  user?: { role?: string | null } | null,
): { tenantId: string | null | undefined; role: string | null | undefined } {
  return { tenantId: prisma.getTenantId(), role: user?.role };
}

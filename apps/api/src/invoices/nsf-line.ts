import { InvoiceItemSystemKind, type Prisma } from "@prisma/client";
import { NSF_FEE_DESCRIPTION_PREFIX, isNsfLineFacts } from "@routeflow/pricing";

/**
 * #2169 (SA-395) — the ONE shared predicate for "is this InvoiceItem the system NSF bounce-fee
 * line". Both consumers (commission-engine.service.ts, regulated/uncategorised-lines.ts) import
 * this module so the rule can never drift between them. `InvoicesService.setCheckStatus`'s
 * BOUNCED branch is the ONLY writer of `systemKind`, stamping every new NSF fee line going
 * forward; every pre-existing NSF line still carries only the description prefix until
 * `apps/api/scripts/backfill-2169-nsf-system-kind.mjs` runs (deploy does not wait for it).
 *
 * TRANSITION dual-read: NSF ⇔ systemKind === "NSF_FEE", OR (systemKind IS NULL AND description
 * startsWith NSF_FEE_DESCRIPTION_PREFIX). The prefix leg is removed in a LATER PR only after the
 * owner's backfill report shows 0 prefix-matched NULL rows remaining — this file's own
 * `HAS_TRANSITION_LEG` pin flips red the moment that leg is deleted, by design (nsf-line.spec.ts).
 *
 * The `systemKind` enum has exactly one member today (`NSF_FEE`), so a "stamped with some OTHER
 * kind" branch cannot occur in practice — `isNsfLine` still checks equality (not mere presence)
 * first, so a future second enum value can never silently short-circuit into "is NSF".
 *
 * L-072: this value is the real generated `@prisma/client` enum member (`InvoiceItemSystemKind
 * .NSF_FEE`), never a hand-typed string literal — the API already value-imports Prisma enums
 * elsewhere (see invoices/credit-exposure.ts's `InvoiceStatus`).
 */
export { InvoiceItemSystemKind };

/** Flips to false the day the prefix leg below is deleted post-backfill — see nsf-line.spec.ts. */
export const HAS_TRANSITION_LEG = true;

export interface NsfLineFacts {
  systemKind?: InvoiceItemSystemKind | null;
  description?: string | null;
}

/**
 * In-memory branch, parameterized on the transition flag so nsf-line.spec.ts can pin BOTH states
 * directly (no dead `if (!HAS_TRANSITION_LEG)` branch that never runs while the constant is
 * `true`). `isNsfLine` below is the real predicate every consumer calls, always with the live
 * flag.
 */
export function isNsfLineWithLeg(line: NsfLineFacts, hasTransitionLeg: boolean): boolean {
  // #2392 / SA-478 (A): THE rule lives in @routeflow/pricing (isNsfLineFacts), shared with web and
  // mobile; this module keeps HAS_TRANSITION_LEG and the Prisma where-builders below.
  return isNsfLineFacts(line, hasTransitionLeg);
}

/** In-memory branch: for a line already fetched (e.g. the commission engine's `invoice.items`). */
export function isNsfLine(line: NsfLineFacts): boolean {
  return isNsfLineWithLeg(line, HAS_TRANSITION_LEG);
}

/** `NOT stamped-NSF` — the leg both transition states share. */
const NOT_STAMPED: Prisma.InvoiceItemWhereInput = {
  OR: [{ systemKind: null }, { systemKind: { not: InvoiceItemSystemKind.NSF_FEE } }],
};

/**
 * Prisma `where` fragment matching an InvoiceItem that is NOT the NSF fee line, mirroring
 * `isNsfLine`'s own `HAS_TRANSITION_LEG` gate so BOTH consumers (the in-memory predicate here and
 * the Prisma-level one used by regulated/uncategorised-lines.ts) drop the prefix leg together the
 * day it is deleted — see the `HAS_TRANSITION_LEG` pin in nsf-line.spec.ts.
 *
 * While the transition leg is live this is deliberately NOT `NOT: { OR: [stamped, nullPrefix] }`
 * — Prisma's `NOT` is a plain boolean negation of a filter over three-valued SQL comparisons, so
 * `NOT { systemKind: "NSF_FEE" }` ALSO excludes every NULL `systemKind` row (NULL rows never
 * match `systemKind: "NSF_FEE"`, so negating it would still exclude them), which would wrongly
 * drop every un-backfilled NULL+prefix NSF line out of "not NSF" as well as into it. Built
 * instead as the literal negation of `isNsfLine`'s two branches: not stamped-NSF, AND not (NULL
 * and prefix-matched). Once the leg is gone, "not NSF" is simply "not stamped".
 */
export function buildNotNsfLineWhere(hasTransitionLeg: boolean): Prisma.InvoiceItemWhereInput {
  if (!hasTransitionLeg) return NOT_STAMPED;
  return {
    AND: [
      NOT_STAMPED,
      {
        NOT: {
          AND: [{ systemKind: null }, { description: { startsWith: NSF_FEE_DESCRIPTION_PREFIX } }],
        },
      },
    ],
  };
}

export const notNsfLineWhere: Prisma.InvoiceItemWhereInput =
  buildNotNsfLineWhere(HAS_TRANSITION_LEG);

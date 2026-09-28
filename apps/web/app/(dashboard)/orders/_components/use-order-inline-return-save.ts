import * as React from "react";
import {
  buildCaptureRequest,
  extractRefusalMessage,
  keyReusedReturnOf,
  mintReturnKey,
} from "@routeflow/returns";
import type { InlineReturnLinesRequest } from "@routeflow/types";
import type { OrderInlineReturnsSectionHandle } from "./OrderInlineReturnsSection";
import { parseRegulatedAuthError } from "@/lib/api/authorizations";
import { parseSellingRestricted } from "@/lib/api/selling-restricted";
import { parseCreditLimitError } from "@/lib/api/credit-limit";

/** A refusal the page's guardError dialogs own (restricted / license / credit): they re-submit the
 *  SAME attempt, so an inline return keeps its returnKey through them (SA-484 item 3). */
export function isGuardHandledRefusal(err: unknown): boolean {
  return (
    !!parseSellingRestricted(err) ||
    (parseRegulatedAuthError(err)?.length ?? 0) > 0 ||
    !!parseCreditLimitError(err)
  );
}

// ─── Shared save-time wiring for the Returns section (#2406) ───────────────────────────────
//
// Both hosts (CreateOrderModal, the order-edit page) mount OrderInlineReturnsSection and need
// the SAME returnKey/refusal lifecycle at save time (SA-484 item 3): one returnKey per save
// ATTEMPT, reused across a retry of the same attempt, minted fresh only after an unhandled
// server refusal. Extracted here so neither host duplicates it (and so orders/[id]/page.tsx,
// pinned by common/size-ratchet.spec.ts, doesn't have to inline it).
export interface OrderInlineReturnSave {
  refusalMessage: string;
  /** #2647: the return the server says was ALREADY recorded under this capture key (a key-reused
   *  409): the Returns section offers "Open RET-…", and the draft was cleared. Null otherwise. */
  refusalReturn: { returnId: string; returnNumber: string | null } | null;
  /** Reads the Returns section's current draft. `undefined` = no return on this save;
   *  `"missing-reason"` = lines were entered but no reason picked yet — the caller should
   *  block the save and toast, same as the standalone dialog's own guard. */
  build(
    customerId: string,
    orderId: string,
  ): InlineReturnLinesRequest | "missing-reason" | "needs-quote" | undefined;
  /** SA-484a: the create's `Idempotency-Key`, minted TOGETHER with the returnKey in `build` and
   *  cleared with it — so a retry of the same attempt resends both, a new attempt mints both. */
  idempotencyKey(): string;
  /** Call from the mutation's onSuccess once the save actually went through. */
  onSuccess(): void;
  /** Call from the mutation's onError. `alreadyHandled` = some OTHER flow (guardError's
   *  restricted/license/credit dialogs, the merge-choice prompt) already owns this refusal and
   *  will re-submit the SAME attempt — that must keep the returnKey, so this only mints a
   *  fresh one and surfaces a message for an otherwise-unhandled 4xx. */
  onError(err: unknown, alreadyHandled: boolean): void;
  /** The order-edit page's save sites: `build` plus the missing-reason toast. `null` = blocked
   *  (the caller just returns), `undefined` = no return on this save. */
  prepare(customerId: string, orderId: string): InlineReturnLinesRequest | null | undefined;
  /** Wraps a save's onError: a guardError-owned refusal keeps the returnKey, any other 4xx mints
   *  a fresh one; then `next` runs as before. */
  chainError(sent: unknown, next: (err: unknown) => void): (err: unknown) => void;
}

/** The toast a blocked return save shows (both hosts). */
export const RETURN_SAVE_BLOCKED = {
  "missing-reason": "Choose a reason for the return before saving",
  "needs-quote": "Get a quote for the return before saving",
} as const;

export function useOrderInlineReturnSave(
  returnsRef: React.RefObject<OrderInlineReturnsSectionHandle | null>,
  onBlocked?: (why: "missing-reason" | "needs-quote") => void,
): OrderInlineReturnSave {
  const keyRef = React.useRef("");
  const idemRef = React.useRef("");
  const genRef = React.useRef(0);
  const [refusalMessage, setRefusalMessage] = React.useState("");
  const [refusalReturn, setRefusalReturn] =
    React.useState<OrderInlineReturnSave["refusalReturn"]>(null);

  const api: OrderInlineReturnSave = {
    refusalMessage,
    refusalReturn,
    prepare(customerId, orderId) {
      const built = api.build(customerId, orderId);
      if (built !== "missing-reason" && built !== "needs-quote") return built;
      onBlocked?.(built);
      return null;
    },
    chainError(sent, next) {
      return (err) => {
        if (sent) api.onError(err, isGuardHandledRefusal(err));
        next(err);
      };
    },
    build(customerId, orderId) {
      // SA-484i: a discarded draft's key pair never carries into the next one.
      const gen = returnsRef.current?.generation() ?? 0;
      if (gen !== genRef.current) {
        genRef.current = gen;
        keyRef.current = "";
        idemRef.current = "";
      }
      const draft = returnsRef.current?.getDraft() ?? null;
      if (!draft) return undefined;
      if (!draft.captureReason) return "missing-reason";
      if (!draft.quoted) return "needs-quote";
      if (!keyRef.current) {
        keyRef.current = mintReturnKey();
        idemRef.current = mintReturnKey();
      }
      const full = buildCaptureRequest({
        customerId,
        orderId,
        lines: draft.lines,
        returnKey: keyRef.current,
        reason: draft.captureReason,
      });
      const { customerId: _c, orderId: _o, ...rest } = full;
      return rest;
    },
    idempotencyKey() {
      return idemRef.current;
    },
    onSuccess() {
      keyRef.current = "";
      idemRef.current = "";
      setRefusalMessage("");
      returnsRef.current?.reset();
    },
    onError(err, alreadyHandled) {
      if (alreadyHandled) return;
      const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
      if (status != null && status >= 400 && status < 500) {
        keyRef.current = "";
        idemRef.current = "";
        setRefusalMessage(extractRefusalMessage(err));
        // #2647: the earlier capture WAS recorded: point at it, and clear the draft so the same
        // goods are not re-entered as a "new" return (and credited twice).
        const recorded = keyReusedReturnOf(err);
        setRefusalReturn(recorded);
        if (recorded) returnsRef.current?.reset();
      }
    },
  };
  return api;
}

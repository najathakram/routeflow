import * as React from "react";
import { buildCaptureRequest, extractRefusalMessage, mintReturnKey } from "@routeflow/returns";
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
  /** Reads the Returns section's current draft. `undefined` = no return on this save;
   *  `"missing-reason"` = lines were entered but no reason picked yet — the caller should
   *  block the save and toast, same as the standalone dialog's own guard. */
  build(
    customerId: string,
    orderId: string,
  ): InlineReturnLinesRequest | "missing-reason" | undefined;
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

export function useOrderInlineReturnSave(
  returnsRef: React.RefObject<OrderInlineReturnsSectionHandle | null>,
  onMissingReason?: () => void,
): OrderInlineReturnSave {
  const keyRef = React.useRef("");
  const [refusalMessage, setRefusalMessage] = React.useState("");

  const api: OrderInlineReturnSave = {
    refusalMessage,
    prepare(customerId, orderId) {
      const built = api.build(customerId, orderId);
      if (built !== "missing-reason") return built;
      onMissingReason?.();
      return null;
    },
    chainError(sent, next) {
      return (err) => {
        if (sent) api.onError(err, isGuardHandledRefusal(err));
        next(err);
      };
    },
    build(customerId, orderId) {
      const draft = returnsRef.current?.getDraft() ?? null;
      if (!draft) return undefined;
      if (!draft.captureReason) return "missing-reason";
      if (!keyRef.current) keyRef.current = mintReturnKey();
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
    onSuccess() {
      keyRef.current = "";
      setRefusalMessage("");
      returnsRef.current?.reset();
    },
    onError(err, alreadyHandled) {
      if (alreadyHandled) return;
      const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
      if (status != null && status >= 400 && status < 500) {
        keyRef.current = "";
        setRefusalMessage(extractRefusalMessage(err));
      }
    },
  };
  return api;
}

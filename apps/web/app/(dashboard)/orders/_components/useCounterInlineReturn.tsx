"use client";

// ─── W-863 (SA-945 PR-1): the counter sale's inline return ─────────────────────────────────────
//
// The counter reuses Create Order's own Returns section and its returnKey lifecycle (`useOrderInlineReturnSave`): no second
// return writer, no second quote path. This file is only the counter glue: the quoted credit nets against the sale for what
// the till shows and asks for (the server nets again, authoritatively, in its own transaction).
import * as React from "react";
import { roundMoney } from "@routeflow/pricing";
import type { InlineReturnLinesRequest } from "@routeflow/types";
import { useHasAddon } from "@/lib/api/tobacco";
import { ORDERS_INLINE_RETURNS_ADDON } from "@/lib/api/addons";
import {
  OrderInlineReturnsSection,
  type OrderInlineReturnsSectionHandle,
} from "./OrderInlineReturnsSection";
import { RETURN_SAVE_BLOCKED, useOrderInlineReturnSave } from "./use-order-inline-return-save";

/** What the customer pays and what they keep: a return worth more than the sale leaves store credit, never a negative due. */
export function netOfReturn(
  saleTotal: number,
  credit: number,
): { payTotal: number; storeCredit: number } {
  const sale = roundMoney(saleTotal);
  const back = roundMoney(Math.max(0, credit));
  return {
    payTotal: roundMoney(Math.max(0, sale - back)),
    storeCredit: roundMoney(Math.max(0, back - sale)),
  };
}

export function useCounterInlineReturn(
  saleTotal: number,
  named: boolean,
  onBlocked: (message: string) => void,
) {
  const ref = React.useRef<OrderInlineReturnsSectionHandle>(null);
  const save = useOrderInlineReturnSave(ref, (why) => onBlocked(RETURN_SAVE_BLOCKED[why]));
  const [credit, setCredit] = React.useState(0);
  const net = netOfReturn(saleTotal, named ? credit : 0);
  return {
    ref,
    setCredit,
    ...net,
    refusalMessage: save.refusalMessage,
    refusalReturn: save.refusalReturn,
    /** The return to send with this attempt: `undefined` = none, `null` = blocked (the reason was handed to `onBlocked`). */
    prepare(customerId: string): InlineReturnLinesRequest | null | undefined {
      return named ? save.prepare(customerId, "") : undefined;
    },
    /** A 2xx: the return is on the sale, so the draft and its keys go. */
    settled() {
      save.onSuccess();
      setCredit(0);
    },
    /** A refusal that proves nothing was written: a fresh returnKey for the next attempt, and the server's reason. */
    refused(err: unknown) {
      save.onError(err, false);
    },
    /** A new sale or a different buyer: the draft never carries over. */
    discard() {
      ref.current?.reset();
      setCredit(0);
    },
  };
}

export function CounterReturnsMount({
  customerId,
  walkIn,
  ret,
}: {
  customerId: string | null;
  walkIn: boolean;
  ret: Pick<
    ReturnType<typeof useCounterInlineReturn>,
    "ref" | "setCredit" | "refusalMessage" | "refusalReturn"
  >;
}) {
  const hasReturns = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);
  if (walkIn) {
    return hasReturns ? (
      <p className="text-sm text-navy/70" data-testid="counter-return-walkin-note">
        A walk-in return is refunded, not credited. Choose a customer to take a return with this
        sale.
      </p>
    ) : null;
  }
  if (!customerId) return null;
  return (
    <OrderInlineReturnsSection
      key={customerId}
      ref={ret.ref}
      customerId={customerId}
      refusalMessage={ret.refusalMessage}
      refusalReturn={ret.refusalReturn}
      onQuoteTotalChange={ret.setCredit}
    />
  );
}

"use client";

import * as React from "react";
import { Button, Modal } from "@routeflow/ui/web";
import type { BlockedLine } from "@routeflow/types";
import { restrictionReasonText } from "@/lib/api/selling-restricted";

/**
 * Why an order can't go through: the lines the selling-restrictions check blocked, each with a
 * plain-language cause. Shown instead of a raw error toast (the code is in providers.tsx's
 * HANDLED_CODES), so a blocked save produces exactly this one message.
 */
export function BlockedLinesDialog({
  lines,
  onClose,
}: {
  lines: BlockedLine[] | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={!!lines}
      onClose={onClose}
      title="Some items can't be sold to this customer"
      description="Remove them from the order to continue."
      footer={<Button onClick={onClose}>OK</Button>}
    >
      <ul className="space-y-3" aria-label="Blocked items">
        {(lines ?? []).map((l) => (
          <li
            key={`${l.productId}-${l.ruleId ?? l.reason}`}
            className="rounded-lg border border-surface-border p-3"
          >
            <p className="font-medium text-navy">{l.productName}</p>
            {l.categoryName && <p className="text-xs text-navy/60">{l.categoryName}</p>}
            <p className="mt-1 text-sm text-danger">{restrictionReasonText(l)}</p>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

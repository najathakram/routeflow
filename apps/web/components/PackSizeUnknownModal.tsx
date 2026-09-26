"use client";

import { Button, Modal } from "@routeflow/ui/web";
import { fmt } from "@/lib/formatting";
import type { PackSizeUnknownError } from "@/lib/api/vendor-bills";

/**
 * B743 (PR B): the API's PACK_SIZE_UNKNOWN refusal, made a real choice for the operator.
 *
 * A bill line for a product sold by the case, with no units-per-case on the line, used to post
 * silently as loose pieces at the case price: stock under-counted and the average cost overstated
 * by the pack factor. The API now names those lines (dark first). This dialog lists them and
 * offers two explicit ways forward, never an automatic one:
 *   - fix the case size on the bill's lines (the page's own line editor), or
 *   - receive as loose pieces, with the consequence spelled out, since a silent loose-pieces
 *     choice IS the B743 bug.
 */
export const LOOSE_PIECES_CONSEQUENCE = "Stock counts each as 1 piece; cost is per piece.";

export function PackSizeUnknownModal({
  payload,
  onClose,
  onFixCaseSizes,
  onReceiveLoose,
  isPending,
}: {
  payload: PackSizeUnknownError | null;
  onClose: () => void;
  /** Null when the bill can no longer be edited (e.g. already partly received). */
  onFixCaseSizes: (() => void) | null;
  onReceiveLoose: () => void;
  isPending: boolean;
}) {
  const lines = payload?.packSizeUnknownItems ?? [];
  return (
    <Modal
      open={!!payload}
      onClose={onClose}
      title="Units per case missing"
      description={payload?.message ?? ""}
      footer={
        <>
          {onFixCaseSizes ? (
            <Button variant="secondary" onClick={onFixCaseSizes} disabled={isPending}>
              Fix case sizes
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
          )}
          <Button onClick={onReceiveLoose} loading={isPending}>
            Receive as loose pieces
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ul
          aria-label="Lines missing units per case"
          className="max-h-56 space-y-2 overflow-y-auto rounded-md bg-amber-50 p-3 text-sm text-navy"
        >
          {lines.map((l) => (
            <li key={`${l.id ?? "new"}-${l.lineIndex}`} className="space-y-0.5">
              <div className="flex justify-between gap-3">
                <span className="min-w-0 truncate">{l.description || l.productName}</span>
                <span className="shrink-0 tabular-nums text-navy/70">
                  {l.qty} × {fmt(l.unitCost)}
                </span>
              </div>
              {l.productPack > 1 && (
                <p className="text-xs text-navy/70">
                  {l.productName} is usually a case of {l.productPack}.
                </p>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm font-medium text-navy" data-testid="loose-pieces-consequence">
          Receiving as loose pieces: {LOOSE_PIECES_CONSEQUENCE}
        </p>
      </div>
    </Modal>
  );
}

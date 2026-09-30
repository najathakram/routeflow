"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button, Modal } from "@routeflow/ui/web";
import {
  reactivationResolveLabel,
  type ReactivationRefusal,
} from "@/lib/product-reactivation-refusal";

/**
 * WS7: why a product could not be reactivated, and the way forward. Every line is mapped from the
 * 409's code + field (never the server message). The one-call "Deactivate <holder> and reactivate
 * this" is offered only when no holder is blocked (a family / one with active variants).
 */
export function ReactivateConflictDialog({
  refusal,
  loading = false,
  onClose,
  onResolve,
  onRetry,
}: {
  /** null = closed. */
  refusal: ReactivationRefusal | null;
  loading?: boolean;
  onClose: () => void;
  /** Resend the reactivation with `deactivateHolderIds` = these ids. */
  onResolve: (holderIds: string[]) => void;
  /** Retry kind (the stale-holder-set code): nothing blocks any more (or the set moved) — just try again. */
  onRetry: () => void;
}) {
  if (!refusal) return null;

  if (refusal.kind === "RETRY") {
    return (
      <Modal
        open
        onClose={onClose}
        title="Can't reactivate yet"
        className="max-w-md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={loading}>
              Close
            </Button>
            <Button onClick={onRetry} loading={loading}>
              Try again
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          The products using this code or name just changed. Try reactivating again.
        </p>
      </Modal>
    );
  }

  const unique = refusal.holders.filter(
    (h, i) => h.productId && refusal.holders.findIndex((x) => x.productId === h.productId) === i,
  );
  return (
    <Modal
      open
      onClose={onClose}
      title="Can't reactivate this product"
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Close
          </Button>
          {refusal.canResolve && (
            <Button
              variant="danger"
              onClick={() => onResolve(refusal.holderIds)}
              loading={loading}
              data-testid="reactivate-resolve"
            >
              {reactivationResolveLabel(unique.map((h) => h.productName))}
            </Button>
          )}
        </>
      }
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div className="space-y-2">
          <ul className="space-y-2 text-sm text-navy/70">
            {refusal.holders.map((h, i) => (
              <li key={`${h.productId}-${i}`}>{h.line}</li>
            ))}
          </ul>
          <ul className="text-sm">
            {unique.map((h) => (
              <li key={h.productId}>
                <Link
                  href={`/products/${h.productId}`}
                  className="text-brand-600 underline underline-offset-2"
                >
                  {h.productName}
                </Link>
                {h.blocked && (
                  <span className="ml-2 text-xs text-navy/60">
                    has active variants — change it there
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

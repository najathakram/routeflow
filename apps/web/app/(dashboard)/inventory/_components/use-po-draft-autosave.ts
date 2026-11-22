"use client";

import * as React from "react";
import { withDraftSubmitKey } from "@routeflow/types/draft-submit-key";
import {
  createOrderDraftEngine,
  type DraftPayload,
  type DraftRowMeta,
  type DraftRowResult,
  type OrderDraftEngine,
} from "@/lib/order-draft/engine";
import { attachMirrorFlush, createDraftMirror } from "@/lib/order-draft/mirror";
import { getDraftMirrorStorage } from "@/lib/order-draft/storage";
import { draftDeviceLabel } from "@/lib/drafts";
import { mintSubmitKey } from "../../orders/_components/use-create-order-submit-key";
import { parseDraftChanged } from "../../orders/_components/use-order-draft-autosave";
import type { POLineItem } from "./purchase-orders-shared";

/**
 * SA-1222 PR-A: the Create PO modal's side of draft autosave, a thin wrapper over the ONE draft engine (SA-817 A). A PURCHASE_ORDER
 * `SaleDraft` is per-user parking BEFORE the document exists (no number; invisible to the PO list, bills and receiving). Nothing
 * is priced here: PO costs are what the user typed. The modal calls this from PR-B.
 */
export const PO_DRAFT_VERSION = 1;

export interface PoDraftLine extends POLineItem {
  /** The box size when the line was saved (null = not boxed); a resume compares it with today's. */
  unitsPerBox: number | null;
}

export interface PoDraftState {
  supplierId: string;
  supplierName?: string | null;
  expectedDate: string;
  notes: string;
  lines: PoDraftLine[];
}

/** Worth a server row: a supplier is chosen, or any line has a product. An empty form parks nothing. */
export const poDraftParkable = (s: Pick<PoDraftState, "supplierId" | "lines">): boolean =>
  !!s.supplierId || s.lines.some((l) => !!l.productId);

/** The payload as stored (the hook adds the submit key). */
export function buildPoDraftPayload(s: PoDraftState): Record<string, unknown> {
  return {
    v: PO_DRAFT_VERSION,
    supplierId: s.supplierId,
    expectedDate: s.expectedDate,
    notes: s.notes,
    lines: s.lines.map((l) => ({ ...l })),
  };
}

export function poDraftMeta(s: Pick<PoDraftState, "supplierName">): DraftRowMeta {
  return {
    kind: "PURCHASE_ORDER",
    title: s.supplierName?.trim() || null,
    device: draftDeviceLabel(),
  };
}

export interface UsePoDraftAutosaveArgs {
  isOpen: boolean;
  /** The draft being resumed; a different value is a new session. */
  resumeDraftId?: string | null;
  state: PoDraftState;
  user: { id?: string | null; tenantId?: string | null } | null | undefined;
  /** The modal's react-query mutations (no second HTTP client). */
  createDraft: (input: DraftRowMeta & { payload: DraftPayload }) => Promise<DraftRowResult>;
  updateDraft: (
    input: {
      id: string;
      payload: DraftPayload;
      expectedUpdatedAt?: string;
    } & Partial<DraftRowMeta>,
  ) => Promise<DraftRowResult | undefined | void>;
  /** Another tab changed the draft: both versions were kept (v1 runs keep-both on its own). */
  onKeptBoth?: () => void;
}

export function usePoDraftAutosave(args: UsePoDraftAutosaveArgs) {
  const { isOpen, resumeDraftId, state, user } = args;
  const argsRef = React.useRef(args);
  argsRef.current = args;
  const userId = user?.id ?? null;
  const tenantId = user?.tenantId ?? null;
  const mirror = React.useMemo(
    () =>
      tenantId && userId
        ? createDraftMirror({ storage: getDraftMirrorStorage(), tenantId, userId })
        : null,
    [tenantId, userId],
  );
  const keyRef = React.useRef(mintSubmitKey());
  const localIdRef = React.useRef(mintSubmitKey());
  const engineRef = React.useRef<OrderDraftEngine | null>(null);

  const make = React.useCallback((): OrderDraftEngine => {
    const engine: OrderDraftEngine = createOrderDraftEngine({
      get localId() {
        return localIdRef.current;
      },
      createDraft: (i) => argsRef.current.createDraft(i),
      updateDraft: (i) => argsRef.current.updateDraft(i),
      mirror: mirror ?? undefined,
      parseConflict: parseDraftChanged,
      isGone: (e) => (e as { response?: { status?: number } } | null)?.response?.status === 404,
      mintKey: mintSubmitKey,
      onConflict: () =>
        // v1: no dialog. This tab's version stays on its draft, the other tab's is parked as its own draft.
        void engine
          .resolveConflict("keep-mine", { keepKey: true })
          .then(() => argsRef.current.onKeptBoth?.())
          .catch(() => undefined),
    });
    return engine;
  }, [mirror]);

  // A new open (or resume target) is a new session.
  React.useEffect(() => {
    if (!isOpen) return;
    engineRef.current?.dispose();
    keyRef.current = mintSubmitKey();
    localIdRef.current = mintSubmitKey();
    engineRef.current = make();
  }, [isOpen, resumeDraftId, make]);

  const payloadJson = JSON.stringify(buildPoDraftPayload(state));
  React.useEffect(() => {
    const persisted = withDraftSubmitKey(buildPoDraftPayload(state), keyRef.current);
    engineRef.current?.update(
      persisted as unknown as DraftPayload,
      poDraftMeta(state),
      isOpen,
      poDraftParkable(state),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadJson, isOpen, state.supplierName]);

  // Hidden tab or page leaving: write the local copy now.
  React.useEffect(() => {
    if (!isOpen || !mirror) return;
    const detach = attachMirrorFlush(mirror);
    return () => {
      detach();
      void mirror.flush();
    };
  }, [isOpen, mirror]);
  React.useEffect(() => () => engineRef.current?.dispose(), []);

  return {
    /** The key the PO create sends as `Idempotency-Key`. */
    submitKey: () => keyRef.current,
    draftId: () => engineRef.current?.draftId ?? null,
    /** Save now (close, unmount, pagehide). */
    flush: () => engineRef.current?.flush() ?? Promise.resolve(),
    /** The PO was created or the draft deleted: every later write is a no-op, and the local copy goes. */
    discard: () => {
      engineRef.current?.discard();
      return mirror?.remove(localIdRef.current) ?? Promise.resolve();
    },
  };
}

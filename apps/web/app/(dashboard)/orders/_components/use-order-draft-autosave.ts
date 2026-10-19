"use client";

import * as React from "react";
import { API_ERROR_CODES } from "@routeflow/types";
import { readDraftSubmitKey, withDraftSubmitKey } from "@routeflow/types/draft-submit-key";
import {
  createOrderDraftEngine,
  type ConflictChoice,
  type ConflictResolution,
  type DraftConflict,
  type DraftPayload,
  type DraftRowMeta,
  type DraftRowResult,
  type OrderDraftEngine,
  type ServerDraftSnapshot,
} from "@/lib/order-draft/engine";
import { attachMirrorFlush, createDraftMirror, type DraftMirror } from "@/lib/order-draft/mirror";
import { payloadHash } from "@/lib/order-draft/payload-hash";
import { getDraftMirrorStorage, type LocalDraftRecord } from "@/lib/order-draft/storage";
import { draftDeviceLabel } from "@/lib/drafts";
import { mintSubmitKey } from "./use-create-order-submit-key";

/**
 * SA-817 (A): the modal's side of draft autosave. One engine per open session (`createOrderDraftEngine`, the web mirror of
 * mobile's `createDraftAutosave`) writes to the server `SaleDraft` from the first parkable change (customer + at least one line),
 * and a local mirror (IndexedDB, behind `DraftMirrorStorage`) follows every change after 300 ms, so a dropped connection or a
 * reload loses nothing. The submit key rides in `payload._submitKey` (local and server).
 *
 * The create/update calls go through the modal's own react-query mutations (`mutateAsync`), so there is no second HTTP client.
 */

export interface OrderDraftIdentity {
  id?: string | null;
  tenantId?: string | null;
  tenantSlug?: string | null;
}

type Mutate<I, O> = (input: I) => Promise<O>;

export interface UseOrderDraftAutosaveArgs {
  isOpen: boolean;
  /** New engine whenever this changes together with `isOpen` (a resume is a different session). */
  resumeDraftId?: string | null;
  /** Autosave is live (open, and not mid-resume while the draft is still loading). */
  enabled: boolean;
  /** Customer + at least one line: worth a server row. Gates the CREATE only. */
  parkable: boolean;
  /** The builder state, WITHOUT the submit key. */
  payload: Record<string, unknown>;
  payloadJson: string;
  meta: DraftRowMeta;
  user: OrderDraftIdentity | null | undefined;
  /** `peek()` is what the draft carries; `keyTick` changes when a re-mint changed it. */
  submitKey: { peek(): string };
  keyTick: number;
  createDraft: Mutate<DraftRowMeta & { payload: DraftPayload }, DraftRowResult>;
  updateDraft: Mutate<
    { id: string; payload: DraftPayload; expectedUpdatedAt?: string } & Partial<DraftRowMeta>,
    DraftRowResult | undefined | void
  >;
}

/** 409 DRAFT_CHANGED -> the server's version carried in the body; anything else -> null. */
export function parseDraftChanged(err: unknown): ServerDraftSnapshot | null {
  const res = (
    err as {
      response?: { status?: number; data?: { code?: string; current?: ServerDraftSnapshot } };
    } | null
  )?.response;
  if (res?.status !== 409 || res.data?.code !== API_ERROR_CODES.DRAFT_CHANGED) return null;
  const current = res.data.current;
  return current?.id ? current : null;
}

/** The row fields a draft mirrors (the dock's title / customer), derived from the builder payload in one place. */
export function draftMetaOf(payload: {
  customer?: { id: string; businessName: string } | null;
}): DraftRowMeta {
  return {
    kind: "ORDER",
    customerId: payload.customer?.id ?? null,
    customerName: payload.customer?.businessName ?? null,
    title: payload.customer ? `Order, ${payload.customer.businessName}` : "Order draft",
    device: draftDeviceLabel(),
  };
}

const isGone = (err: unknown): boolean =>
  (err as { response?: { status?: number } } | null)?.response?.status === 404;

export function useOrderDraftAutosave(args: UseOrderDraftAutosaveArgs) {
  const { isOpen, resumeDraftId, enabled, parkable, payload, payloadJson, meta, user } = args;
  const argsRef = React.useRef(args);
  argsRef.current = args;

  const userId = user?.id ?? null;
  const tenantId = user?.tenantId ?? user?.tenantSlug ?? null;
  const mirror = React.useMemo<DraftMirror | null>(
    () =>
      tenantId && userId
        ? createDraftMirror({ storage: getDraftMirrorStorage(), tenantId, userId })
        : null,
    [tenantId, userId],
  );

  const mirrorRef = React.useRef(mirror);
  mirrorRef.current = mirror;
  const localIdRef = React.useRef<string>(mintSubmitKey());
  const [draftId, setDraftId] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<DraftConflict | null>(null);
  const [version, setVersion] = React.useState(0);

  const makeEngine = React.useCallback((): OrderDraftEngine => {
    const engine = createOrderDraftEngine({
      get localId() {
        return localIdRef.current;
      },
      createDraft: (input) => argsRef.current.createDraft(input),
      updateDraft: (input) => argsRef.current.updateDraft(input),
      get mirror() {
        return mirrorRef.current ?? undefined;
      },
      parseConflict: parseDraftChanged,
      isGone,
      mintKey: mintSubmitKey,
      onConflict: (c) => setConflict(c),
      onSaveError: () => {
        // The local copy already holds the state and the next change (or the browser coming back online) retries.
      },
    });
    engine.onDraftIdChange(setDraftId);
    return engine;
  }, []);

  const engineRef = React.useRef<OrderDraftEngine | null>(null);
  if (engineRef.current === null) engineRef.current = makeEngine();

  // A new open (or a different resume target) is a new session: a fresh engine, a fresh local id, nothing bound yet.
  React.useEffect(() => {
    if (!isOpen) return;
    engineRef.current?.dispose();
    localIdRef.current = mintSubmitKey();
    engineRef.current = makeEngine();
    setDraftId(null);
    setConflict(null);
    setVersion((v) => v + 1);
  }, [isOpen, resumeDraftId, makeEngine]);

  // Feed every change in: the engine mirrors locally at once (300 ms debounce) and saves to the server after 900 ms.
  React.useEffect(() => {
    const persisted = withDraftSubmitKey(payload, argsRef.current.submitKey.peek());
    engineRef.current?.update(persisted as DraftPayload, meta, enabled && isOpen, parkable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    payloadJson,
    args.keyTick,
    enabled,
    isOpen,
    parkable,
    version,
    meta.customerId,
    meta.customerName,
  ]);

  // The tab going to the background / away flushes the local copy; coming back online flushes the server write.
  React.useEffect(() => {
    if (!isOpen) return;
    const detach = mirror ? attachMirrorFlush(mirror) : () => undefined;
    const onOnline = () => {
      engineRef.current?.flush().catch(() => undefined);
    };
    window.addEventListener("online", onOnline);
    return () => {
      detach();
      window.removeEventListener("online", onOnline);
      void mirror?.flush();
    };
  }, [isOpen, mirror]);

  React.useEffect(() => () => engineRef.current?.dispose(), []);

  /** Bind to the server draft the builder was just filled from. `normalized` is the payload exactly as the builder re-serializes it. */
  const hydrateFromServer = React.useCallback(
    (draft: { id: string; updatedAt: string }, normalized: DraftPayload) => {
      localIdRef.current = draft.id;
      engineRef.current?.hydrate({
        draftId: draft.id,
        updatedAt: draft.updatedAt,
        syncedHash: payloadHash(normalized),
        payload: normalized,
        meta: draftMetaOf(normalized as { customer?: { id: string; businessName: string } | null }),
        inSync: true,
      });
    },
    [],
  );

  /** Bind to a local copy the builder was just filled from. It may be ahead of the server, so the first save PATCHes it. */
  const hydrateFromLocal = React.useCallback(
    (record: LocalDraftRecord, normalized: DraftPayload) => {
      localIdRef.current = record.localId;
      engineRef.current?.hydrate({
        draftId: record.serverDraftId,
        updatedAt: record.serverUpdatedAt,
        syncedHash: record.syncedHash,
        payload: normalized,
        meta: draftMetaOf(normalized as { customer?: { id: string; businessName: string } | null }),
        inSync: false,
      });
    },
    [],
  );

  const flush = React.useCallback(async (opts?: { force?: boolean }): Promise<boolean> => {
    try {
      await engineRef.current?.flush(opts);
      return true;
    } catch {
      return false;
    }
  }, []);

  /**
   * The order exists (or the draft was discarded on purpose): stop writing and drop the local copy. Resolves with the bound
   * server draft id once a create that was already in flight has landed, so the caller can delete it (no orphan row).
   */
  const finish = React.useCallback(async (): Promise<string | null> => {
    const engine = engineRef.current;
    engine?.discard();
    void mirror?.remove(localIdRef.current);
    await engine?.settled();
    return engine?.draftId ?? null;
  }, [mirror]);

  const resolveConflict = React.useCallback(
    async (choice: ConflictChoice): Promise<ConflictResolution> => {
      const resolution = await engineRef.current!.resolveConflict(choice);
      setConflict(null);
      if (resolution.choice === "open-other") void mirror?.remove(localIdRef.current);
      return resolution;
    },
    [mirror],
  );

  return {
    draftId,
    getDraftId: () => engineRef.current?.draftId ?? null,
    conflict,
    mirror,
    localId: () => localIdRef.current,
    flush,
    finish,
    hydrateFromServer,
    hydrateFromLocal,
    resolveConflict,
    readSubmitKey: readDraftSubmitKey,
  };
}

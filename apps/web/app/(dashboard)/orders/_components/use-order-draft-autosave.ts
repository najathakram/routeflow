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

/** How long a submit waits for the server copy of the draft before sending anyway. */
export const SUBMIT_FLUSH_BUDGET_MS = 1500;

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
  // tenantId only: the same segment the sign-out guard counts, so a copy is never hidden from one and shown to the other.
  const tenantId = user?.tenantId ?? null;
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
  // A hydrate binds an existing draft without re-keying the local copy it came from.
  const keepLocalIdRef = React.useRef(false);
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
    engine.onDraftIdChange((id) => {
      setDraftId(id);
      // Once a server draft is bound the local copy is keyed by ITS id, so a docked-draft resume finds the newer local copy.
      if (id && !keepLocalIdRef.current && localIdRef.current !== id) {
        const old = localIdRef.current;
        localIdRef.current = id;
        // the new key's first write is queued right after the bind (same tick): drop the old key once it has landed
        queueMicrotask(() => {
          const m = mirrorRef.current;
          if (m) void m.flush().then(() => m.remove(old));
        });
      }
    });
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
    (draft: { id: string; updatedAt: string; payload?: unknown }, normalized: DraftPayload) => {
      localIdRef.current = draft.id;
      // A draft that predates the submit key (or never had one written) does NOT yet hold the key the builder is about to use:
      // the server holds its payload as stored, the first save PATCHes the key in, and the local copy survives until then.
      const serverHasKey =
        readDraftSubmitKey(draft.payload) !== null || draft.payload === undefined;
      keepLocalIdRef.current = true;
      engineRef.current?.hydrate({
        draftId: draft.id,
        updatedAt: draft.updatedAt,
        syncedHash: serverHasKey ? payloadHash(normalized) : payloadHash(draft.payload),
        payload: normalized,
        meta: draftMetaOf(normalized as { customer?: { id: string; businessName: string } | null }),
        inSync: serverHasKey,
      });
      keepLocalIdRef.current = false;
    },
    [],
  );

  /** Bind to a local copy the builder was just filled from. It may be ahead of the server, so the first save PATCHes it. */
  const hydrateFromLocal = React.useCallback(
    (record: LocalDraftRecord, normalized: DraftPayload) => {
      localIdRef.current = record.localId;
      keepLocalIdRef.current = true;
      engineRef.current?.hydrate({
        draftId: record.serverDraftId,
        updatedAt: record.serverUpdatedAt,
        syncedHash: record.syncedHash,
        payload: normalized,
        meta: draftMetaOf(normalized as { customer?: { id: string; businessName: string } | null }),
        inSync: false,
      });
      keepLocalIdRef.current = false;
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
   * Before a submit POST: the local copy (with the submit key) is written, and the server copy is saved, within ONE short budget,
   * so the key is durable before it is sent. Never gates the order: a failed, slow or hung draft write is ignored.
   */
  const durableBeforeSubmit = React.useCallback(async (): Promise<void> => {
    // BOTH writes share ONE budget: a hung local store (IndexedDB can stall in Safari) must not hold the order back either.
    const saves = (async () => {
      try {
        await mirrorRef.current?.flush();
      } catch {
        /* the order must still go */
      }
      await flush({ force: true });
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      saves,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SUBMIT_FLUSH_BUDGET_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }, [flush]);

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
    async (choice: ConflictChoice, opts?: { keepKey?: boolean }): Promise<ConflictResolution> => {
      const resolution = await engineRef.current!.resolveConflict(choice, opts);
      setConflict(null);
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
    durableBeforeSubmit,
    finish,
    hydrateFromServer,
    hydrateFromLocal,
    resolveConflict,
    readSubmitKey: readDraftSubmitKey,
  };
}

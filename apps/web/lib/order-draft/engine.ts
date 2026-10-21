import { withDraftSubmitKey } from "@routeflow/types/draft-submit-key";
import { payloadHash, stableStringify } from "./payload-hash";
import type { MirrorWriteInput } from "./mirror";

/**
 * SA-817 (A) 1/2: the web order-draft autosave engine.
 *
 * It MIRRORS the rules of the mobile engine (`apps/mobile/lib/use-draft-autosave.ts` `createDraftAutosave`): a 900 ms debounce,
 * a single-flight CREATE latch (an awaited Promise, never a boolean), a JSON-unchanged skip, a create gated on `parkable` while an
 * already-bound draft keeps being written as the cart empties, and discard-is-final. It is a mirror, not an import, because the web
 * engine adds what mobile does not need yet and mobile's tests pin its exact behaviour: the compare-and-set `expectedUpdatedAt`
 * (a 409 `DRAFT_CHANGED` suspends saving and offers "keep both"), the local mirror write on every change, and the 404 re-create.
 *
 * Pure closures, no React: driven directly with Jest fake timers.
 */
export const DRAFT_AUTOSAVE_MS = 900;

export interface DraftRowMeta {
  kind: "ORDER";
  customerId?: string | null;
  customerName?: string | null;
  title?: string | null;
  device?: string;
}

export type DraftPayload = MirrorWriteInput["payload"];

/** What a create / update returns that the engine needs. */
export interface DraftRowResult {
  id: string;
  updatedAt?: string | null;
}

/** The server's version of a draft, as carried in the 409 body (`current`). */
export interface ServerDraftSnapshot {
  id: string;
  updatedAt: string;
  payload: Record<string, unknown>;
  customerId?: string | null;
  customerName?: string | null;
  title?: string | null;
}

export interface DraftConflict {
  /** This device's version (what the user was typing). */
  mine: DraftPayload;
  /** The server's version (written by another device after our last sync). */
  current: ServerDraftSnapshot;
}

export class DraftConflictError extends Error {
  constructor() {
    super("This order was changed on another device.");
    this.name = "DraftConflictError";
  }
}

export interface OrderDraftEngineDeps {
  /** The mirror record id: the server draft id when resuming one, else a minted id. */
  localId: string;
  createDraft: (input: DraftRowMeta & { payload: DraftPayload }) => Promise<DraftRowResult>;
  updateDraft: (
    input: {
      id: string;
      payload: DraftPayload;
      expectedUpdatedAt?: string;
    } & Partial<DraftRowMeta>,
  ) => Promise<DraftRowResult | undefined | void>;
  /** The local mirror; absent = no local copy (no identity, or no IndexedDB). */
  mirror?: { write(input: MirrorWriteInput): void };
  /** 409 `DRAFT_CHANGED` -> the server's version; any other error -> null. */
  parseConflict: (err: unknown) => ServerDraftSnapshot | null;
  /** 404: the bound draft is gone (deleted elsewhere): the next save creates a fresh one. */
  isGone?: (err: unknown) => boolean;
  /** A fresh submit key, for a copy that must not share the original's key. */
  mintKey: () => string;
  onConflict?: (conflict: DraftConflict) => void;
  onSaveError?: (err: unknown) => void;
  debounceMs?: number;
}

export interface EngineHydration {
  draftId: string | null;
  updatedAt: string | null;
  /** `payloadHash` the server last confirmed for this draft (null = unknown/never). */
  syncedHash: string | null;
  payload: DraftPayload;
  meta: DraftRowMeta;
  /** True when `payload` is exactly what the server holds (a server-draft resume): nothing to write back at once. A resume from a
   *  local copy that is ahead of the server passes false, so the first save PATCHes it. */
  inSync: boolean;
}

export type ConflictChoice = "keep-mine" | "open-other";

export type ConflictResolution =
  | { choice: "keep-mine"; draftId: string; payload: DraftPayload; parkedDraftId?: string }
  | { choice: "open-other"; current: ServerDraftSnapshot; parkedDraftId: string };

export interface OrderDraftEngine {
  update(payload: DraftPayload, meta: DraftRowMeta, enabled: boolean, parkable?: boolean): void;
  /**
   * Save now. Rejects with the transport error (the local mirror already holds the state), or `DraftConflictError`.
   * `force` creates the server row even for a state that is not yet parkable (an explicit Minimize / dismiss).
   */
  flush(opts?: { force?: boolean }): Promise<void>;
  /** Every later write becomes a no-op. Irreversible; call right before handing the draft to a submit/delete flow. */
  discard(): void;
  dispose(): void;
  /** Resolves once a draft create that was already in flight has landed (or failed): `draftId` is final after this. */
  settled(): Promise<void>;
  /** Bind to an existing server draft (a resume) without writing anything. */
  hydrate(h: EngineHydration): void;
  /**
   * Settle a 409 by keeping BOTH versions: nothing is lost (A2). `keepKey` (when this device's submit key may already have been
   * used by a submit) holds for BOTH choices: this version stays ON the original draft with its original key, and the OTHER
   * device's version is parked as the new draft (and, for "open the other", opened), so the key that may already own an order is
   * never moved or re-minted.
   */
  resolveConflict(
    choice: ConflictChoice,
    opts?: { keepKey?: boolean },
  ): Promise<ConflictResolution>;
  readonly draftId: string | null;
  readonly serverUpdatedAt: string | null;
  readonly conflict: DraftConflict | null;
  onDraftIdChange(listener: ((id: string | null) => void) | null): void;
}

const snapshotOf = (payload: unknown, meta: DraftRowMeta) => stableStringify({ meta, payload });

export function createOrderDraftEngine(deps: OrderDraftEngineDeps): OrderDraftEngine {
  let draftId: string | null = null;
  let serverUpdatedAt: string | null = null;
  let syncedHash: string | null = null;
  let lastSaved: string | null = null;
  let createPromise: Promise<DraftRowResult> | null = null;
  // ONE PATCH in flight at a time (its expectedUpdatedAt is the last ACKed response's); later saves wait, then send the latest.
  let patching: Promise<"done" | "retry" | "gone"> | null = null;
  // TypeScript narrows `patching` to null after the first check (it is assigned in a closure it cannot see through awaits).
  const inFlight = () => patching;
  // Hashes of the payloads this device sent. A 409 whose current payload is one of them is our OWN committed write whose
  // response was lost, not another device.
  const sentHashes: string[] = [];
  const rememberSent = (hash: string) => {
    sentHashes.push(hash);
    if (sentHashes.length > 32) sentHashes.shift();
  };
  let conflict: DraftConflict | null = null;
  let discarded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idListener: ((id: string | null) => void) | null = null;

  let latestPayload: DraftPayload | null = null;
  let latestMeta: DraftRowMeta = { kind: "ORDER" };
  let latestEnabled = false;
  let latestParkable = false;

  const setDraftId = (id: string | null) => {
    if (id === draftId) return;
    draftId = id;
    idListener?.(id);
  };
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const mirror = (payload: DraftPayload, meta: DraftRowMeta) => {
    deps.mirror?.write({
      localId: deps.localId,
      serverDraftId: draftId,
      serverUpdatedAt,
      syncedHash,
      customerId: meta.customerId ?? null,
      customerName: meta.customerName ?? null,
      payload,
    });
  };

  const adopt = (row: DraftRowResult | undefined | void) => {
    serverUpdatedAt = row && typeof row === "object" ? (row.updatedAt ?? null) : serverUpdatedAt;
  };

  async function performSave(attempt = 0): Promise<void> {
    if (discarded || !latestEnabled || latestPayload === null) return;
    if (conflict) throw new DraftConflictError();
    const early = inFlight();
    if (early) {
      // A PATCH is in flight: its response carries the updatedAt the next one must expect. Wait for it (so a flush really means
      // "saved"), then re-evaluate: the latest state is sent only if it still differs.
      await early.catch(() => undefined);
      return performSave(attempt);
    }
    if (snapshotOf(latestPayload, latestMeta) === lastSaved) return; // unchanged-payload skip

    let id = draftId;
    if (!id) {
      if (createPromise) {
        // another save already started the create: ride it, no second POST (also covers an emptied cart)
        id = (await createPromise).id;
      } else {
        if (!latestParkable) return; // never CREATE from a state not worth a server row
        const sentPayload = latestPayload;
        const sentMeta = latestMeta;
        rememberSent(payloadHash(sentPayload));
        const promise = Promise.resolve(
          deps.createDraft({ ...sentMeta, payload: sentPayload }),
        ).then((row) => {
          if (!row?.id) throw new Error("The draft was not created.");
          return row;
        });
        createPromise = promise; // stored BEFORE awaiting: the latch
        let row: DraftRowResult;
        try {
          row = await promise;
        } catch (err) {
          createPromise = null; // the next save retries the create
          throw err;
        }
        createPromise = null;
        id = row.id;
        adopt(row);
        syncedHash = payloadHash(sentPayload);
        lastSaved = snapshotOf(sentPayload, sentMeta);
        setDraftId(id);
        if (discarded) return;
        mirror(latestPayload ?? sentPayload, latestMeta);
      }
    }
    if (discarded) return;

    const started = inFlight();
    if (started) {
      // a PATCH started while this save waited on the create
      await started.catch(() => undefined);
      return performSave(attempt);
    }

    const sentPayload = latestPayload;
    const sentMeta = latestMeta;
    const sent = snapshotOf(sentPayload, sentMeta);
    if (sent === lastSaved) return; // the create already covered it

    // claim the snapshot BEFORE awaiting (mirrors the create latch): a concurrent save sees it claimed and skips
    const previous = lastSaved;
    lastSaved = sent;
    rememberSent(payloadHash(sentPayload));
    const op = (async (): Promise<"done" | "retry" | "gone"> => {
      try {
        const row = await Promise.resolve(
          deps.updateDraft({
            id: id as string,
            payload: sentPayload,
            ...(serverUpdatedAt ? { expectedUpdatedAt: serverUpdatedAt } : {}),
            ...sentMeta,
          }),
        );
        adopt(row);
        syncedHash = payloadHash(sentPayload);
        if (!discarded) mirror(latestPayload ?? sentPayload, latestMeta); // deletes the record iff the server now holds it all
        return "done";
      } catch (err) {
        if (lastSaved === sent) lastSaved = previous;
        const current = deps.parseConflict(err);
        if (current) {
          const currentHash = payloadHash(current.payload);
          if (sentHashes.includes(currentHash) && attempt < 3) {
            // The server holds a payload THIS device sent: our own write committed and its response was lost. Not another
            // device, so no dialog: adopt its updatedAt and send the latest again.
            serverUpdatedAt = current.updatedAt;
            syncedHash = currentHash;
            if (payloadHash(latestPayload ?? sentPayload) === currentHash) {
              lastSaved = snapshotOf(latestPayload ?? sentPayload, latestMeta);
              if (!discarded) mirror(latestPayload ?? sentPayload, latestMeta);
              return "done";
            }
            return "retry";
          }
          // Another device wrote after our last sync. Suspend saving; nothing is overwritten (A2/A4).
          conflict = { mine: latestPayload ?? sentPayload, current };
          mirror(latestPayload ?? sentPayload, latestMeta);
          deps.onConflict?.(conflict);
          throw new DraftConflictError();
        }
        if (deps.isGone?.(err) && attempt < 3) return "gone";
        throw err;
      }
    })();
    patching = op;
    let outcome: "done" | "retry" | "gone";
    try {
      outcome = await op;
    } finally {
      if (patching === op) patching = null;
    }
    if (outcome === "gone") {
      // deleted elsewhere: forget the binding and create a fresh draft from what we have
      setDraftId(null);
      serverUpdatedAt = null;
      syncedHash = null;
      lastSaved = null;
      return performSave(attempt + 1);
    }
    if (outcome === "retry") return performSave(attempt + 1);
  }

  const arm = () => {
    clearTimer();
    if (discarded || !latestEnabled) return;
    timer = setTimeout(() => {
      timer = null;
      performSave().catch((err) => {
        if (!(err instanceof DraftConflictError)) deps.onSaveError?.(err);
      });
    }, deps.debounceMs ?? DRAFT_AUTOSAVE_MS);
  };

  return {
    update(payload, meta, enabled, parkable) {
      latestPayload = payload;
      latestMeta = meta;
      latestEnabled = enabled;
      latestParkable = parkable ?? enabled;
      if (discarded || !enabled) {
        clearTimer();
        return;
      }
      // The local copy follows every change from the first parkable one (it has its own 300 ms debounce).
      if (latestParkable || draftId || createPromise) mirror(payload, meta);
      arm();
    },
    flush(opts) {
      clearTimer();
      if (opts?.force) latestParkable = true;
      return performSave();
    },
    discard() {
      discarded = true;
      clearTimer();
    },
    dispose() {
      clearTimer();
    },
    async settled() {
      try {
        await createPromise;
      } catch {
        /* a failed create leaves no row */
      }
    },
    hydrate(h) {
      draftId = h.draftId;
      serverUpdatedAt = h.updatedAt;
      syncedHash = h.syncedHash;
      lastSaved = h.inSync ? snapshotOf(h.payload, h.meta) : null;
      latestPayload = h.payload;
      latestMeta = h.meta;
      conflict = null;
      idListener?.(draftId);
    },
    async resolveConflict(choice, opts) {
      if (!conflict) throw new Error("There is no conflict to resolve.");
      const { mine, current } = conflict;
      if (opts?.keepKey) {
        // This device's submit key may already own an order (a submit whose outcome is unknown): it stays on THIS device's version
        // ON the original draft, whichever version the user chooses to look at. The other device's version is parked as its own
        // new draft with its own fresh key, then ours is written over the original draft, checked against THEIR updatedAt.
        // Nothing is lost.
        const theirs = withDraftSubmitKey(current.payload, deps.mintKey()) as DraftPayload;
        const parked = await Promise.resolve(
          deps.createDraft({
            kind: "ORDER",
            customerId: current.customerId ?? null,
            customerName: current.customerName ?? null,
            title: current.title ?? null,
            payload: theirs,
          }),
        );
        if (!parked?.id) throw new Error("The draft was not created.");
        let row: DraftRowResult | undefined | void;
        try {
          row = await Promise.resolve(
            deps.updateDraft({
              id: current.id,
              payload: mine,
              expectedUpdatedAt: current.updatedAt,
              ...latestMeta,
            }),
          );
        } catch (err) {
          const again = deps.parseConflict(err);
          if (again) {
            conflict = { mine, current: again };
            deps.onConflict?.(conflict);
          }
          throw err;
        }
        conflict = null;
        if (choice === "keep-mine") {
          adopt(row);
          syncedHash = payloadHash(mine);
          lastSaved = snapshotOf(mine, latestMeta);
          latestPayload = mine;
          setDraftId(current.id);
          mirror(mine, latestMeta);
          return { choice, draftId: current.id, payload: mine, parkedDraftId: parked.id };
        }
        // open-other: this device's version is safe on the original draft (with its key); the editor opens the other device's
        // version, which now lives in the new draft.
        draftId = parked.id;
        serverUpdatedAt = parked.updatedAt ?? null;
        syncedHash = payloadHash(theirs);
        lastSaved = null;
        idListener?.(draftId);
        return {
          choice,
          current: {
            id: parked.id,
            updatedAt: parked.updatedAt ?? "",
            payload: theirs,
            customerId: current.customerId,
            customerName: current.customerName,
            title: current.title,
          },
          parkedDraftId: current.id,
        };
      }
      // Both versions survive: this device's copy becomes its OWN server draft with its OWN submit key (the original key
      // belongs to the draft the other device changed, and the server refuses a key that is on another draft).
      const parked = withDraftSubmitKey(mine, deps.mintKey()) as DraftPayload;
      const row = await Promise.resolve(deps.createDraft({ ...latestMeta, payload: parked }));
      if (!row?.id) throw new Error("The draft was not created.");
      conflict = null;
      if (choice === "keep-mine") {
        adopt(row);
        syncedHash = payloadHash(parked);
        lastSaved = snapshotOf(parked, latestMeta);
        latestPayload = parked;
        setDraftId(row.id);
        mirror(parked, latestMeta);
        return { choice, draftId: row.id, payload: parked };
      }
      // open-other: this device's copy is parked in the dock; the editor moves to the other device's version
      draftId = current.id;
      serverUpdatedAt = current.updatedAt;
      syncedHash = payloadHash(current.payload);
      lastSaved = null;
      idListener?.(draftId);
      return { choice, current, parkedDraftId: row.id };
    },
    get draftId() {
      return draftId;
    },
    get serverUpdatedAt() {
      return serverUpdatedAt;
    },
    get conflict() {
      return conflict;
    },
    onDraftIdChange(listener) {
      idListener = listener;
    },
  };
}

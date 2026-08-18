import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Continuous park/resume autosave for the order builder (PR-3 decisions
 * §PR-3.1/§PR-3.5). An operator building an order on a handset who takes a
 * call or gets the app reloaded must never lose the cart — so instead of one
 * explicit "park" action, the builder binds to a server `SaleDraft` the
 * moment it becomes parkable and keeps it in sync in the background.
 *
 * The one hazard that makes this more than "debounce a PATCH": React state
 * updates that fire close together (typing a note, ticking a box, a scan
 * landing) can each schedule a save, and any of those saves may be the one
 * that discovers there's no draft yet and needs to create it. If "am I
 * already creating?" were a boolean, two of those saves could both read
 * `false` before either sets it `true` and each would fire its own
 * `POST /drafts` — two server drafts for one builder session. Storing the
 * in-flight CREATE as a `Promise` and having every save `await` that exact
 * promise closes the race: whichever save calls `createDraft` first stores
 * the promise before awaiting it, and every other save that also needs an id
 * awaits that same promise instead of starting its own.
 *
 * `createDraftAutosave` is the framework-free engine (single-flight create
 * latch, 900ms debounce, JSON-unchanged skip, discard-is-final) — plain
 * closures, no React, so it can be driven directly with Jest fake timers.
 * `useDraftAutosave` is the thin hook the builder screen actually calls; it
 * owns one engine instance for the life of the mount and feeds it the
 * builder's payload on every change.
 */

/** Draft-row fields mirrored on every create/update call (matches SaleDraft). */
export interface DraftRowMeta {
  kind: "ORDER" | "INVOICE";
  customerId?: string | null;
  customerName?: string | null;
  title?: string | null;
}

export interface DraftAutosaveDeps {
  /** POST /drafts — must resolve with the created row's id. */
  createDraft: (input: DraftRowMeta & { payload: unknown }) => Promise<{ id: string }>;
  /** PATCH /drafts/:id. */
  updateDraft: (
    input: { id: string; payload: unknown } & Partial<DraftRowMeta>,
  ) => Promise<unknown>;
  /**
   * DELETE /drafts/:id. The engine itself never calls this — submit-time
   * deletion (discard → poison-pill PATCH → delete) is orchestrated by the
   * screen per the decisions doc's §PR-3.2 flow. Accepted here only so a
   * caller can hand this hook the same three CRUD functions it already has
   * from `lib/api/drafts.ts` without picking them apart.
   */
  deleteDraft?: (id: string) => Promise<unknown>;
  /** Idle time before an unsaved change is written. Defaults to 900ms. */
  debounceMs?: number;
  /** Best-effort observability hook for a create/update that fails; the
   * engine already retries on the next save, so this is for logging only. */
  onSaveError?: (err: unknown) => void;
}

export interface DraftAutosaveHydration {
  draftId: string;
  payload: unknown;
  meta: DraftRowMeta;
}

export interface DraftAutosave {
  /**
   * Feed in the latest builder state. (Re)arms the debounce timer unless
   * discarded or `enabled` is false; never throws.
   *
   * `enabled` suspends autosave entirely (a run/stop order, or a resume still
   * hydrating — freeze, write nothing). `parkable` is narrower and gates only
   * the CREATE: a state with no customer or no lines isn't worth a server row.
   * Once a row IS bound, a state that stops being parkable must still be
   * written — an operator who empties the cart and walks away has to leave an
   * empty draft behind, not one that still lists the lines they just deleted.
   * Defaults to `enabled` for callers that don't distinguish the two.
   */
  update(payload: unknown, meta: DraftRowMeta, enabled: boolean, parkable?: boolean): void;
  /** Cancel any pending timer and save now. Safe to call concurrently from
   * multiple flush points (back handler, `beforeRemove`, `visibilitychange`)
   * — every caller that needs a draft id shares the one in-flight create. */
  flush(): Promise<void>;
  /** Every later write — pending, in-flight, or future — becomes a no-op.
   * Irreversible; call once, right before handing the draft off to a
   * submit/delete flow. */
  discard(): void;
  draftId: string | null;
  /** The React wrapper's re-render channel; tests don't need this. */
  onDraftIdChange(listener: ((id: string | null) => void) | null): void;
  /** Cancels the pending timer without discarding — call from unmount. */
  dispose(): void;
}

export const DRAFT_AUTOSAVE_DEBOUNCE_MS = 900;

/** Change detection covers the row metadata too (not just the payload) so a
 * customer swap on an otherwise-untouched cart still schedules a write. */
function snapshot(payload: unknown, meta: DraftRowMeta): string {
  return JSON.stringify({ meta, payload });
}

export function createDraftAutosave(
  deps: DraftAutosaveDeps,
  hydrate?: DraftAutosaveHydration | null,
): DraftAutosave {
  // Hydration seeds BOTH refs: draftIdRef so a resumed session never creates
  // a second server draft, and the last-saved snapshot so resuming into the
  // exact payload just loaded does not immediately fire a PATCH.
  let draftIdRef: string | null = hydrate?.draftId ?? null;
  let lastSavedSnapshot: string | null = hydrate ? snapshot(hydrate.payload, hydrate.meta) : null;
  // The single-flight create latch. A boolean could not be awaited by a
  // concurrent caller and would race; a stored Promise can be, and is.
  let createPromiseRef: Promise<string> | null = null;

  let discarded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idListener: ((id: string | null) => void) | null = null;

  let latestPayload: unknown = hydrate?.payload ?? null;
  let latestMeta: DraftRowMeta = hydrate?.meta ?? { kind: "ORDER" };
  let latestEnabled = false;
  let latestParkable = false;

  function setDraftId(id: string) {
    if (id === draftIdRef) return;
    draftIdRef = id;
    idListener?.(id);
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function performSave(): Promise<void> {
    if (discarded || !latestEnabled) return;
    if (snapshot(latestPayload, latestMeta) === lastSavedSnapshot) return; // JSON-unchanged skip

    let id = draftIdRef;
    if (!id) {
      if (createPromiseRef) {
        // Another save already started the create — ride it, no second POST.
        // Deliberately BEFORE the parkable gate: once a row is on its way to
        // existing, an emptied cart still has to be written onto it.
        id = await createPromiseRef;
      } else {
        // Nothing worth a server row yet (no customer, or no lines) — never
        // CREATE from a non-parkable state. Note this gate applies only here:
        // an already-bound draft keeps being PATCHed as the state empties.
        if (!latestParkable) return;
        const createPayload = latestPayload;
        const createMeta = latestMeta;
        const promise = deps
          .createDraft({ ...createMeta, payload: createPayload })
          .then((row) => row.id);
        // Stored BEFORE awaiting — this is the latch. Any save that reaches
        // the `if (!id)` branch above while this is pending sees it here.
        createPromiseRef = promise;
        try {
          id = await promise;
        } catch (err) {
          createPromiseRef = null; // let the next save retry the create
          throw err;
        }
        createPromiseRef = null;
        setDraftId(id);
        if (discarded) return;
        // The POST body above already carried createPayload/createMeta.
        lastSavedSnapshot = snapshot(createPayload, createMeta);
      }
    }
    if (discarded) return;

    const finalSnapshot = snapshot(latestPayload, latestMeta);
    if (finalSnapshot === lastSavedSnapshot) return; // create already covered it

    // Claim the snapshot BEFORE awaiting the PATCH (mirrors the create
    // latch): a concurrent save that resumes while this PATCH is in flight
    // will see its own target snapshot already claimed and skip, instead of
    // firing a second identical PATCH.
    const previousSnapshot = lastSavedSnapshot;
    lastSavedSnapshot = finalSnapshot;
    try {
      await deps.updateDraft({ id: id as string, payload: latestPayload, ...latestMeta });
    } catch (err) {
      if (lastSavedSnapshot === finalSnapshot) lastSavedSnapshot = previousSnapshot;
      throw err;
    }
  }

  return {
    update(payload, meta, enabled, parkable) {
      latestPayload = payload;
      latestMeta = meta;
      latestEnabled = enabled;
      latestParkable = parkable ?? enabled;
      clearTimer();
      if (discarded || !enabled) return;
      timer = setTimeout(() => {
        timer = null;
        performSave().catch((err) => deps.onSaveError?.(err));
      }, deps.debounceMs ?? DRAFT_AUTOSAVE_DEBOUNCE_MS);
    },
    flush() {
      clearTimer();
      return performSave();
    },
    discard() {
      discarded = true;
      clearTimer();
    },
    get draftId() {
      return draftIdRef;
    },
    onDraftIdChange(listener) {
      idListener = listener;
    },
    dispose() {
      clearTimer();
    },
  };
}

export interface UseDraftAutosaveOptions extends DraftRowMeta {
  /** Autosave is live at all. The screen passes `!runId && !stopId &&
   * !hydrating` — editing an existing run/stop order never parks a draft, and
   * a half-hydrated resume must write nothing. */
  enabled: boolean;
  /** Is the state worth a server row (customer + at least one line)? Gates the
   * CREATE only — an already-bound draft keeps saving as the cart empties, so
   * the parked copy never outlives the lines the operator deleted. Defaults to
   * `enabled`. */
  parkable?: boolean;
  createDraft: DraftAutosaveDeps["createDraft"];
  updateDraft: DraftAutosaveDeps["updateDraft"];
  deleteDraft?: DraftAutosaveDeps["deleteDraft"];
  debounceMs?: number;
  onSaveError?: (err: unknown) => void;
  /** Set once, from `useDraft(resumeId)` — resuming a parked draft. Only the
   * value present on the FIRST render is used (the engine is created once
   * per mount); later changes are ignored, matching the one-shot
   * `initialDraft` prop the builder hydrates itself from. */
  hydrate?: { draftId: string; payload: unknown } | null;
}

export interface DraftAutosaveHandle {
  flush: () => Promise<void>;
  discard: () => void;
  draftId: string | null;
  /**
   * The LIVE draft id, read at call time. `draftId` above is React state, so a
   * closure captured before a create resolved still sees `null` — which is
   * exactly the submit path (`await flush()` may be the POST that creates the
   * draft, and the state update lands too late for the already-captured
   * `onSuccess`). Anything that deletes/poison-pills the bound draft must read
   * it through here, never from the state value.
   */
  getDraftId: () => string | null;
}

/** React wrapper: one engine per mount, re-armed on every payload/meta change. */
export function useDraftAutosave(
  payload: unknown,
  options: UseDraftAutosaveOptions,
): DraftAutosaveHandle {
  const {
    enabled,
    parkable,
    kind,
    customerId,
    customerName,
    title,
    createDraft,
    updateDraft,
    deleteDraft,
    debounceMs,
    onSaveError,
    hydrate,
  } = options;

  const engineRef = useRef<DraftAutosave | null>(null);
  if (!engineRef.current) {
    engineRef.current = createDraftAutosave(
      { createDraft, updateDraft, deleteDraft, debounceMs, onSaveError },
      hydrate
        ? {
            draftId: hydrate.draftId,
            payload: hydrate.payload,
            meta: { kind, customerId, customerName, title },
          }
        : null,
    );
  }
  const engine = engineRef.current;

  const [draftId, setDraftId] = useState<string | null>(engine.draftId);

  useEffect(() => {
    engine.onDraftIdChange(setDraftId);
    return () => engine.onDraftIdChange(null);
  }, [engine]);

  useEffect(() => {
    engine.update(payload, { kind, customerId, customerName, title }, enabled, parkable ?? enabled);
  }, [engine, payload, kind, customerId, customerName, title, enabled, parkable]);

  useEffect(() => () => engine.dispose(), [engine]);

  const flush = useCallback(() => engine.flush(), [engine]);
  const discard = useCallback(() => engine.discard(), [engine]);
  const getDraftId = useCallback(() => engine.draftId, [engine]);

  return { flush, discard, draftId, getDraftId };
}

"use client";

// SA-748: the logic behind the counter's Park button and Parked (n) list. The screen owns the cart; this hook only reads it
// (through `cart`), asks the server to keep or hand back a parked copy, and tells the screen to clear (`onParked`) or restore
// (`onRestore`). Nothing here prices anything or reserves stock, and no sale key is minted: that happens at Complete.
import * as React from "react";
import type { ParkedCartPayload } from "@routeflow/pricing";
import { useDiscard, useParkedCarts, usePark, useResume } from "@/lib/api/counter-park";
import {
  PARK_CHANGED_COPY,
  buildParkPayload,
  discardErrorCopy,
  parkErrorCopy,
  parkRefusalCopy,
  resumeErrorCopy,
  type ParkCartInput,
} from "@/lib/counter-park";

export interface ParkedSalesDeps {
  /** the live cart, read when a button is pressed */
  cart: ParkCartInput;
  /** what the cart holds right now, for the "Sale parked" toast: line count and the amount due */
  summary?: { items: number; total: number };
  /** the screen is busy or locked (sale in flight, scan waiting, a price lookup, an unknown outcome, a ship hand-off) */
  blocked: boolean;
  /** the handler-side truth for a sale POST in flight (a render may not have caught up yet) */
  inFlight: () => boolean;
  /** a park / resume / discard request is running: the screen locks its lines and Complete until it ends */
  onBusyChange?: (busy: boolean) => void;
  /** called ONLY after the server stored the park: the screen clears for the next customer */
  onParked: () => void;
  /** called with the server-rebuilt payload after a resume: the screen restores its state from it */
  onRestore: (payload: ParkedCartPayload) => void;
}

export type ParkWork = { kind: "park" | "resume" | "discard"; id?: string } | null;
export type ParkMessage = { scope: "header" | "dialog"; text: string } | null;
export type ParkChoice = "park" | "discard" | "cancel";

export function useParkedSales(deps: ParkedSalesDeps) {
  const list = useParkedCarts();
  const parkM = usePark();
  const resumeM = useResume();
  const discardM = useDiscard();
  const d = React.useRef(deps);
  d.current = deps;
  const workRef = React.useRef(false);
  // the sale parked last (W-1184): its server id and what it held, so the toast and its Undo can name it after the cart cleared
  type ParkedNote = { id: string; items: number; total: number };
  const lastParked = React.useRef<ParkedNote | null>(null as ParkedNote | null);
  const [work, setWork] = React.useState<ParkWork>(null);
  const [open, setOpenState] = React.useState(false);
  // the parked sale the clerk asked to resume while the current cart still has lines
  const [prompt, setPrompt] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<ParkMessage>(null);

  const canAct = () => !d.current.blocked && !d.current.inFlight() && !workRef.current;
  const begin = (w: NonNullable<ParkWork>) => {
    workRef.current = true;
    d.current.onBusyChange?.(true);
    setWork(w);
    setMessage(null);
  };
  const end = () => {
    workRef.current = false;
    d.current.onBusyChange?.(false);
    setWork(null);
  };

  const parkNow = async (scope: "header" | "dialog"): Promise<boolean> => {
    const { cart } = d.current;
    if (!canAct() || cart.lines.length === 0) return false;
    const built = buildParkPayload(cart);
    if (!built.ok) {
      setMessage({ scope, text: parkRefusalCopy(built.reason) });
      return false;
    }
    begin({ kind: "park" });
    try {
      const posted = JSON.stringify(built.value);
      const sum = d.current.summary;
      const saved = await parkM.mutateAsync(built.value);
      // Only now, and only if the cart is still exactly what was parked: a changed cart (or a sale that started meanwhile)
      // is NEVER cleared. The parked copy stays in the list as it was.
      const now = buildParkPayload(d.current.cart);
      if (d.current.inFlight() || !now.ok || JSON.stringify(now.value) !== posted) {
        setMessage({ scope, text: PARK_CHANGED_COPY });
        return false;
      }
      lastParked.current = sum && saved?.id ? { id: saved.id, ...sum } : null;
      d.current.onParked(); // a failed park leaves the cart untouched
      return true;
    } catch (err) {
      setMessage({ scope, text: parkErrorCopy(err) });
      return false;
    } finally {
      end();
    }
  };

  const doResume = async (id: string) => {
    if (!canAct()) return;
    begin({ kind: "resume", id });
    try {
      const res = await resumeM.mutateAsync(id);
      d.current.onRestore(res.payload);
      setOpenState(false);
    } catch (err) {
      setMessage({ scope: "dialog", text: resumeErrorCopy(err) }); // the cart is left as it was
    } finally {
      end();
    }
  };

  const startResume = (id: string) => {
    if (!canAct()) return;
    setMessage(null);
    if (d.current.cart.lines.length > 0) {
      setPrompt(id); // ask BEFORE any request leaves
      return;
    }
    void doResume(id);
  };

  const choose = async (choice: ParkChoice) => {
    const id = prompt;
    setPrompt(null);
    if (!id || choice === "cancel") return;
    if (choice === "park" && !(await parkNow("dialog"))) return;
    await doResume(id);
  };

  const discard = async (id: string) => {
    if (!canAct()) return;
    begin({ kind: "discard", id });
    try {
      await discardM.mutateAsync(id);
    } catch (err) {
      setMessage({ scope: "dialog", text: discardErrorCopy(err) });
    } finally {
      end();
    }
  };

  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (next) void list.refetch();
    else {
      setPrompt(null);
      setMessage((m) => (m?.scope === "dialog" ? null : m));
    }
  };

  const total = list.data?.total;
  return {
    count: typeof total === "number" ? total : 0,
    rows: Array.isArray(list.data?.data) ? list.data.data : [],
    listLoading: list.isLoading,
    listFailed: list.isError,
    retryList: () => void list.refetch(),
    work,
    message,
    open,
    setOpen,
    prompt,
    canPark: !deps.blocked && !work && deps.cart.lines.length > 0,
    canResume: !deps.blocked && !work,
    park: () => void parkNow("header"),
    /** W-1184: a leave parks the open sale; `ok` is true only when the server stored it. */
    parkForLeave: async () => {
      lastParked.current = null;
      const ok = await parkNow("header");
      return { ok, parked: ok ? (lastParked.current as ParkedNote | null) : null };
    },
    startResume,
    choose: (c: ParkChoice) => void choose(c),
    discard: (id: string) => void discard(id),
  };
}

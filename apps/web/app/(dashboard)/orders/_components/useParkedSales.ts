"use client";

// SA-748: the logic behind the counter's Park button and Parked (n) list. The screen owns the cart; this hook only reads it
// (through `cart`), asks the server to keep or hand back a parked copy, and tells the screen to clear (`onParked`) or restore
// (`onRestore`). Nothing here prices anything or reserves stock, and no sale key is minted: that happens at Complete.
import * as React from "react";
import type { ParkedCartPayload } from "@routeflow/pricing";
import { useDiscard, useParkedCarts, usePark, useResume } from "@/lib/api/counter-park";
import {
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
  /** the screen is busy or locked (sale in flight, scan waiting, a price lookup, an unknown outcome, a ship hand-off) */
  blocked: boolean;
  /** the handler-side truth for a sale POST in flight (a render may not have caught up yet) */
  inFlight: () => boolean;
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
  const [work, setWork] = React.useState<ParkWork>(null);
  const [open, setOpenState] = React.useState(false);
  // the parked sale the clerk asked to resume while the current cart still has lines
  const [prompt, setPrompt] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<ParkMessage>(null);

  const canAct = () => !d.current.blocked && !d.current.inFlight() && !workRef.current;
  const begin = (w: NonNullable<ParkWork>) => {
    workRef.current = true;
    setWork(w);
    setMessage(null);
  };
  const end = () => {
    workRef.current = false;
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
      await parkM.mutateAsync(built.value);
      d.current.onParked(); // only now: a failed park leaves the cart untouched
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
    startResume,
    choose: (c: ParkChoice) => void choose(c),
    discard: (id: string) => void discard(id),
  };
}

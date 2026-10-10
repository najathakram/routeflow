"use client";

import * as React from "react";
import { sendOrderReceiptEmail } from "@/lib/api/receipts";
import {
  isValidReceiptEmail,
  isFinalReceiptEmailPhase,
  receiptEmailFailureOf,
  type ReceiptEmailFailure,
} from "@/lib/email-receipt";

export type EmailReceiptPhase = "idle" | "sending" | "sent" | ReceiptEmailFailure;

/** `navigator.onLine`, live: the Send button is disabled (and says why) while the till is offline. Nothing is queued. */
function useOnline(): boolean {
  const [online, setOnline] = React.useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  React.useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * Digital receipt (SA-751r): the state of the "Email receipt" control that sits beside Print on the receipt and Reprint views.
 * The row is NOT open by default; a pre-filled address is never sent on its own; a send never blocks the next sale (nothing
 * here touches the screen's own state). The button and the inline row are two components over this one state, because the
 * button lives in the screen's button row and the row sits under it.
 */
export function useEmailReceipt({ orderId, prefill }: { orderId: string; prefill: string }) {
  const [open, setOpen] = React.useState(false);
  const [address, setAddress] = React.useState(prefill);
  const [edited, setEdited] = React.useState(false);
  const [blurred, setBlurred] = React.useState(false);
  const [phase, setPhase] = React.useState<EmailReceiptPhase>("idle");
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [sentOnce, setSentOnce] = React.useState(false);
  const online = useOnline();
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const sendRef = React.useRef<HTMLButtonElement>(null);
  const sendingRef = React.useRef(false);

  const trimmed = address.trim();
  const valid = isValidReceiptEmail(trimmed);

  // Opening: a valid pre-fill puts the cashier on Send (one press); an empty or bad field puts them in the field.
  React.useEffect(() => {
    if (!open) return;
    (valid ? sendRef.current : inputRef.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the row opens
  }, [open]);

  const openRow = React.useCallback(() => {
    if (open) {
      // already open: bring the cashier back to where they act
      (valid ? sendRef.current : inputRef.current)?.focus();
      return;
    }
    if (!edited) setAddress(prefill);
    setOpen(true);
  }, [edited, prefill, open, valid]);

  const close = React.useCallback(() => {
    setOpen(false);
    setPhase((p) => (isFinalReceiptEmailPhase(p) ? p : "idle"));
    setBlurred(false);
    buttonRef.current?.focus();
  }, []);

  const send = React.useCallback(async () => {
    if (
      sendingRef.current ||
      !valid ||
      !online ||
      phase === "addressLimit" ||
      isFinalReceiptEmailPhase(phase)
    )
      return;
    const to = trimmed;
    sendingRef.current = true;
    setPhase("sending");
    try {
      await sendOrderReceiptEmail(orderId, to);
      setSentTo(to);
      setSentOnce(true);
      setPhase("sent");
    } catch (err) {
      setPhase(receiptEmailFailureOf(err));
    } finally {
      sendingRef.current = false;
    }
  }, [orderId, trimmed, valid, online, phase]);

  const changeAddress = React.useCallback((value: string) => {
    setAddress(value);
    setEdited(true);
    // a new address is a new attempt: a sent / failed line about the old one no longer applies (a limit is about the order, so it stays)
    setPhase((p) => (p === "sent" || p === "failed" || p === "addressLimit" ? "idle" : p));
  }, []);

  return {
    open,
    address,
    valid,
    showInvalid: blurred && trimmed.length > 0 && !valid,
    phase,
    sentTo,
    sentOnce,
    online,
    /** a limit, or a sale voided since the view opened, is final: no retry control is shown */
    atLimit: isFinalReceiptEmailPhase(phase),
    /** the cap is on THIS address: Send stays off until the cashier types another */
    addressCapped: phase === "addressLimit",
    buttonRef,
    inputRef,
    sendRef,
    openRow,
    close,
    send,
    changeAddress,
    blur: () => setBlurred(true),
  };
}

export type EmailReceiptState = ReturnType<typeof useEmailReceipt>;

"use client";

import * as React from "react";
import { Button, cn } from "@routeflow/ui/web";
import { RECEIPT_EMAIL_COPY as COPY } from "@/lib/email-receipt";
import type { EmailReceiptState } from "./useEmailReceipt";

/** The receipt's own controls: a full 44 px target with a visible keyboard focus ring (same as Print / New sale). */
const BTN = "min-h-[44px] min-w-[44px] focus-visible:ring-2 focus-visible:ring-navy print:hidden";

/** "Email receipt": the secondary button right after Print. Print stays the one primary. */
export function EmailReceiptButton({
  email,
  disabled,
}: {
  email: EmailReceiptState;
  /** the receipt is not on screen yet (a reprint still loading): there is nothing to email */
  disabled?: boolean;
}) {
  return (
    <Button
      ref={email.buttonRef}
      className={BTN}
      variant="secondary"
      disabled={disabled}
      aria-expanded={email.open}
      aria-controls="email-receipt-row"
      onClick={email.openRow}
    >
      {COPY.button}
    </Button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

/**
 * The inline row under the buttons (no modal, sheet or toast). Enter sends, Escape closes it and returns focus to "Email
 * receipt". At 390 the field is full width and Send is on its own 44 px line.
 */
export function EmailReceiptRow({ email: e }: { email: EmailReceiptState }) {
  if (!e.open) return null;
  const sending = e.phase === "sending";
  const sendLabel = sending
    ? COPY.sending
    : e.phase === "failed"
      ? COPY.tryAgain
      : e.sentOnce
        ? COPY.sendAgain
        : COPY.send;
  const invalidId = "email-receipt-invalid";
  return (
    <div
      id="email-receipt-row"
      role="group"
      aria-label={COPY.button}
      data-email-receipt-row
      className="w-full space-y-2 print:hidden"
      onKeyDown={(ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        e.close();
      }}
    >
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-start"
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          void e.send();
        }}
      >
        <input
          ref={e.inputRef}
          type="email"
          autoComplete="off"
          inputMode="email"
          aria-label={COPY.fieldLabel}
          aria-invalid={e.showInvalid}
          aria-describedby={e.showInvalid ? invalidId : undefined}
          placeholder={COPY.placeholder}
          readOnly={sending || e.atLimit}
          value={e.address}
          onChange={(ev) => e.changeAddress(ev.target.value)}
          onBlur={e.blur}
          className="min-h-[44px] w-full rounded border px-3 py-2 text-sm sm:flex-1"
        />
        {e.atLimit ? null : (
          <Button
            ref={e.sendRef}
            type="submit"
            className={cn(BTN, "w-full sm:w-auto")}
            disabled={!e.valid || sending || !e.online || e.addressCapped}
          >
            {sending ? <Spinner /> : null}
            {sendLabel}
          </Button>
        )}
      </form>
      {e.showInvalid ? (
        <p id={invalidId} className="text-sm text-red-700">
          {COPY.invalid}
        </p>
      ) : null}
      {!e.online ? (
        <p role="status" className="text-sm text-navy/70">
          {COPY.offline}
        </p>
      ) : null}
      {e.phase === "sent" && e.sentTo ? (
        <p role="status" className="text-sm text-navy/80">
          {COPY.sent(e.sentTo)}
        </p>
      ) : null}
      {e.phase === "failed" ? (
        <p role="alert" className="text-sm text-red-700">
          {COPY.failed}
        </p>
      ) : null}
      {e.phase === "orderLimit" ? (
        <p role="alert" className="text-sm text-red-700">
          {COPY.orderLimit}
        </p>
      ) : null}
      {e.phase === "dayLimit" ? (
        <p role="alert" className="text-sm text-red-700">
          {COPY.dayLimit}
        </p>
      ) : null}
      {e.phase === "addressLimit" ? (
        <p role="alert" className="text-sm text-red-700">
          {COPY.addressLimit}
        </p>
      ) : null}
      {e.phase === "unavailable" ? (
        <p role="alert" className="text-sm text-red-700">
          {COPY.unavailable}
        </p>
      ) : null}
    </div>
  );
}

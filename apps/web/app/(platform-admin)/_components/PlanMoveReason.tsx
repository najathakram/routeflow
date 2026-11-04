"use client";

import * as React from "react";
import { AdminModal } from "./AdminModal";

// R49: moving a business to another plan needs a reason (3 to 500 characters, written to the audit row by
// PATCH /platform-admin/tenants/:id/plan). One field, one rule, used by the tenant list's bulk move and by
// the tenant page's plan change.

export const PLAN_MOVE_REASON_MIN = 3;
export const PLAN_MOVE_REASON_MAX = 500;
export const PLAN_MOVE_REASON_LABEL = "Why is this business moving?";
export const PLAN_MOVE_REASON_ERROR = "Say why this business is moving (3 to 500 characters).";

/** The trimmed reason when it is 3 to 500 characters, else null. */
export function checkPlanMoveReason(text: string): string | null {
  const reason = text.trim();
  return reason.length >= PLAN_MOVE_REASON_MIN && reason.length <= PLAN_MOVE_REASON_MAX
    ? reason
    : null;
}

/**
 * The field's state. `validate()` runs on submit only: it returns the trimmed reason, or null after showing the
 * message under the field and moving focus to it. Typing clears the message.
 */
export function usePlanMoveReason() {
  const [value, setValueState] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const setValue = (next: string) => {
    setValueState(next);
    setError(null);
  };
  const validate = (): string | null => {
    const reason = checkPlanMoveReason(value);
    if (reason === null) {
      setError(PLAN_MOVE_REASON_ERROR);
      ref.current?.focus();
    }
    return reason;
  };
  const reset = () => {
    setValueState("");
    setError(null);
  };
  return { value, setValue, error, ref, validate, reset };
}

export function PlanMoveReasonField({
  state,
  disabled,
}: {
  state: ReturnType<typeof usePlanMoveReason>;
  disabled?: boolean;
}) {
  const id = React.useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  return (
    <div className="mb-3">
      <label id={labelId} htmlFor={id} className="mb-1 block text-sm text-slate-400">
        {PLAN_MOVE_REASON_LABEL}
      </label>
      <textarea
        id={id}
        aria-labelledby={labelId}
        ref={state.ref}
        rows={3}
        maxLength={PLAN_MOVE_REASON_MAX}
        value={state.value}
        disabled={disabled}
        onChange={(e) => state.setValue(e.target.value)}
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? errorId : undefined}
        className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
      />
      {state.error && (
        <p id={errorId} className="mt-1 text-xs text-red-400">
          {state.error}
        </p>
      )}
    </div>
  );
}

/**
 * The tenant page's plan move: asks for the reason, then hands it to `onSubmit`. Cancel (or Escape, or the
 * backdrop) calls `onCancel` and nothing is sent.
 */
export function PlanMoveReasonDialog({
  open,
  title,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const state = usePlanMoveReason();
  const { reset } = state;
  React.useEffect(() => {
    if (!open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <AdminModal
      open={open}
      onClose={onCancel}
      title={title}
      initialFocusRef={state.ref}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const reason = state.validate();
              if (reason !== null) onSubmit(reason);
            }}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
          >
            Change plan
          </button>
        </>
      }
    >
      <PlanMoveReasonField state={state} />
    </AdminModal>
  );
}

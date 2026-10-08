"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button, Input, Modal } from "@routeflow/ui/web";
import { checkCodeAvailable } from "@/lib/api/product-families";
import {
  BLOCKED_TAIL,
  CODE_NOUN,
  newCodeFields,
  reactivationResolveLabel,
  type ReactivationHolderView,
  type ReactivationRefusal,
  type ReplaceableCodeField,
} from "@/lib/product-reactivation-refusal";

export type NewCodes = Partial<Record<ReplaceableCodeField, string>>;

const TAKEN_MESSAGE = "That code is already used by another product.";
const OWN_CODE_MESSAGE = "That is this product's current code; choose a different one.";
const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();

const isCodeField = (f: string): f is ReplaceableCodeField => f in CODE_NOUN;

const HolderName = ({ h, link }: { h: ReactivationHolderView; link: boolean }) =>
  link && h.productId ? (
    <Link href={`/products/${h.productId}`} className="text-brand-600 underline underline-offset-2">
      {h.productName}
    </Link>
  ) : (
    <>{h.productName}</>
  );

/**
 * WS7: why a product could not be reactivated, and the way forward. Every line is mapped from the
 * 409's code + field (never the server message). Two ways out: the one-call "Deactivate <holder> and
 * reactivate this" (only when no holder is blocked) or, for a code clash, "Use a new code instead" — a
 * second step that reactivates THIS product with replacement codes and leaves the holders alone.
 */
export function ReactivateConflictDialog({
  refusal,
  productName,
  rejectedCodes,
  loading = false,
  onClose,
  onResolve,
  onResolveWithCodes,
  onRetry,
}: {
  /** null = closed. */
  refusal: ReactivationRefusal | null;
  /** The product being reactivated (named in the new-code step). */
  productName?: string;
  /** Codes the server refused on the last new-code submit (taken since the check): flagged inline, submit blocked. */
  rejectedCodes?: NewCodes | null;
  loading?: boolean;
  onClose: () => void;
  /** Resend the reactivation with `deactivateHolderIds` = these ids. */
  onResolve: (holderIds: string[]) => void;
  /** Resend the reactivation with replacement codes (no holder is deactivated). */
  onResolveWithCodes: (codes: NewCodes) => void;
  /** Retry kind (the stale-holder-set code): nothing blocks any more (or the set moved) — just try again. */
  onRetry: () => void;
}) {
  const [step, setStep] = React.useState<"choose" | "codes">("choose");
  const [values, setValues] = React.useState<NewCodes>({});
  const [hints, setHints] = React.useState<Partial<Record<ReplaceableCodeField, string>>>({});
  // Lower-cased values the availability check found taken, per field.
  const [takenValues, setTakenValues] = React.useState<NewCodes>({});
  const valuesRef = React.useRef<NewCodes>({});
  valuesRef.current = values;
  const firstInput = React.useRef<HTMLInputElement | null>(null);

  // A fresh refusal (e.g. the new code was taken meanwhile) starts over at the choice.
  React.useEffect(() => {
    setStep("choose");
    setValues({});
    setHints({});
    setTakenValues({});
  }, [refusal]);

  React.useEffect(() => {
    if (step === "codes") firstInput.current?.focus();
  }, [step]);

  if (!refusal) return null;

  if (refusal.kind === "RETRY") {
    return (
      <Modal
        open
        onClose={onClose}
        title="Can't reactivate yet"
        className="max-w-md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={loading}>
              Close
            </Button>
            <Button onClick={onRetry} loading={loading}>
              Try again
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          The products using this code or name just changed. Try reactivating again.
        </p>
      </Modal>
    );
  }

  const unique = refusal.holders.filter(
    (h, i) => h.productId && refusal.holders.findIndex((x) => x.productId === h.productId) === i,
  );
  const fields = newCodeFields(refusal);

  if (step === "codes" && fields) {
    const clashes = (f: ReplaceableCodeField) =>
      refusal.holders.filter((h) => h.field === f).map((h) => h.value.trim().toLowerCase());
    const ownCode = (f: ReplaceableCodeField) => clashes(f).includes(norm(values[f]));
    const takenElsewhere = (f: ReplaceableCodeField) =>
      norm(values[f]).length > 0 &&
      (norm(rejectedCodes?.[f]) === norm(values[f]) || takenValues[f] === norm(values[f]));
    const ready = fields.every(
      (f) => norm(values[f]).length > 0 && !ownCode(f) && !takenElsewhere(f),
    );
    // One inline line per field: the product's own code, a code the server refused, or the check's answer.
    const messageFor = (f: ReplaceableCodeField) => {
      if (ownCode(f)) return OWN_CODE_MESSAGE;
      if (norm(rejectedCodes?.[f]) === norm(values[f]) && norm(values[f])) return TAKEN_MESSAGE;
      if (hints[f]) return hints[f];
      return takenElsewhere(f) ? TAKEN_MESSAGE : undefined;
    };
    const submit = () => {
      if (!ready || loading) return;
      const codes: NewCodes = {};
      for (const f of fields) codes[f] = (values[f] ?? "").trim();
      onResolveWithCodes(codes);
    };
    const onBlur = async (f: ReplaceableCodeField) => {
      const value = (values[f] ?? "").trim();
      if (!value) return;
      const res = await checkCodeAvailable(value);
      // The answer is for THIS value: if it was edited while the check was in flight, drop it.
      if (!res || (valuesRef.current[f] ?? "").trim() !== value) return;
      const holder = res.takenBy
        ? refusal.holders.find((h) => h.productId === res.takenBy?.productId)
        : undefined;
      setTakenValues((prev) => ({ ...prev, [f]: res.available ? undefined : norm(value) }));
      setHints((prev) => ({
        ...prev,
        [f]: res.available
          ? `${value} is available.`
          : `${value} is already used by ${holder?.productName ?? "another product"}.`,
      }));
    };
    const others =
      unique.length === 1
        ? `"${unique[0].productName}" keeps its own.`
        : "The other products keep their own codes.";
    return (
      <Modal
        open
        onClose={onClose}
        title="Choose a new code"
        className="max-w-md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setStep("choose")} disabled={loading}>
              Back
            </Button>
            <Button onClick={submit} disabled={!ready} loading={loading}>
              Reactivate with new code
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="text-sm text-navy/70">
            {`${productName?.trim() || "This product"} will be reactivated with the new code. ${others}`}
          </p>
          {fields.map((f, i) => (
            <div key={f}>
              <Input
                ref={i === 0 ? firstInput : undefined}
                label={`New ${CODE_NOUN[f]}`}
                value={values[f] ?? ""}
                onChange={(e) => {
                  setValues((prev) => ({ ...prev, [f]: e.target.value }));
                  setHints((prev) => ({ ...prev, [f]: undefined }));
                }}
                onBlur={() => void onBlur(f)}
                autoComplete="off"
              />
              {messageFor(f) && (
                <p
                  role="status"
                  data-testid={`reactivate-code-message-${f}`}
                  className={`mt-1 text-xs ${
                    ownCode(f) || takenElsewhere(f) ? "text-danger" : "text-navy/70"
                  }`}
                >
                  {messageFor(f)}
                </p>
              )}
            </div>
          ))}
        </form>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Can't reactivate this product"
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Close
          </Button>
          {fields && (
            <Button onClick={() => setStep("codes")} disabled={loading}>
              Use a new code instead
            </Button>
          )}
          {refusal.canResolve && (
            <Button
              variant="danger"
              onClick={() => onResolve(refusal.holderIds)}
              loading={loading}
              data-testid="reactivate-resolve"
            >
              {reactivationResolveLabel(unique.map((h) => h.productName))}
            </Button>
          )}
        </>
      }
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <ul className="space-y-2 text-sm text-navy/70">
          {refusal.holders.map((h, i) => {
            // The holder is a link the first time it is named, plain text after that.
            const first =
              !h.productId || refusal.holders.findIndex((x) => x.productId === h.productId) === i;
            if (isCodeField(h.field)) {
              return (
                <li key={`${h.productId}-${i}`}>
                  The {CODE_NOUN[h.field]} &quot;{h.value}&quot; is now used by{" "}
                  <HolderName h={h} link={first} />.
                  {h.blocked && ` Blocked: ${h.productName} ${BLOCKED_TAIL}`}
                </li>
              );
            }
            return (
              <li key={`${h.productId}-${i}`}>
                {h.line}
                {first && h.productId && (
                  <>
                    {" "}
                    <HolderName h={h} link />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}

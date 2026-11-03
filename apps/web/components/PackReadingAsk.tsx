"use client";

import * as React from "react";
import { API_ERROR_CODES } from "@routeflow/types";
import { Button, Modal } from "@routeflow/ui/web";
import { DIALOG_FIT, DIALOG_FOOTER_BUTTON } from "@/components/dialog-mobile-fit";

export type PackReading = "box" | "piece";

const count = (n: number) => n.toLocaleString("en-US");
const boxes = (n: number) => `${count(n)} ${n === 1 ? "box" : "boxes"}`;
const pieces = (n: number) => `${count(n)} ${n === 1 ? "piece" : "pieces"}`;

/** SA-961 R1's question. With no stock to ask about, it asks about the number that would change: the cost. */
export function packReadingCopy(stock: number, n: number) {
  if (stock === 0) {
    return {
      question: `Is this product's cost for a box of ${n}, or for one piece?`,
      box: { label: "A box", preview: `Cost is divided by ${n}.` },
      piece: { label: "One piece", preview: "Cost stays as it is." },
    };
  }
  const after = Number((stock * n).toFixed(3));
  return {
    question: `Your stock shows ${count(stock)}. Is that ${boxes(stock)} or ${pieces(stock)}?`,
    box: {
      label: "Boxes",
      preview: `Stock will be ${pieces(after)} (${count(stock)} × ${n}), and cost is divided by ${n}.`,
    },
    piece: { label: "Pieces", preview: `Stock stays ${pieces(stock)}.` },
  };
}

const isPackReadingRequired = (e: unknown) =>
  (e as { response?: { data?: { code?: string } } })?.response?.data?.code ===
  API_ERROR_CODES.PACK_READING_REQUIRED;

type Asked = { stock: number; n: number; answer: (a: PackReading | null) => void };

/** The question's own state lives here: a re-render of the products list remounts its table, and an open cell with it. */
function PackReadingQuestion({
  opener,
}: {
  opener: React.MutableRefObject<((asked: Asked) => void) | null>;
}) {
  const [asked, setAsked] = React.useState<Asked | null>(null);
  React.useEffect(() => {
    opener.current = setAsked;
    return () => {
      opener.current = null;
    };
  }, [opener]);
  if (!asked) return null;
  const copy = packReadingCopy(asked.stock, asked.n);
  const finish = (a: PackReading | null) => {
    asked.answer(a);
    setAsked(null);
  };
  return (
    <Modal
      open
      onClose={() => finish(null)}
      title={copy.question}
      className={DIALOG_FIT}
      footer={
        // Neither is the default: only the person saving knows what the number was counted in.
        <>
          <Button
            variant="secondary"
            className={DIALOG_FOOTER_BUTTON}
            data-testid="pack-reading-box"
            onClick={() => finish("box")}
          >
            {copy.box.label}
          </Button>
          <Button
            variant="secondary"
            className={DIALOG_FOOTER_BUTTON}
            data-testid="pack-reading-piece"
            onClick={() => finish("piece")}
          >
            {copy.piece.label}
          </Button>
        </>
      }
    >
      <dl className="space-y-2 text-sm text-navy/70">
        <div>
          <dt className="font-medium text-navy">{copy.box.label}</dt>
          <dd className="tabular-nums">{copy.box.preview}</dd>
        </div>
        <div>
          <dt className="font-medium text-navy">{copy.piece.label}</dt>
          <dd className="tabular-nums">{copy.piece.preview}</dd>
        </div>
      </dl>
    </Modal>
  );
}

type Vars = { id: string; unitsPerBox?: unknown; [k: string]: unknown };
type Mutation = {
  mutate: (vars: Vars, options?: any) => void;
  mutateAsync: (vars: Vars) => Promise<unknown>;
};

/**
 * SA-946 MUST 4: a save that introduces a pack goes first, because the server holds the one rule for who has to answer
 * (its 409 writes nothing). The 409 opens the question; the answer re-sends the same save. Closing it saves nothing.
 */
export function usePackReadingSave(mutation: Mutation) {
  const opener = React.useRef<((asked: Asked) => void) | null>(null);
  const ask = (stock: number, vars: Vars) =>
    new Promise<PackReading | null>((answer) => {
      const open = opener.current;
      if (open) open({ stock, n: Number(vars.unitsPerBox), answer });
      else answer(null);
    });

  /** The mutation's own `mutate`, with the product's stock for the question. */
  const mutate = (vars: Vars, options: Record<string, any>, stock: number) =>
    mutation.mutate(vars, {
      ...options,
      onError: (e: unknown, ...rest: unknown[]) => {
        if (!isPackReadingRequired(e)) return options.onError?.(e, ...rest);
        void ask(stock, vars).then((packReading) => {
          if (packReading) mutation.mutate({ ...vars, packReading }, options);
        });
      },
    });

  /** Resolves with the answer given (null when none was needed), or null in place of a result when it was closed. */
  const mutateAsync = async (
    vars: Vars,
    stock: number,
  ): Promise<{ answered: PackReading | null } | null> => {
    try {
      await mutation.mutateAsync(vars);
      return { answered: null };
    } catch (e) {
      if (!isPackReadingRequired(e)) throw e;
    }
    const packReading = await ask(stock, vars);
    if (!packReading) return null;
    await mutation.mutateAsync({ ...vars, packReading });
    return { answered: packReading };
  };

  return { mutate, mutateAsync, dialog: <PackReadingQuestion opener={opener} /> };
}

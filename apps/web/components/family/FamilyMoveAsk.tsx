"use client";

import * as React from "react";
import type { FamilyMovePreviewDto } from "@routeflow/types";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { DIALOG_FIT, DIALOG_FOOTER_BUTTON } from "@/components/dialog-mobile-fit";
import { previewFamilyMove } from "@/lib/api/products";
import { formatMoney } from "@/lib/format";

/** The names shown before the list says how many more. */
const NAMES_SHOWN = 5;

/** What the save carries. Null: the person closed the question, so nothing is saved. */
export type FamilyMoveAnswer = { moveVariantIds?: string[] } | null;

type FamilyPrices = Record<string, unknown>;

const variantWord = (n: number) => (n === 1 ? "variant" : "variants");

/** SA-1082 ruling 2's question. Packs that differ have different numbers, so they're named in the list instead. */
export function familyMoveQuestion(p: FamilyMovePreviewDto): string {
  const sameNumbers = p.variants.every(
    (v) => v.from === p.variants[0]?.from && v.to === p.variants[0]?.to,
  );
  const first = p.variants[0];
  const subject = p.count === 1 ? "the variant" : `the ${p.count} variants`;
  if (sameNumbers && first && first.from !== first.to) {
    return `Move ${subject} at ${formatMoney(first.from)} to ${formatMoney(first.to)}?`;
  }
  return `Move ${subject} at the family's prices?`;
}

/** The toast line after a save that named variants. Fewer than asked means some changed since the question. */
export function familyMoveResult(asked: number, moved: number | undefined): string | undefined {
  if (asked === 0 || moved == null) return undefined;
  if (moved === asked) return `${moved} ${variantWord(moved)} moved.`;
  return `${moved} of ${asked} variants moved. The others changed since you were asked, so they kept their prices.`;
}

type Asked = { preview: FamilyMovePreviewDto; answer: (a: FamilyMoveAnswer) => void };

/** The question's own state lives here: a re-render of the products list remounts its table, and an open cell with it. */
function FamilyMoveQuestion({
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
  const { preview } = asked;
  const finish = (a: FamilyMoveAnswer) => {
    asked.answer(a);
    setAsked(null);
  };
  return (
    <Modal
      open
      onClose={() => finish(null)}
      title={familyMoveQuestion(preview)}
      className={DIALOG_FIT}
      footer={
        <>
          <Button
            variant="secondary"
            className={DIALOG_FOOTER_BUTTON}
            data-testid="family-move-keep"
            onClick={() => finish({})}
          >
            Keep their prices
          </Button>
          <Button
            variant="primary"
            className={DIALOG_FOOTER_BUTTON}
            data-testid="family-move-confirm"
            onClick={() => finish({ moveVariantIds: preview.variants.map((v) => v.id) })}
          >
            Move them
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">Variants with a different price stay as they are.</p>
      <ul data-testid="family-move-list" className="mt-3 space-y-1 text-sm text-navy">
        {preview.variants.slice(0, NAMES_SHOWN).map((v) => (
          <li key={v.id} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 break-words">{v.name}</span>
            <span className="shrink-0 tabular-nums text-navy/70">
              {v.from === v.to
                ? formatMoney(v.to)
                : `${formatMoney(v.from)} to ${formatMoney(v.to)}`}
            </span>
          </li>
        ))}
        {preview.count > NAMES_SHOWN && (
          <li className="text-navy/70">and {preview.count - NAMES_SHOWN} more</li>
        )}
      </ul>
    </Modal>
  );
}

/**
 * SA-1082 A-1: each family save that changes a price asks first. `ask` reads who's at the family's price and resolves with
 * what the save should carry: no question when nobody is, the ids on Move them, none on Keep their prices, null when
 * closed or when the read fails, because a save that couldn't ask must not go ahead as if it had.
 */
export function useFamilyMoveAsk(): {
  ask: (familyId: string, prices: FamilyPrices) => Promise<FamilyMoveAnswer>;
  dialog: React.ReactNode;
} {
  const { toast } = useToast();
  const opener = React.useRef<((asked: Asked) => void) | null>(null);

  const ask = React.useCallback(
    async (familyId: string, prices: FamilyPrices): Promise<FamilyMoveAnswer> => {
      let preview: FamilyMovePreviewDto;
      try {
        preview = await previewFamilyMove(familyId, prices);
      } catch {
        toast({
          title: "Couldn't save the family price",
          description: "We couldn't check its variants. Nothing changed. Try again.",
          variant: "error",
        });
        return null;
      }
      if (preview.count === 0) return {};
      const open = opener.current;
      return open ? new Promise((answer) => open({ preview, answer })) : null;
    },
    [toast],
  );

  return { ask, dialog: <FamilyMoveQuestion opener={opener} /> };
}

import { useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../../components/FormSheet";
import { usePurchaseOrder, useReceivePO } from "../../../../lib/api/purchase-orders";
import { normalizeBoxesPieces } from "../../../../lib/pricing";
import { showToast } from "../../../../lib/toast";

/** Prisma Decimals arrive as strings; subtraction needs rounding to the column's 3dp. */
function remainingOf(qtyOrdered: number | string, qtyReceived: number | string): number {
  return Math.max(0, Math.round((Number(qtyOrdered) - Number(qtyReceived)) * 1000) / 1000);
}

export default function ReceivePOScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: po } = usePurchaseOrder(id ?? "");
  const mut = useReceivePO();

  // Per-item inputs. Boxed products (unitsPerBox > 1) collect boxes + loose
  // pieces instead of one ambiguous number — an operator typing a box count
  // into a field the server reads as PIECES is what drove on-hand stock
  // hugely negative. Non-boxed items keep the single pieces input.
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [boxQtys, setBoxQtys] = useState<Record<string, string>>({});
  const [pieceQtys, setPieceQtys] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  const upbOf = (item: { product?: { unitsPerBox?: number | null } }) =>
    Math.trunc(Number(item.product?.unitsPerBox ?? 0));

  const seededSplit = (remaining: number, unitsPerBox: number) =>
    normalizeBoxesPieces({ qty: remaining, unitsPerBox });

  const getQty = (itemId: string, remaining: number) =>
    itemId in qtys ? qtys[itemId] : String(remaining);
  const getBoxes = (itemId: string, remaining: number, upb: number) =>
    itemId in boxQtys ? boxQtys[itemId] : String(seededSplit(remaining, upb).boxes ?? 0);
  const getPieces = (itemId: string, remaining: number, upb: number) =>
    itemId in pieceQtys ? pieceQtys[itemId] : String(seededSplit(remaining, upb).pieces ?? 0);

  const submit = () => {
    if (!id || !po) return;

    const items = po.items.map((item) => {
      const upb = upbOf(item);
      const remaining = remainingOf(item.qtyOrdered, item.qtyReceived);
      if (upb > 1) {
        const boxes = Number(getBoxes(item.id, remaining, upb));
        const pieces = Number(getPieces(item.id, remaining, upb));
        return {
          itemId: item.id,
          boxes: Number.isFinite(boxes) ? Math.max(0, Math.trunc(boxes)) : 0,
          pieces: Number.isFinite(pieces) ? Math.max(0, Math.trunc(pieces)) : 0,
        };
      }
      const n = Number(getQty(item.id, remaining));
      return { itemId: item.id, qtyReceived: Number.isFinite(n) ? n : 0 };
    });

    const hasPositive = items.some(
      (i) =>
        ("qtyReceived" in i && (i.qtyReceived ?? 0) > 0) || (i.boxes ?? 0) + (i.pieces ?? 0) > 0,
    );
    if (!hasPositive) {
      showToast("Enter a quantity for at least one item.");
      return;
    }

    mut.mutate(
      { id, dto: { items, notes: notes.trim() || undefined } },
      {
        onSuccess: () => {
          showToast("Items received");
          router.back();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="Receive Items"
      subtitle={po?.poNumber}
      submitLabel={mut.isPending ? "Saving…" : "Confirm receipt"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Items">
        {(po?.items ?? []).map((item) => {
          const productName = item.product?.name ?? `Product ${item.productId}`;
          const upb = upbOf(item);
          const remaining = remainingOf(item.qtyOrdered, item.qtyReceived);
          const hint = `Ordered: ${Number(item.qtyOrdered)} · Previously received: ${Number(
            item.qtyReceived,
          )} · Remaining: ${remaining}`;

          if (upb > 1) {
            const totalPieces = normalizeBoxesPieces({
              boxes: Number(getBoxes(item.id, remaining, upb)) || 0,
              pieces: Number(getPieces(item.id, remaining, upb)) || 0,
              unitsPerBox: upb,
            }).qty;
            return (
              <FormField
                key={item.id}
                label={productName}
                hint={`${hint} · 1 box = ${upb} pcs · receiving ${totalPieces} pcs`}
              >
                <FormTextInput
                  value={getBoxes(item.id, remaining, upb)}
                  onChangeText={(v) => setBoxQtys((prev) => ({ ...prev, [item.id]: v }))}
                  placeholder="Boxes"
                  keyboardType="number-pad"
                />
                <FormTextInput
                  value={getPieces(item.id, remaining, upb)}
                  onChangeText={(v) => setPieceQtys((prev) => ({ ...prev, [item.id]: v }))}
                  placeholder="+ loose pieces"
                  keyboardType="number-pad"
                  style={{ marginTop: 8 }}
                />
              </FormField>
            );
          }

          return (
            <FormField key={item.id} label={productName} hint={hint}>
              <FormTextInput
                value={getQty(item.id, remaining)}
                onChangeText={(v) => setQtys((prev) => ({ ...prev, [item.id]: v }))}
                placeholder="0"
                keyboardType="number-pad"
              />
            </FormField>
          );
        })}
      </FormSection>

      <FormSection title="Notes">
        <FormField label="Notes (optional)">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Any delivery notes…"
            multiline
            numberOfLines={3}
            style={{ minHeight: 72, textAlignVertical: "top" }}
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}

import { useState } from "react";
import { Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  FormField,
  FormSection,
  FormSheet,
  FormTextInput,
} from "../../../../components/FormSheet";
import {
  usePurchaseOrder,
  useReceivePO,
} from "../../../../lib/api/purchase-orders";
import { showToast } from "../../../../lib/toast";

export default function ReceivePOScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: po } = usePurchaseOrder(id ?? "");
  const mut = useReceivePO();

  // Initialise qty inputs to remaining qty for each item
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  const getQty = (itemId: string, qtyOrdered: number, qtyReceived: number) => {
    if (itemId in qtys) return qtys[itemId];
    const remaining = Math.max(0, qtyOrdered - qtyReceived);
    return String(remaining);
  };

  const setQty = (itemId: string, value: string) =>
    setQtys((prev) => ({ ...prev, [itemId]: value }));

  const submit = () => {
    if (!id || !po) return;

    const items = po.items.map((item) => {
      const raw = getQty(item.id, item.qtyOrdered, item.qtyReceived);
      const n = Number(raw);
      return { itemId: item.id, qtyReceived: Number.isFinite(n) ? n : 0 };
    });

    const hasPositive = items.some((i) => i.qtyReceived > 0);
    if (!hasPositive) {
      Alert.alert("No items", "Enter a quantity for at least one item.");
      return;
    }

    mut.mutate(
      { id, dto: { items, notes: notes.trim() || undefined } },
      {
        onSuccess: () => {
          showToast("Items received");
          router.back();
        },
        onError: (e: any) =>
          Alert.alert(
            "Couldn't receive",
            e?.response?.data?.message ?? e?.message ?? "Try again.",
          ),
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
          const remaining = Math.max(0, item.qtyOrdered - item.qtyReceived);
          return (
            <FormField
              key={item.id}
              label={productName}
              hint={`Ordered: ${item.qtyOrdered} · Previously received: ${item.qtyReceived} · Remaining: ${remaining}`}
            >
              <FormTextInput
                value={getQty(item.id, item.qtyOrdered, item.qtyReceived)}
                onChangeText={(v) => setQty(item.id, v)}
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

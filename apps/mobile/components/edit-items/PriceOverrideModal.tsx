// #2340 prefactor: moved verbatim out of app/(operator)/(tabs)/orders/[id]/edit-items.tsx
// (size ratchet, plan #2328 R1). Behaviour-neutral — no logic changed in the move.
import { useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { unitPriceBase } from "../../lib/unit-options";
import { roundMoney } from "@routeflow/pricing";
import type { DraftItem } from "../../lib/edit-items-draft";
import { toNumber } from "../../lib/cart-line-state";
import { styles } from "./styles";

// ─── Price override modal ────────────────────────────────────────────────────

export function PriceOverrideModal({
  item,
  onSave,
  onCancel,
  isSpecial = false,
}: {
  item: DraftItem;
  onSave: (newPrice: number, reason: string) => void;
  onCancel: () => void;
  /** B465: this customer's documented contract price for the product — a
   *  reason is REQUIRED to override it here, never optional like a plain
   *  line. `canEditPriceFor` already hides this modal's own trigger for a
   *  SPECIAL line today; this is defense-in-depth for any path that reaches
   *  it, mirroring the server's own refusal and the web reference. */
  isSpecial?: boolean;
}) {
  // units_v1: see lib/unit-options.ts#unitPriceBase — same reasoning as the card's own priceBase.
  const priceBase = unitPriceBase(item, item.catalogPrice);
  const [priceText, setPriceText] = useState(item.unitPrice.toFixed(2));
  // "$ off / unit" is a lens over (priceBase - newPrice); the two inputs stay in sync.
  const [offText, setOffText] = useState(
    item.unitPrice < priceBase ? roundMoney(priceBase - item.unitPrice).toFixed(2) : "",
  );
  const [reason, setReason] = useState(item.overrideReason ?? "");
  const newPrice = toNumber(priceText);
  const reasonMissing = isSpecial && reason.trim() === "";
  const valid = newPrice > 0 && !reasonMissing;

  const onChangePrice = (raw: string) => {
    setPriceText(raw);
    const parsed = parseFloat(raw);
    if (raw.trim() === "" || isNaN(parsed)) {
      setOffText("");
      return;
    }
    setOffText(parsed < priceBase ? roundMoney(priceBase - parsed).toFixed(2) : "");
  };

  const onChangeOff = (raw: string) => {
    setOffText(raw);
    const off = parseFloat(raw);
    if (raw.trim() === "" || isNaN(off) || off <= 0) {
      setPriceText(priceBase.toFixed(2));
      return;
    }
    setPriceText(roundMoney(Math.max(0, priceBase - off)).toFixed(2));
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.modalOverlay} onPress={onCancel}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>Override price</Text>
          <Text style={styles.modalSub}>{item.name}</Text>
          <Text style={styles.modalLabel}>List price: ${priceBase.toFixed(2)}</Text>

          <Text style={styles.modalFieldLabel}>New unit price</Text>
          <TextInput
            style={styles.modalInput}
            value={priceText}
            onChangeText={onChangePrice}
            keyboardType="decimal-pad"
            selectTextOnFocus
            autoFocus
            placeholder="0.00"
            placeholderTextColor={ios.label3}
          />

          <Text style={styles.modalFieldLabel}>Amount off / unit</Text>
          <TextInput
            style={styles.modalInput}
            value={offText}
            onChangeText={onChangeOff}
            keyboardType="decimal-pad"
            selectTextOnFocus
            placeholder="0.00"
            placeholderTextColor={ios.label3}
          />

          <Text style={styles.modalFieldLabel}>
            {isSpecial ? "Reason (required)" : "Reason (optional)"}
          </Text>
          <TextInput
            style={[
              styles.modalInput,
              { marginBottom: 16 },
              reasonMissing ? styles.modalInputError : null,
            ]}
            value={reason}
            onChangeText={setReason}
            placeholder={isSpecial ? "e.g. manager approved" : "e.g. daily market price"}
            placeholderTextColor={reasonMissing ? ios.system.red : ios.label3}
          />

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onCancel}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onSave(newPrice, reason)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Apply</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

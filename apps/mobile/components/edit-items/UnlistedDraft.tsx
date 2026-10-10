// #2340 prefactor: moved verbatim out of app/(operator)/(tabs)/orders/[id]/edit-items.tsx
// (size ratchet, plan #2328 R1). Behaviour-neutral — no logic changed in the move.
import { useEffect, useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { computeLineSubtotal } from "@routeflow/pricing";
import type { UnlistedDraft } from "../../lib/edit-items-draft";
import { sanitizeIntInput } from "../../lib/qty";
import { StepperRow } from "../../components/EditItemsStepperRow";
import { MoneyTextInput } from "../../components/MoneyTextInput";
import { styles } from "./styles";

// ─── Unlisted draft card ─────────────────────────────────────────────────────

/**
 * Card for an ad-hoc (unlisted) line: editable free-text name + price + qty,
 * a "Custom" tag, and no product image (it isn't in the catalog).
 */
export function UnlistedDraftCard({
  line,
  onSetName,
  onSetNote,
  onSetPrice,
  onSetQty,
  onRemove,
}: {
  line: UnlistedDraft;
  onSetName: (name: string) => void;
  onSetNote: (notes: string) => void;
  onSetPrice: (value: number | null) => void;
  onSetQty: (n: number) => void;
  onRemove: () => void;
}) {
  const [noteOpen, setNoteOpen] = useState(Boolean(line.notes?.trim()));
  const lineTotal = computeLineSubtotal({ unitPrice: line.unitPrice, qty: line.qty });
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.unlistedTagRow}>
            <View style={styles.customTag}>
              <Text style={styles.customTagText}>Custom</Text>
            </View>
          </View>
          <TextInput
            style={styles.unlistedNameInput}
            value={line.name}
            onChangeText={onSetName}
            placeholder="Item name"
            placeholderTextColor={ios.label3}
          />
          <View style={styles.unlistedPriceRow}>
            <Text style={styles.cardMeta}>$</Text>
            <MoneyTextInput
              style={styles.unlistedPriceInput}
              value={line.unitPrice || null}
              onChangeValue={onSetPrice}
              placeholder="0.00"
              placeholderTextColor={ios.label3}
            />
            <Text style={styles.cardMeta}>/ unit</Text>
          </View>
        </View>
        <Text style={styles.cardTotal}>${lineTotal.toFixed(2)}</Text>
      </View>

      <StepperRow
        label="Qty"
        value={line.qty}
        onChange={onSetQty}
        onIncrement={() => onSetQty(line.qty + 1)}
        onDecrement={() => onSetQty(Math.max(0, line.qty - 1))}
      />

      {/* Flavor / note (R5.3) */}
      {noteOpen || line.notes?.trim() ? (
        <TextInput
          value={line.notes ?? ""}
          onChangeText={onSetNote}
          placeholder="Flavor or note for this item (prints on invoice)"
          placeholderTextColor={ios.label3}
          maxLength={2000}
          multiline
          style={styles.cartNoteInput}
        />
      ) : (
        <Pressable onPress={() => setNoteOpen(true)} hitSlop={6} style={styles.cartNoteAdd}>
          <Ionicons name="create-outline" size={14} color={ios.brand} />
          <Text style={styles.cartNoteAddText}>Add flavor / note</Text>
        </Pressable>
      )}

      <View style={styles.cardActions}>
        <View style={{ flex: 1 }} />
        <Pressable style={styles.deleteBtn} onPress={onRemove} hitSlop={6}>
          <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
        </Pressable>
      </View>
    </View>
  );
}

// ─── Unlisted item modal ─────────────────────────────────────────────────────

export function UnlistedItemModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (name: string, unitPrice: number, qty: number) => void;
}) {
  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [qtyText, setQtyText] = useState("1");

  useEffect(() => {
    if (open) {
      setName("");
      setPriceText("");
      setQtyText("1");
    }
  }, [open]);

  const price = parseFloat(priceText);
  const qty = parseInt(qtyText || "0", 10);
  const valid = name.trim() !== "" && Number.isFinite(price) && price > 0 && qty > 0;

  if (!open) return null;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>Add unlisted item</Text>
          <Text style={styles.modalSub}>A one-off line that isn't in your catalog.</Text>

          <Text style={styles.modalFieldLabel}>Item name</Text>
          <TextInput
            style={styles.modalInput}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Delivery surcharge"
            placeholderTextColor={ios.label3}
            autoFocus
          />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalFieldLabel}>Unit price</Text>
              <TextInput
                style={styles.modalInput}
                value={priceText}
                onChangeText={setPriceText}
                placeholder="0.00"
                placeholderTextColor={ios.label3}
                keyboardType="decimal-pad"
                selectTextOnFocus
              />
            </View>
            <View style={{ width: 96 }}>
              <Text style={styles.modalFieldLabel}>Qty</Text>
              <TextInput
                style={styles.modalInput}
                value={qtyText}
                onChangeText={(t) => setQtyText(sanitizeIntInput(t))}
                placeholder="1"
                placeholderTextColor={ios.label3}
                keyboardType="number-pad"
                maxLength={5}
                selectTextOnFocus
              />
            </View>
          </View>

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onAdd(name.trim(), price, qty)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Add to order</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

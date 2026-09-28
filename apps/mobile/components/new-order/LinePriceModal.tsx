// #2339: moved verbatim out of NewOrderScreen.tsx (a behaviour-preserving prefactor).
import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { MoneyTextInput } from "../MoneyTextInput";
import { styles } from "./styles";

/**
 * Reprice ONE line from the scan tray, without tearing the camera down.
 *
 * The create surface's only price editor used to be inside CartModal, i.e.
 * behind "Review" — so fixing a price mid-scan meant leaving scan mode and
 * coming back, while the order EDIT screen has offered a one-tap edit under
 * its scanner since B263. This is the create-side counterpart.
 *
 * Deliberately thin: it collects a number and hands it back. Rounding, the
 * SPECIAL-tier lock and the catalog-vs-unlisted split all live with the
 * caller, which already owns those rules.
 */
export function LinePriceModal({
  open,
  name,
  unitPrice,
  onClose,
  onSave,
}: {
  open: boolean;
  name: string;
  /** The price in force for this line right now. */
  unitPrice: number | null;
  onClose: () => void;
  /** `null` clears the override, so the line falls back to the catalog price. */
  onSave: (value: number | null) => void;
}) {
  const [value, setValue] = useState<number | null>(null);

  // Re-seed on every open — a different line each time.
  useEffect(() => {
    if (open) setValue(unitPrice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.unlistedOverlay} onPress={onClose}>
        <Pressable style={styles.unlistedCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.unlistedTitle} numberOfLines={2}>
            {name || "Edit price"}
          </Text>
          <Text style={styles.unlistedSub}>Price for this order only.</Text>

          <Text style={styles.unlistedFieldLabel}>Unit price</Text>
          <MoneyTextInput
            style={styles.unlistedInput}
            value={value}
            onChangeValue={setValue}
            placeholder="0.00"
            placeholderTextColor={ios.label3}
            returnKeyType="done"
            autoFocus
          />

          <View style={[styles.modalBtns, { marginTop: 4 }]}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={styles.modalBtnFill}
              onPress={() => onSave(value)}
              accessibilityRole="button"
              accessibilityLabel="Save price"
            >
              <Text style={styles.modalBtnFillText}>Save</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// #2339: moved verbatim out of NewOrderScreen.tsx (a behaviour-preserving prefactor).
import { useEffect, useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { useCreateCreditNote, type CreditNote } from "../../lib/api/credit-notes";
import { MoneyTextInput } from "../MoneyTextInput";
import { refundableCopy } from "../../lib/credit-note-error-copy";
import { styles } from "./styles";

/**
 * Compact inline "New credit note" sheet, opened from the Apply-credit
 * section when the operator needs a credit that doesn't exist yet — a
 * standalone credit for this order's customer (no invoice link). Mirrors
 * the compact-sheet structure of InlineCreateProductSheet.tsx.
 */
export function CreateCreditNoteSheet({
  visible,
  customerId,
  onClose,
  onCreated,
}: {
  visible: boolean;
  customerId: string;
  onClose: () => void;
  onCreated: (created: CreditNote) => void;
}) {
  const createMut = useCreateCreditNote();
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset fields whenever the sheet is (re)opened.
  useEffect(() => {
    if (visible) {
      setAmount(null);
      setReason("");
      setError(null);
    }
  }, [visible]);

  const valid = amount != null && amount > 0 && reason.trim() !== "";

  const submit = () => {
    if (!valid) return;
    setError(null);
    createMut.mutate(
      { customerId, amount: amount!, reason: reason.trim() },
      {
        onSuccess: (created) => onCreated(created),
        onError: (e: unknown) => {
          const err = e as { response?: { data?: { message?: string } }; message?: string };
          setError(
            refundableCopy(e) ??
              err?.response?.data?.message ??
              err?.message ??
              "Couldn't create credit note.",
          );
        },
      },
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.unlistedOverlay} onPress={onClose}>
        <Pressable style={styles.unlistedCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.unlistedTitle}>New credit note</Text>
          <Text style={styles.unlistedSub}>A standalone store credit for this customer.</Text>

          {error ? (
            <Text style={{ color: ios.system.redInk, fontSize: 12, marginBottom: 8 }}>{error}</Text>
          ) : null}

          <Text style={styles.unlistedFieldLabel}>Amount</Text>
          <MoneyTextInput
            style={styles.unlistedInput}
            value={amount}
            onChangeValue={setAmount}
            placeholder="0.00"
            placeholderTextColor={ios.label3}
            autoFocus
          />

          <Text style={styles.unlistedFieldLabel}>Reason</Text>
          <TextInput
            style={styles.unlistedInput}
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. Damaged goods"
            placeholderTextColor={ios.label3}
          />

          <View style={[styles.modalBtns, { marginTop: 4 }]}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[
                styles.modalBtnFill,
                (!valid || createMut.isPending) && styles.modalBtnDisabled,
              ]}
              onPress={submit}
              disabled={!valid || createMut.isPending}
            >
              <Text style={styles.modalBtnFillText}>
                {createMut.isPending ? "Creating…" : "Create"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

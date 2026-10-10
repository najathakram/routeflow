// #2340 prefactor: moved verbatim out of app/(operator)/(tabs)/orders/[id]/edit-items.tsx
// (size ratchet, plan #2328 R1). Behaviour-neutral — no logic changed in the move.
import { useEffect, useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { useCreateCreditNote, type CreditNote } from "../../lib/api/credit-notes";
import { MoneyTextInput } from "../../components/MoneyTextInput";
import { styles } from "./styles";

// ─── Inline "New credit note" create modal ───────────────────────────────────

/**
 * Compact inline credit-note create sheet, opened from the Apply-credit
 * section when the operator needs one that doesn't exist yet — a standalone
 * credit for this order's customer (no invoice link).
 */
export function CreateCreditNoteModal({
  open,
  customerId,
  onClose,
  onCreated,
}: {
  open: boolean;
  customerId: string;
  onClose: () => void;
  onCreated: (created: CreditNote) => void;
}) {
  const createMut = useCreateCreditNote();
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAmount(null);
      setReason("");
      setError(null);
    }
  }, [open]);

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
          setError(err?.response?.data?.message ?? err?.message ?? "Couldn't create credit note.");
        },
      },
    );
  };

  if (!open) return null;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>New credit note</Text>
          <Text style={styles.modalSub}>A standalone store credit for this customer.</Text>

          {error ? (
            <Text style={{ color: ios.system.redInk, fontSize: 12, marginBottom: 8 }}>{error}</Text>
          ) : null}

          <Text style={styles.modalFieldLabel}>Amount</Text>
          <MoneyTextInput
            style={styles.modalInput}
            value={amount}
            onChangeValue={setAmount}
            placeholder="0.00"
            placeholderTextColor={ios.label3}
            autoFocus
          />

          <Text style={styles.modalFieldLabel}>Reason</Text>
          <TextInput
            style={styles.modalInput}
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. Damaged goods"
            placeholderTextColor={ios.label3}
          />

          <View style={styles.modalBtns}>
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

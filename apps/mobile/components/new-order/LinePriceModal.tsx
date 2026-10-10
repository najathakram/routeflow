// #2339: moved verbatim out of NewOrderScreen.tsx (a behaviour-preserving prefactor).
import { useEffect, useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { MoneyTextInput } from "../MoneyTextInput";
import { decideTrayPrice } from "../../lib/staff-price-override";
import { styles } from "./styles";

/**
 * Reprice ONE line from the scan tray, without tearing the camera down.
 *
 * The create surface's only price editor used to be inside CartModal, i.e.
 * behind "Review" — so fixing a price mid-scan meant leaving scan mode and
 * coming back, while the order EDIT screen has offered a one-tap edit under
 * its scanner since B263. This is the create-side counterpart.
 *
 * Deliberately thin: it collects a number (and, #2696(c), a reason) and hands them back. Rounding
 * and the catalog-vs-unlisted split live with the caller. A special (tier) line's price may move
 * only with a reason — decided by `decideTrayPrice` (@routeflow/pricing's decideStaffOverride, the
 * server's own rule), so Save stays disabled exactly while the server would refuse.
 */
export function LinePriceModal({
  open,
  name,
  unitPrice,
  rule,
  onClose,
  onSave,
}: {
  open: boolean;
  name: string;
  /** The price in force for this line right now. */
  unitPrice: number | null;
  /** Catalog lines: the one-rule inputs. Absent for an unlisted line (no reason ever needed). */
  rule?: { base: number; listPrice: number; isSpecial: boolean; reason?: string };
  onClose: () => void;
  /** `null` clears the override, so the line falls back to the catalog price. */
  onSave: (value: number | null, reason: string) => void;
}) {
  const [value, setValue] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  // Re-seed on every open — a different line each time.
  useEffect(() => {
    if (open) {
      setValue(unitPrice);
      setReason(rule?.reason ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const decision = rule ? decideTrayPrice({ typed: value, ...rule, reason }) : null;
  const refused = decision?.kind === "refused";
  // A Reason field whenever the typed price is a real override on a catalog line.
  const showReason = !!rule && decision != null && decision.kind !== "clear";
  const reasonLabel = rule?.isSpecial ? "Reason (required)" : "Reason (optional)";

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.unlistedOverlay} onPress={onClose}>
        <Pressable style={styles.unlistedCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.unlistedTitle} numberOfLines={2}>
            {name || "Edit price"}
          </Text>
          <Text style={styles.unlistedSub}>
            {rule?.isSpecial
              ? `Special price $${rule.base.toFixed(2)} for this customer.`
              : "Price for this order only."}
          </Text>

          <Text style={styles.unlistedFieldLabel}>Unit price</Text>
          <MoneyTextInput
            style={styles.unlistedInput}
            value={value}
            onChangeValue={setValue}
            placeholder={rule ? rule.base.toFixed(2) : "0.00"}
            placeholderTextColor={ios.label3}
            returnKeyType="done"
            autoFocus
          />

          {showReason && (
            <>
              <Text style={styles.unlistedFieldLabel}>{reasonLabel}</Text>
              <TextInput
                style={styles.unlistedInput}
                value={reason}
                onChangeText={setReason}
                maxLength={200}
                placeholder="e.g. dented cans, manager approved"
                placeholderTextColor={ios.label3}
                accessibilityLabel={reasonLabel}
              />
              {refused && (
                <Text style={[styles.unlistedSub, { color: ios.system.redInk }]}>
                  This changes the customer&apos;s special price — say why.
                </Text>
              )}
            </>
          )}

          <View style={[styles.modalBtns, { marginTop: 4 }]}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, refused && { opacity: 0.4 }]}
              onPress={() => onSave(value, reason)}
              disabled={refused}
              accessibilityRole="button"
              accessibilityLabel="Save price"
              accessibilityState={{ disabled: refused }}
            >
              <Text style={styles.modalBtnFillText}>Save</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { useConfirmStore } from "../lib/confirm-store";

export function ConfirmModal() {
  const { visible, title, message, confirmText, destructive, onConfirm, hide } =
    useConfirmStore();

  const handleConfirm = () => {
    hide();
    onConfirm();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={hide}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={hide} />
      <View style={styles.container} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          {message ? <Text style={styles.message}>{message}</Text> : null}
          <View style={styles.actions}>
            <Pressable style={[styles.btn, styles.cancelBtn]} onPress={hide}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <View style={styles.divider} />
            <Pressable
              style={[styles.btn, styles.confirmBtn]}
              onPress={handleConfirm}
            >
              <Text
                style={[styles.confirmText, destructive && styles.destructiveText]}
              >
                {confirmText}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
  },
  card: {
    width: "100%",
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    overflow: "hidden",
  },
  title: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
    paddingTop: 20,
    paddingHorizontal: 16,
  },
  message: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    paddingTop: 6,
    paddingBottom: 20,
    paddingHorizontal: 16,
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  btn: {
    flex: 1,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtn: {},
  confirmBtn: {},
  divider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: ios.separator,
  },
  cancelText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.brand,
  },
  confirmText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
  },
  destructiveText: {
    color: ios.system.redInk,
  },
});

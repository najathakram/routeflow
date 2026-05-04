import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { useConfirmStore, type ConfirmAction } from "../lib/confirm-store";

/**
 * Cross-platform replacement for RN Alert.alert on web. Renders the action
 * list from the confirm-store as one button per action — supports the
 * "Cancel / Merge / Create separate" 3-button case the new-order screen
 * needs (RN Web's Alert.alert silently drops multi-button alerts, which is
 * why "Confirm" felt frozen — the prompt fired but never appeared).
 */
export function ConfirmModal() {
  const { visible, title, message, actions, hide } = useConfirmStore();

  // 1-2 buttons render side-by-side (iOS dialog convention); 3+ stack
  // vertically so labels never wrap.
  const stack = (actions?.length ?? 0) > 2;

  const handlePress = (action: ConfirmAction) => {
    hide();
    if (action.onPress) action.onPress();
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
          <View style={[styles.actions, stack && styles.actionsStack]}>
            {(actions ?? []).map((action, i) => {
              const isDestructive = action.style === "destructive";
              const isCancel = action.style === "cancel";
              const showDivider = i > 0;
              return (
                <View
                  key={`${action.label}-${i}`}
                  style={stack ? styles.stackItem : styles.rowItem}
                >
                  {showDivider ? (
                    <View
                      style={stack ? styles.dividerHorizontal : styles.dividerVertical}
                    />
                  ) : null}
                  <Pressable style={styles.btn} onPress={() => handlePress(action)}>
                    <Text
                      style={[
                        styles.actionText,
                        isCancel && styles.cancelText,
                        isDestructive && styles.destructiveText,
                      ]}
                    >
                      {action.label}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
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
    maxWidth: 380,
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

  // Side-by-side (1-2 actions): row with vertical dividers between buttons.
  actions: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  // Stacked (3+ actions): column with horizontal dividers between buttons.
  actionsStack: {
    flexDirection: "column",
  },
  rowItem: {
    flex: 1,
    flexDirection: "row",
  },
  stackItem: {
    width: "100%",
  },
  dividerVertical: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: ios.separator,
  },
  dividerHorizontal: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: ios.separator,
  },
  btn: {
    flex: 1,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
  },
  cancelText: {
    fontFamily: "Inter_400Regular",
  },
  destructiveText: {
    color: ios.system.redInk,
  },
});

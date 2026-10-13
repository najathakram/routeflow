import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  SALE_RECOVERY_COPY as COPY,
  saleRecovery,
  saleRecoveryBody,
  type UnknownSale,
} from "@routeflow/types/sale-attempt";
import { ios } from "@routeflow/ui/tokens";

/**
 * Row 485: shown while a New sale's outcome is UNKNOWN (a 5xx, a dropped connection, or an error that names a
 * committed order or invoice). The cart is locked behind it. Try again resends under the SAME Idempotency-Key;
 * Open order / Open invoice (or Check recent orders) lets the clerk look; Start a new sale asks the screen to
 * confirm first. Copy is the shared SALE_RECOVERY_COPY, the same strings the web New sale page shows.
 */
export function SaleUnknownPanel({
  unknown,
  busy,
  onTryAgain,
  onOpen,
  onStartNew,
}: {
  unknown: UnknownSale;
  busy: boolean;
  onTryAgain: () => void;
  onOpen: () => void;
  onStartNew: () => void;
}) {
  const recovery = saleRecovery(unknown);
  const openLabel =
    recovery.kind === "invoice"
      ? COPY.openInvoice
      : recovery.kind === "order"
        ? COPY.openOrder
        : COPY.recentOrders;
  return (
    <View style={styles.panel} accessibilityRole="alert" testID="sale-unknown">
      <Text style={styles.title}>{COPY.title}</Text>
      <Text style={styles.body}>{saleRecoveryBody(unknown)}</Text>
      <View style={styles.actions}>
        <Pressable
          style={[styles.primary, busy && styles.disabled]}
          disabled={busy}
          onPress={onTryAgain}
          accessibilityRole="button"
          accessibilityLabel={COPY.tryAgain}
        >
          <Text style={styles.primaryText}>{COPY.tryAgain}</Text>
        </Pressable>
        <Pressable
          style={[styles.secondary, busy && styles.disabled]}
          disabled={busy}
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={openLabel}
        >
          <Text style={styles.secondaryText}>{openLabel}</Text>
        </Pressable>
        <Pressable
          style={[styles.tertiary, busy && styles.disabled]}
          onPress={onStartNew}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={COPY.startNew}
        >
          <Text style={styles.tertiaryText}>{COPY.startNew}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#FFF7E6",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#F2C14E",
    gap: 6,
  },
  title: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  body: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 14, marginTop: 4 },
  primary: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  disabled: { opacity: 0.5 },
  // Every action is a >= 44pt-tall control: primary Try again, secondary open/check, tertiary Start a new sale.
  secondary: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ios.brand,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  tertiary: {
    minHeight: 44,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  tertiaryText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_500Medium" },
});

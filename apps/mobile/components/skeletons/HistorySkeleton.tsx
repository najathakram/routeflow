import { StyleSheet, View } from "react-native";
import { ShimmerBox } from "../Shimmer";
import { borderRadius, shadows } from "@routeflow/ui/tokens";

function SkeletonRow() {
  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <ShimmerBox style={styles.orderId} />
        <ShimmerBox style={styles.orderMeta} />
        <ShimmerBox style={styles.badge} />
      </View>
      <View style={styles.rowRight}>
        <ShimmerBox style={styles.total} />
        <ShimmerBox style={styles.chevron} />
      </View>
    </View>
  );
}

export function HistorySkeleton() {
  return (
    <View style={styles.container}>
      {/* Two date groups */}
      {[3, 2].map((count, gi) => (
        <View key={gi}>
          <ShimmerBox style={styles.sectionHeader} />
          {Array.from({ length: count }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 8,
  },
  sectionHeader: {
    height: 12,
    width: 120,
    borderRadius: 4,
    marginBottom: 10,
    marginTop: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderRadius: borderRadius.lg,
    padding: 16,
    marginBottom: 8,
    gap: 12,
    ...shadows.card,
  },
  rowLeft: {
    flex: 1,
    gap: 8,
  },
  orderId: {
    height: 16,
    width: "50%",
    borderRadius: 4,
  },
  orderMeta: {
    height: 13,
    width: "70%",
    borderRadius: 4,
  },
  badge: {
    height: 20,
    width: 80,
    borderRadius: 999,
  },
  rowRight: {
    alignItems: "flex-end",
    gap: 8,
  },
  total: {
    height: 18,
    width: 56,
    borderRadius: 4,
  },
  chevron: {
    height: 16,
    width: 12,
    borderRadius: 4,
  },
});

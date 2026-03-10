import { StyleSheet, View } from "react-native";
import { ShimmerBox } from "../Shimmer";
import { borderRadius, colors, shadows } from "@routeflow/ui/tokens";

function SkeletonStopRow() {
  return (
    <View style={styles.stopRow}>
      <ShimmerBox style={styles.bubble} />
      <View style={styles.details}>
        <ShimmerBox style={styles.business} />
        <ShimmerBox style={styles.address} />
        <ShimmerBox style={styles.itemCount} />
      </View>
      <ShimmerBox style={styles.statusIcon} />
    </View>
  );
}

export function RouteSkeleton() {
  return (
    <View style={styles.container}>
      {/* Header card */}
      <View style={styles.headerCard}>
        <View style={styles.headerTop}>
          <ShimmerBox style={styles.routeName} />
          <ShimmerBox style={styles.badge} />
        </View>
        <ShimmerBox style={styles.progressLabel} />
        <ShimmerBox style={styles.progressBar} />
      </View>

      {/* Stop list */}
      <View style={styles.list}>
        <ShimmerBox style={styles.stopsLabel} />
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonStopRow key={i} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerCard: {
    backgroundColor: colors.surface.raised,
    paddingHorizontal: 20,
    paddingVertical: 18,
    gap: 14,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  routeName: {
    height: 24,
    width: 140,
    borderRadius: 6,
  },
  badge: {
    height: 22,
    width: 90,
    borderRadius: 999,
  },
  progressLabel: {
    height: 14,
    width: 80,
    borderRadius: 4,
  },
  progressBar: {
    height: 8,
    borderRadius: 4,
  },
  list: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 8,
  },
  stopsLabel: {
    height: 12,
    width: 48,
    borderRadius: 4,
    marginBottom: 4,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface.DEFAULT,
    borderRadius: borderRadius.lg,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 14,
    minHeight: 80,
    marginBottom: 4,
    ...shadows.card,
  },
  bubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  details: {
    flex: 1,
    gap: 7,
  },
  business: {
    height: 17,
    width: "70%",
    borderRadius: 4,
  },
  address: {
    height: 14,
    width: "90%",
    borderRadius: 4,
  },
  itemCount: {
    height: 13,
    width: 50,
    borderRadius: 4,
  },
  statusIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
});

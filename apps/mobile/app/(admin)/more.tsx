import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import { useRouter } from "expo-router";

interface GridCardProps {
  icon: string;
  label: string;
  color: string;
  bg: string;
  onPress: () => void;
  badge?: string;
}

function GridCard({ icon, label, color, bg, onPress, badge }: GridCardProps) {
  return (
    <Pressable style={styles.gridCard} onPress={onPress}>
      <View style={[styles.gridCardIcon, { backgroundColor: bg }]}>
        <Ionicons name={icon as any} size={24} color={color} />
        {badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.gridCardLabel}>{label}</Text>
    </Pressable>
  );
}

export default function AdminMoreScreen() {
  const router = useRouter();

  const sections = [
    {
      title: "Operations",
      items: [
        {
          icon: "cube-outline",
          label: "Products",
          color: "#db2777",
          bg: "#fce7f3",
          onPress: () => router.push("/(admin)/products"),
        },
        {
          icon: "map-outline",
          label: "Routes",
          color: "#7c3aed",
          bg: "#ede9fe",
          onPress: () => router.push("/(admin)/routes"),
        },
        {
          icon: "car-outline",
          label: "Drivers",
          color: "#0284c7",
          bg: "#e0f2fe",
          onPress: () => router.push("/(admin)/drivers"),
        },
        {
          icon: "arrow-undo-outline",
          label: "Returns",
          color: "#ea580c",
          bg: "#fff7ed",
          onPress: () => router.push("/(admin)/returns"),
        },
      ],
    },
    {
      title: "Management",
      items: [
        {
          icon: "business-outline",
          label: "Suppliers",
          color: "#059669",
          bg: "#d1fae5",
          onPress: () => Linking.openURL("https://routeflow.app/suppliers"),
        },
        {
          icon: "archive-outline",
          label: "Inventory",
          color: "#2563EB",
          bg: "#dbeafe",
          onPress: () => Linking.openURL("https://routeflow.app/inventory"),
        },
        {
          icon: "bar-chart-outline",
          label: "Analytics",
          color: "#d97706",
          bg: "#fef3c7",
          onPress: () => Linking.openURL("https://routeflow.app/analytics"),
        },
        {
          icon: "settings-outline",
          label: "Settings",
          color: "#64748b",
          bg: "#f1f5f9",
          onPress: () => router.push("/(admin)/profile"),
        },
      ],
    },
  ];

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: 32 }}
    >
      {sections.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          <View style={styles.grid}>
            {section.items.map((item) => (
              <GridCard key={item.label} {...item} />
            ))}
          </View>
        </View>
      ))}

      {/* App Info */}
      <View style={styles.appInfo}>
        <View style={styles.appLogo}>
          <Ionicons name="navigate-circle" size={32} color="#2563EB" />
        </View>
        <Text style={styles.appName}>RouteFlow</Text>
        <Text style={styles.appVersion}>Version 1.0.0 · Admin Panel</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  section: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  gridCard: {
    width: "23%",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  gridCardIcon: {
    width: 54,
    height: 54,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
    position: "relative",
  },
  badge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: "#dc2626",
    borderRadius: 100,
    minWidth: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  badgeText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  gridCardLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "#475569",
    textAlign: "center",
  },
  appInfo: {
    alignItems: "center",
    marginTop: 32,
    gap: 4,
  },
  appLogo: {
    marginBottom: 4,
  },
  appName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  appVersion: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});

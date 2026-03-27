import { useEffect, useRef } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import { useAuthStore } from "../lib/auth-store";

interface DrawerMenuProps {
  visible: boolean;
  onClose: () => void;
}

const NAV_ITEMS: Array<{
  id: string;
  label: string;
  icon: string;
  path: string;
}> = [
  { id: "route", label: "My Route", icon: "map-outline", path: "/(driver)/route" },
  { id: "order", label: "Create Order", icon: "add-circle-outline", path: "/(driver)/orders/new" },
  { id: "customers", label: "My Customers", icon: "people-outline", path: "/(driver)/customers" },
  { id: "stock", label: "Stock Check", icon: "cube-outline", path: "/(driver)/inventory" },
  { id: "history", label: "Delivery History", icon: "time-outline", path: "/(driver)/history" },
  { id: "schedule", label: "Schedule Run", icon: "calendar-outline", path: "/(driver)/route/new-run" },
  { id: "performance", label: "Performance", icon: "stats-chart-outline", path: "/(driver)/history/performance" },
];

export function DrawerMenu({ visible, onClose }: DrawerMenuProps) {
  const translateX = useRef(new Animated.Value(-300)).current;
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(translateX, {
          toValue: 0,
          useNativeDriver: true,
          tension: 65,
          friction: 11,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: -300,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, translateX, overlayOpacity]);

  const username = user?.username ?? "Driver";
  const words = username.split(/[\s_]/).slice(0, 2);
  const initials = words.map((w: string) => (w[0] ? w[0].toUpperCase() : "")).join("") || (username[0] ? username[0].toUpperCase() : "D");

  const handleNav = (path: string) => {
    onClose();
    setTimeout(() => {
      router.push(path as any);
    }, 120);
  };

  const handleSignOut = async () => {
    onClose();
    setTimeout(async () => {
      await logout();
    }, 120);
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? "auto" : "none"}>
      {/* Backdrop overlay */}
      <Animated.View
        style={[styles.overlay, { opacity: overlayOpacity }]}
        pointerEvents={visible ? "auto" : "none"}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>

      {/* Drawer panel */}
      <Animated.View style={[styles.drawer, { transform: [{ translateX }] }]}>
        {/* Header */}
        <View style={styles.drawerHeader}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarInitials}>{initials}</Text>
          </View>
          <View style={styles.headerInfo}>
            <Text style={styles.usernameText}>{username}</Text>
            <View style={styles.roleTag}>
              <Text style={styles.roleTagText}>Driver</Text>
            </View>
          </View>
        </View>

        <ScrollView style={styles.navList} showsVerticalScrollIndicator={false}>
          {NAV_ITEMS.map((item) => (
            <Pressable
              key={item.id}
              style={styles.navItem}
              onPress={() => handleNav(item.path)}
              accessibilityRole="button"
              accessibilityLabel={item.label}
            >
              <Ionicons name={item.icon as any} size={22} color={colors.navy.DEFAULT} style={styles.navIcon} />
              <Text style={styles.navLabel}>{item.label}</Text>
              <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
            </Pressable>
          ))}

          <View style={styles.divider} />

          <Pressable
            style={styles.navItem}
            onPress={() => handleNav("/(driver)/change-password")}
            accessibilityRole="button"
            accessibilityLabel="Change Password"
          >
            <Ionicons name="lock-closed-outline" size={22} color={colors.navy.DEFAULT} style={styles.navIcon} />
            <Text style={styles.navLabel}>Change Password</Text>
            <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
          </Pressable>

          <Pressable
            style={styles.navItem}
            onPress={handleSignOut}
            accessibilityRole="button"
            accessibilityLabel="Sign Out"
          >
            <Ionicons name="log-out-outline" size={22} color="#ef4444" style={styles.navIcon} />
            <Text style={[styles.navLabel, styles.signOutText]}>Sign Out</Text>
          </Pressable>
        </ScrollView>

        {/* Footer */}
        <View style={styles.drawerFooter}>
          <Text style={styles.footerText}>RouteFlow v1.0.0</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  drawer: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 300,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e2e8f0",
    backgroundColor: colors.brand[500],
  },
  avatarCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.brand[100] ?? "rgba(255,255,255,0.25)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.3)",
  },
  avatarInitials: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  headerInfo: {
    flex: 1,
    gap: 6,
  },
  usernameText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  roleTag: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.2)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  roleTagText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  navList: {
    flex: 1,
    paddingTop: 8,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  navIcon: {
    marginRight: 14,
    width: 24,
  },
  navLabel: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  signOutText: {
    color: "#ef4444",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#e2e8f0",
    marginHorizontal: 20,
    marginVertical: 8,
  },
  drawerFooter: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e2e8f0",
  },
  footerText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
  },
});

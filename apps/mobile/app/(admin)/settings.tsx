import { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  Switch,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import {
  useBusinessSettings,
  useUpdateBusinessSettings,
  useAdminUsers,
  useCreateAdminUser,
  useToggleUserStatus,
  BusinessSettings,
} from "../../lib/api/admin";

const TABS = ["Business Profile", "Users"] as const;
type Tab = typeof TABS[number];

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <View style={styles.tabBar}>
      {TABS.map(t => (
        <Pressable key={t} onPress={() => onChange(t)} style={[styles.tab, active === t && styles.tabActive]}>
          <Text style={[styles.tabText, active === t && styles.tabTextActive]}>{t}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Field({ label, value, onChangeText, placeholder, keyboardType, multiline }: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "email-address" | "phone-pad" | "numeric";
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, multiline && styles.fieldMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? label}
        placeholderTextColor="#94a3b8"
        keyboardType={keyboardType ?? "default"}
        multiline={multiline}
        numberOfLines={multiline ? 3 : 1}
        autoCapitalize="none"
      />
    </View>
  );
}

function BusinessProfileTab() {
  const { data: settings, isLoading } = useBusinessSettings();
  const update = useUpdateBusinessSettings();
  const [form, setForm] = useState<BusinessSettings>({
    businessName: "", ownerName: "", phone: "", email: "",
    street: "", city: "", zip: "", taxRate: 10,
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) setForm({ ...settings });
  }, [settings]);

  const set = (key: keyof BusinessSettings) => (val: string) =>
    setForm(prev => ({ ...prev, [key]: key === "taxRate" ? parseFloat(val) || 0 : val }));

  const handleSave = async () => {
    try {
      await update.mutateAsync(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      Alert.alert("Error", "Failed to save settings");
    }
  };

  if (isLoading) return <ActivityIndicator color="#2563EB" style={{ marginTop: 48 }} />;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} showsVerticalScrollIndicator={false}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Business Information</Text>
        <Field label="Business Name" value={form.businessName ?? ""} onChangeText={set("businessName")} />
        <Field label="Owner / Manager Name" value={form.ownerName ?? ""} onChangeText={set("ownerName")} />
        <Field label="Phone" value={form.phone ?? ""} onChangeText={set("phone")} keyboardType="phone-pad" />
        <Field label="Email" value={form.email ?? ""} onChangeText={set("email")} keyboardType="email-address" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Address</Text>
        <Field label="Street" value={form.street ?? ""} onChangeText={set("street")} />
        <Field label="City" value={form.city ?? ""} onChangeText={set("city")} />
        <Field label="ZIP Code" value={form.zip ?? ""} onChangeText={set("zip")} keyboardType="numeric" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Tax Settings</Text>
        <Field label="Default Tax Rate (%)" value={String(form.taxRate ?? 10)} onChangeText={set("taxRate")} keyboardType="numeric" />
      </View>

      <Pressable
        style={[styles.saveBtn, update.isPending && styles.saveBtnDisabled]}
        onPress={handleSave}
        disabled={update.isPending}
      >
        {update.isPending ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : saved ? (
          <>
            <Ionicons name="checkmark-circle" size={18} color="#fff" />
            <Text style={styles.saveBtnText}>Saved!</Text>
          </>
        ) : (
          <Text style={styles.saveBtnText}>Save Changes</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

function UsersTab() {
  const { data: users = [], isLoading, refetch } = useAdminUsers();
  const toggle = useToggleUserStatus();
  const createUser = useCreateAdminUser();
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState({ firstName: "", lastName: "", username: "", email: "", password: "", role: "DRIVER" });

  const handleToggle = (id: string, currentlyActive: boolean) => {
    Alert.alert(
      currentlyActive ? "Deactivate User?" : "Activate User?",
      currentlyActive ? "This user will no longer be able to log in." : "This user will be able to log in again.",
      [
        { text: "Cancel", style: "cancel" },
        { text: currentlyActive ? "Deactivate" : "Activate", onPress: () => toggle.mutate({ id, isActive: !currentlyActive }) },
      ],
    );
  };

  const handleCreate = async () => {
    if (!newUser.firstName || !newUser.username || !newUser.password) {
      Alert.alert("Error", "First name, username, and password are required");
      return;
    }
    try {
      await createUser.mutateAsync(newUser);
      setShowCreate(false);
      setNewUser({ firstName: "", lastName: "", username: "", email: "", password: "", role: "DRIVER" });
      refetch();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.message ?? "Failed to create user");
    }
  };

  const roleColor = (role: string) => {
    if (role === "OPERATOR") return { bg: "#dbeafe", text: "#2563EB" };
    if (role === "DRIVER") return { bg: "#dcfce7", text: "#16a34a" };
    return { bg: "#f1f5f9", text: "#64748b" };
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} showsVerticalScrollIndicator={false}>
      <View style={styles.usersHeader}>
        <Text style={styles.usersCount}>{users.length} user{users.length !== 1 ? "s" : ""}</Text>
        <Pressable style={styles.addBtn} onPress={() => setShowCreate(!showCreate)}>
          <Ionicons name={showCreate ? "close" : "add"} size={18} color="#fff" />
          <Text style={styles.addBtnText}>{showCreate ? "Cancel" : "Add User"}</Text>
        </Pressable>
      </View>

      {showCreate && (
        <View style={styles.createForm}>
          <Text style={styles.sectionTitle}>New User</Text>
          {[
            { label: "First Name *", key: "firstName" },
            { label: "Last Name", key: "lastName" },
            { label: "Username *", key: "username" },
            { label: "Email", key: "email", kb: "email-address" as const },
            { label: "Password *", key: "password" },
          ].map(f => (
            <Field
              key={f.key}
              label={f.label}
              value={(newUser as any)[f.key]}
              onChangeText={val => setNewUser(prev => ({ ...prev, [f.key]: val }))}
              keyboardType={f.kb}
            />
          ))}
          <View style={styles.roleRow}>
            <Text style={styles.fieldLabel}>Role</Text>
            <View style={styles.roleOptions}>
              {["DRIVER", "OPERATOR"].map(role => (
                <Pressable
                  key={role}
                  style={[styles.roleOption, newUser.role === role && styles.roleOptionActive]}
                  onPress={() => setNewUser(prev => ({ ...prev, role }))}
                >
                  <Text style={[styles.roleOptionText, newUser.role === role && styles.roleOptionTextActive]}>{role}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Pressable style={styles.saveBtn} onPress={handleCreate} disabled={createUser.isPending}>
            {createUser.isPending ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveBtnText}>Create User</Text>}
          </Pressable>
        </View>
      )}

      {isLoading ? <ActivityIndicator color="#2563EB" style={{ marginTop: 32 }} /> : (
        users.map(u => {
          const rc = roleColor(u.role);
          return (
            <View key={u.id} style={styles.userCard}>
              <View style={styles.userAvatar}>
                <Text style={styles.userAvatarText}>{(u.firstName?.[0] ?? u.username[0]).toUpperCase()}</Text>
              </View>
              <View style={styles.userInfo}>
                <Text style={styles.userName}>{u.firstName ? `${u.firstName} ${u.lastName ?? ""}`.trim() : u.username}</Text>
                <Text style={styles.userUsername}>@{u.username}</Text>
                {u.email ? <Text style={styles.userEmail}>{u.email}</Text> : null}
              </View>
              <View style={styles.userRight}>
                <View style={[styles.roleBadge, { backgroundColor: rc.bg }]}>
                  <Text style={[styles.roleBadgeText, { color: rc.text }]}>{u.role}</Text>
                </View>
                <Switch
                  value={u.isActive}
                  onValueChange={() => handleToggle(u.id, u.isActive)}
                  trackColor={{ false: "#e2e8f0", true: "#bfdbfe" }}
                  thumbColor={u.isActive ? "#2563EB" : "#94a3b8"}
                  style={{ marginTop: 6 }}
                />
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

export default function AdminSettingsScreen() {
  const [activeTab, setActiveTab] = useState<Tab>("Business Profile");

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>
      <TabBar active={activeTab} onChange={setActiveTab} />
      {activeTab === "Business Profile" ? <BusinessProfileTab /> : <UsersTab />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  header: { backgroundColor: "#fff", paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  tabBar: { flexDirection: "row", backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  tab: { flex: 1, paddingVertical: 14, alignItems: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: "#2563EB" },
  tabText: { fontSize: 14, fontFamily: "Inter_500Medium", color: "#94a3b8" },
  tabTextActive: { color: "#2563EB", fontFamily: "Inter_600SemiBold" },
  section: {
    backgroundColor: "#fff", borderRadius: 12, padding: 16, marginBottom: 16,
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  sectionTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 14 },
  field: { marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#334155", marginBottom: 6 },
  fieldInput: {
    borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, fontFamily: "Inter_400Regular", color: colors.navy.DEFAULT, backgroundColor: "#fff",
  },
  fieldMultiline: { height: 80, textAlignVertical: "top" },
  saveBtn: {
    backgroundColor: "#2563EB", borderRadius: 10, paddingVertical: 14, alignItems: "center",
    flexDirection: "row", justifyContent: "center", gap: 8, marginTop: 8,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
  usersHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  usersCount: { fontSize: 14, fontFamily: "Inter_500Medium", color: "#64748b" },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#2563EB", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  addBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#fff" },
  createForm: {
    backgroundColor: "#fff", borderRadius: 12, padding: 16, marginBottom: 16,
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  roleRow: { marginBottom: 14 },
  roleOptions: { flexDirection: "row", gap: 8, marginTop: 6 },
  roleOption: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: "#e2e8f0", backgroundColor: "#f8fafc" },
  roleOptionActive: { backgroundColor: "#2563EB", borderColor: "#2563EB" },
  roleOptionText: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#64748b" },
  roleOptionTextActive: { color: "#fff" },
  userCard: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 10, gap: 12,
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  userAvatar: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: "#dbeafe",
    alignItems: "center", justifyContent: "center",
  },
  userAvatarText: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#2563EB" },
  userInfo: { flex: 1 },
  userName: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.navy.DEFAULT },
  userUsername: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#94a3b8", marginTop: 1 },
  userEmail: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#64748b", marginTop: 1 },
  userRight: { alignItems: "flex-end", gap: 4 },
  roleBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  roleBadgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
});

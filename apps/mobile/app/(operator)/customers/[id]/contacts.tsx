/**
 * Contact persons on the customer file — mobile mirror of web's Profile-tab
 * "Contact Persons" card: list (primary first), add/edit sheet, delete.
 * The single-primary invariant is SERVER-enforced (making one contact
 * primary clears the others in a transaction) — no client bookkeeping.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useAddContactPerson,
  useContactPersons,
  useDeleteContactPerson,
  useUpdateContactPerson,
  type ContactPerson,
} from "../../../../lib/api/customers";
import { FormSheet, FormField, FormSection, FormTextInput } from "../../../../components/FormSheet";
import { showToast } from "../../../../lib/toast";
import { confirm } from "../../../../lib/confirm";

function ContactSheet({
  customerId,
  editing,
  onClose,
}: {
  customerId: string;
  editing: ContactPerson | null;
  onClose: () => void;
}) {
  const addMut = useAddContactPerson(customerId);
  const updateMut = useUpdateContactPerson(customerId);

  const [firstName, setFirstName] = useState(editing?.firstName ?? "");
  const [lastName, setLastName] = useState(editing?.lastName ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [mobile, setMobile] = useState(editing?.mobile ?? "");
  const [isPrimary, setIsPrimary] = useState(editing?.isPrimary ?? false);

  const submitting = addMut.isPending || updateMut.isPending;

  const submit = () => {
    if (!firstName.trim()) {
      showToast("First name is required.");
      return;
    }
    const dto = {
      firstName: firstName.trim(),
      lastName: lastName.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      mobile: mobile.trim() || undefined,
      isPrimary,
    };
    const opts = {
      onSuccess: () => {
        showToast(editing ? "Contact updated" : "Contact added");
        onClose();
      },
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    };
    if (editing) updateMut.mutate({ contactId: editing.id, ...dto }, opts);
    else addMut.mutate(dto, opts);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <FormSheet
        title={editing ? "Edit contact" : "New contact"}
        submitLabel="Save"
        onSubmit={submit}
        onCancel={onClose}
        submitting={submitting}
        bottomInset
      >
        <FormSection>
          <FormField label="First name">
            <FormTextInput value={firstName} onChangeText={setFirstName} autoFocus />
          </FormField>
          <FormField label="Last name">
            <FormTextInput value={lastName} onChangeText={setLastName} />
          </FormField>
          <FormField label="Email">
            <FormTextInput
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </FormField>
          <FormField label="Phone">
            <FormTextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          </FormField>
          <FormField label="Mobile">
            <FormTextInput value={mobile} onChangeText={setMobile} keyboardType="phone-pad" />
          </FormField>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Primary contact</Text>
            <Switch value={isPrimary} onValueChange={setIsPrimary} />
          </View>
        </FormSection>
      </FormSheet>
    </Modal>
  );
}

export default function CustomerContactsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const customerId = id!;

  const { data, isLoading, isFetching, refetch, isError } = useContactPersons(customerId);
  const deleteMut = useDeleteContactPerson(customerId);
  const [sheet, setSheet] = useState<{ editing: ContactPerson | null } | null>(null);

  const contacts = data ?? [];

  const onDelete = (c: ContactPerson) =>
    confirm(
      "Delete contact?",
      `Remove ${c.firstName}${c.lastName ? ` ${c.lastName}` : ""} from this customer?`,
      () =>
        deleteMut.mutate(c.id, {
          onSuccess: () => showToast("Contact deleted"),
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Delete", destructive: true },
    );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Contacts"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={<NavAction label="Add" bold onPress={() => setSheet({ editing: null })} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : isError ? (
          <View style={styles.center}>
            <Text style={styles.empty}>Couldn&apos;t load contacts. Pull to retry.</Text>
          </View>
        ) : contacts.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No contact persons yet.</Text>
            <Pressable style={styles.emptyCta} onPress={() => setSheet({ editing: null })}>
              <Text style={styles.emptyCtaText}>Add contact</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24, paddingTop: 8 }}>
            {contacts.map((c) => (
              <View key={c.id} style={styles.row}>
                <View style={styles.rowHead}>
                  <Text style={styles.title} numberOfLines={1}>
                    {c.firstName}
                    {c.lastName ? ` ${c.lastName}` : ""}
                  </Text>
                  {c.isPrimary ? (
                    <Pill variant="brand" dot>
                      Primary
                    </Pill>
                  ) : null}
                </View>
                {c.email ? <Text style={styles.meta}>{c.email}</Text> : null}
                {c.phone ? <Text style={styles.meta}>{c.phone}</Text> : null}
                {c.mobile && c.mobile !== c.phone ? (
                  <Text style={styles.meta}>{c.mobile} (mobile)</Text>
                ) : null}
                <View style={styles.actionRow}>
                  <Pressable
                    style={styles.iconBtn}
                    hitSlop={8}
                    onPress={() => setSheet({ editing: c })}
                    accessibilityLabel={`Edit ${c.firstName}`}
                  >
                    <Ionicons name="pencil-outline" size={17} color={ios.label2} />
                  </Pressable>
                  <Pressable
                    style={styles.iconBtn}
                    hitSlop={8}
                    onPress={() => onDelete(c)}
                    accessibilityLabel={`Delete ${c.firstName}`}
                  >
                    <Ionicons name="trash-outline" size={17} color={ios.system.redInk} />
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {sheet ? (
        <ContactSheet
          key={sheet.editing?.id ?? "new"}
          customerId={customerId}
          editing={sheet.editing}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 12 },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  emptyCta: {
    backgroundColor: ios.brand,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  emptyCtaText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#fff" },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  meta: { marginTop: 4, fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  actionRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 4,
    marginTop: 8,
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  switchLabel: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label },
});

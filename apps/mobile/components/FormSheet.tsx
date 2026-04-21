import * as React from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";

interface FormSheetProps {
  title: string;
  subtitle?: string;
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit: () => void | Promise<void>;
  onCancel?: () => void;
  submitting?: boolean;
  submitDisabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}

/**
 * Modal-style form container used by create/edit screens. Provides a
 * consistent iOS-native look with a Cancel / Submit footer and
 * keyboard-avoiding scroll.
 */
export function FormSheet({
  title,
  subtitle,
  submitLabel = "Save",
  cancelLabel = "Cancel",
  onSubmit,
  onCancel,
  submitting,
  submitDisabled,
  destructive,
  children,
}: FormSheetProps) {
  const router = useRouter();

  const handleCancel = () => {
    if (onCancel) onCancel();
    else router.back();
  };

  const handleSubmit = async () => {
    if (submitting || submitDisabled) return;
    await onSubmit();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={handleCancel} style={styles.iconBtn} hitSlop={10}>
          <Ionicons name="close" size={22} color={ios.label} />
        </Pressable>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.iconBtn} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable onPress={handleCancel} style={[styles.btn, styles.btnSecondary]}>
            <Text style={styles.btnSecondaryText}>{cancelLabel}</Text>
          </Pressable>
          <Pressable
            onPress={handleSubmit}
            style={[
              styles.btn,
              destructive ? styles.btnDestructive : styles.btnPrimary,
              (submitting || submitDisabled) && styles.btnDisabled,
            ]}
            disabled={submitting || submitDisabled}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnPrimaryText}>{submitLabel}</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Reusable field primitives ───────────────────────────────────────────────

export function FormField({
  label,
  hint,
  error,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {children}
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function FormSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

export const FormTextInput = React.forwardRef<TextInput, TextInputProps>(function FormTextInput(
  props,
  ref,
) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={ios.label3}
      {...props}
      style={[styles.input, props.style]}
    />
  );
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  iconBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.2 },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  body: { paddingHorizontal: 16, paddingVertical: 16, gap: 20 },
  footer: {
    flexDirection: "row",
    gap: 10,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  btn: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: { backgroundColor: ios.brand },
  btnPrimaryText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  btnSecondary: { backgroundColor: ios.fill3 },
  btnSecondaryText: { color: ios.label, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  btnDestructive: { backgroundColor: ios.system.red },
  btnDisabled: { opacity: 0.4 },
  field: { gap: 6 },
  label: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  error: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.system.redInk },
  hint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3 },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  sectionBody: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14, gap: 14 },
  input: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: 44,
  },
});

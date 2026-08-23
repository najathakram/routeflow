import * as React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewStyle,
} from "react-native";
import { ios, shadows } from "@routeflow/ui/tokens";
import { apiClient } from "../lib/api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AddressParts {
  street: string;
  city: string;
  state: string;
  zip: string;
}

interface Suggestion {
  placeId: string;
  display: string;
  mainText: string;
  secondaryText: string;
}

export interface AddressAutocompleteInputProps {
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  onAddressSelect: (parts: AddressParts) => void;
  placeholder?: string;
  error?: string;
  style?: ViewStyle;
}

// Android hit-testing stops at any ancestor whose bounds exclude the touch
// point, so an absolutely-positioned list is untappable there; iOS and RN-Web
// both hit-test unclipped overflow, so they keep the overlay.
const OVERLAY_SUGGESTIONS = Platform.OS !== "android";

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Mobile counterpart to web's AddressAutocomplete (apps/web/components/
 * AddressAutocomplete.tsx) — same two backend endpoints (`/public/places/
 * autocomplete`, `/public/places/details`), same debounce, same AddressParts
 * shape. Two RN-specific choices vs. the web version:
 *  - the suggestion list renders inline, never a Modal, to avoid RN modal
 *    portal-order bugs. It overlays the fields below on iOS / RN-Web, but
 *    sits in normal flow on Android, which never dispatches touches to a
 *    view drawn outside its parent's bounds (an overlay list would render
 *    there and simply not respond to taps);
 *  - the TextInput gets an explicit `width: "100%"` so it can't collapse to
 *    RN's intrinsic size-20 default the way an unstyled input can.
 */
export function AddressAutocompleteInput({
  label,
  value,
  onChangeText,
  onAddressSelect,
  placeholder = "Start typing an address…",
  error,
  style,
}: AddressAutocompleteInputProps) {
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slow earlier request clobbering a faster later one.
  const requestSeq = React.useRef(0);

  // ── Fetch suggestions from the same public proxy web uses ────────────────

  const fetchSuggestions = React.useCallback(async (q: string) => {
    if (q.trim().length < 3) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    const seq = ++requestSeq.current;
    setIsLoading(true);
    try {
      const { data } = await apiClient.get<{ suggestions?: Suggestion[] }>(
        `/public/places/autocomplete?q=${encodeURIComponent(q.trim())}`,
      );
      if (seq !== requestSeq.current) return; // superseded by a newer keystroke
      const list = data.suggestions ?? [];
      setSuggestions(list);
      setIsOpen(list.length > 0);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.error("[AddressAutocompleteInput] autocomplete fetch failed:", err);
      setSuggestions([]);
      setIsOpen(false);
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, []);

  const handleChangeText = (v: string) => {
    onChangeText(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(v), 300);
  };

  // ── Select a suggestion: fetch full address components ────────────────────

  const handleSelect = React.useCallback(
    async (s: Suggestion) => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
      setIsOpen(false);
      setSuggestions([]);
      onChangeText(s.mainText || s.display);
      try {
        const { data: parts } = await apiClient.get<AddressParts>(
          `/public/places/details?placeId=${encodeURIComponent(s.placeId)}`,
        );
        if (parts.street) onChangeText(parts.street);
        onAddressSelect(parts);
      } catch (err) {
        console.error("[AddressAutocompleteInput] details fetch failed:", err);
        onAddressSelect({ street: s.mainText || s.display, city: "", state: "", zip: "" });
      }
    },
    [onChangeText, onAddressSelect],
  );

  // RN has no "click outside" event the way web does. Close on blur instead,
  // delayed so a tap on a suggestion row (which blurs the input first) still
  // has time to fire its onPress before the list disappears underneath it.
  const handleBlur = () => {
    blurTimeoutRef.current = setTimeout(() => setIsOpen(false), 150);
  };

  React.useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    },
    [],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, style]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.inputWrap}>
        <TextInput
          value={value}
          onChangeText={handleChangeText}
          onFocus={() => suggestions.length > 0 && setIsOpen(true)}
          onBlur={handleBlur}
          placeholder={placeholder}
          placeholderTextColor={ios.label3}
          autoCorrect={false}
          autoCapitalize="none"
          style={styles.input}
        />
        {isLoading ? (
          <ActivityIndicator size="small" color={ios.label3} style={styles.spinner} />
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {isOpen && suggestions.length > 0 ? (
        <View
          style={[
            styles.suggestionList,
            OVERLAY_SUGGESTIONS && styles.suggestionListOverlay,
            shadows.dropdown,
          ]}
        >
          {suggestions.map((s, i) => (
            <Pressable
              key={s.placeId}
              onPress={() => handleSelect(s)}
              style={({ pressed }) => [
                styles.suggestionRow,
                i > 0 && styles.suggestionRowBorder,
                pressed && styles.suggestionRowPressed,
              ]}
            >
              <Text style={styles.mainText} numberOfLines={1}>
                {s.mainText}
              </Text>
              {s.secondaryText ? (
                <Text style={styles.secondaryText} numberOfLines={1}>
                  {s.secondaryText}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // zIndex on the root (not just the dropdown below) so this field paints
  // above the fields that follow it inside the same section — RN orders only
  // siblings of a shared parent by zIndex. Out-ranking the NEXT section card
  // is the caller's job: it has to lift the whole FormSection (see
  // CustomerForm's "Address (optional)" section).
  container: { position: "relative", zIndex: 20, gap: 6 },
  label: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  inputWrap: { position: "relative", justifyContent: "center" },
  input: {
    // Explicit width: an unstyled TextInput can fall back to the HTML
    // default size=20 (RN-Web) instead of filling its parent.
    width: "100%",
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingRight: 36,
    paddingVertical: 11,
    minHeight: 44,
  },
  spinner: { position: "absolute", right: 12 },
  error: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.system.redInk },
  // Rendered inline, never a Modal — no dependence on modal portal order.
  suggestionList: {
    marginTop: 4,
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    overflow: "hidden",
  },
  // iOS / RN-Web only (see OVERLAY_SUGGESTIONS): float under the input so the
  // fields below stay put. On Android the list keeps its place in the flow and
  // pushes them down, which is what keeps its rows tappable.
  suggestionListOverlay: { position: "absolute", top: "100%", left: 0, right: 0 },
  suggestionRow: { paddingHorizontal: 12, paddingVertical: 10 },
  suggestionRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
  suggestionRowPressed: { backgroundColor: ios.fill3 },
  mainText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  secondaryText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
});

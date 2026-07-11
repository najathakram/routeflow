import * as React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { FormTextInput } from "./FormSheet";
import { useProductCategories } from "../lib/api/products";
import { filterCategorySuggestions } from "../lib/category-suggest";

/**
 * Category field with suggest-as-you-type from the tenant's existing categories
 * (GET /products/categories). Tapping a suggestion fills the field; typing
 * anything new keeps the text and becomes a new category on save — the mobile
 * mirror of web's CategoryCombobox.
 */
export function CategoryInput({
  value,
  onChangeText,
  placeholder = "e.g. Bakery",
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
}) {
  const [focused, setFocused] = React.useState(false);
  const { data: categories } = useProductCategories();

  const suggestions = focused ? filterCategorySuggestions(categories, value) : [];

  return (
    <View>
      <FormTextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        autoCapitalize="sentences"
        autoCorrect={false}
        onFocus={() => setFocused(true)}
        // Delay so a suggestion tap lands before the list unmounts.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
      />
      {suggestions.length > 0 ? (
        <View style={styles.suggestions}>
          {suggestions.map((c, i) => (
            <Pressable
              key={c}
              onPress={() => {
                onChangeText(c);
                setFocused(false);
              }}
              style={[styles.suggestionRow, i > 0 && styles.suggestionDivider]}
            >
              <Text style={styles.suggestionText}>{c}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  suggestions: {
    marginTop: 4,
    borderRadius: 10,
    backgroundColor: ios.bgElev,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    overflow: "hidden",
  },
  suggestionRow: { paddingHorizontal: 14, paddingVertical: 10 },
  suggestionDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  suggestionText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label },
});

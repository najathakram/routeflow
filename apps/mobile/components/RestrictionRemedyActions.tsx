import * as React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import {
  NO_STORE_STATE_LINE,
  US_STATES,
  noStateOnFileLine,
  type RestrictionWarningLine,
} from "@routeflow/types";
import { useAddCustomerState, useCustomer } from "../lib/api/customers";
import {
  REMEDY_COPY,
  customerStateFix,
  remedyActions,
  type RemedyAction,
} from "../lib/restriction-warning";

/** Up to this many matching states are offered as chips while typing. */
const MAX_MATCHES = 6;

/**
 * Row 672 (SA-844): mobile twin of web's RestrictionRemedyActions. The secondary action under the warned lines, never
 * instead of "Sell anyway": a customer with no state gets an in-place state field, then "Check the sale again" re-runs
 * the save with no ack; a store with no state is set on the web (mobile has no business-address screen).
 */
export function RestrictionRemedyActions({
  lines,
  onRecheck,
}: {
  lines: readonly RestrictionWarningLine[];
  onRecheck?: () => void;
}) {
  const actions = remedyActions(lines);
  if (actions.length === 0) return null;
  return (
    <View style={styles.wrap}>
      {actions.map((a) => (
        <RemedyAction
          key={a.kind === "ADD_STORE_STATE" ? "store" : a.customerId}
          action={a}
          onRecheck={onRecheck}
        />
      ))}
    </View>
  );
}

function RemedyAction({ action, onRecheck }: { action: RemedyAction; onRecheck?: () => void }) {
  if (action.kind === "ADD_STORE_STATE") {
    return (
      <View>
        <Text style={styles.link}>{NO_STORE_STATE_LINE}</Text>
        <Text style={styles.hint}>{REMEDY_COPY.storeOnWeb}</Text>
      </View>
    );
  }
  return <AddCustomerState customerId={action.customerId} onRecheck={onRecheck} />;
}

function AddCustomerState({
  customerId,
  onRecheck,
}: {
  customerId: string;
  onRecheck?: () => void;
}) {
  const customer = useCustomer(customerId);
  const save = useAddCustomerState();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const name = customer.data?.businessName ?? REMEDY_COPY.thisCustomer;
  const fix = customerStateFix(customer.data?.addresses ?? []);
  const q = query.trim().toLowerCase();
  const matches =
    q.length === 0
      ? []
      : US_STATES.filter(
          (s) => s.code.toLowerCase() === q || s.name.toLowerCase().startsWith(q),
        ).slice(0, MAX_MATCHES);

  if (saved) {
    return (
      <View style={styles.saved} accessibilityLiveRegion="polite">
        <Text style={styles.savedText}>{REMEDY_COPY.saved}</Text>
        {onRecheck ? (
          <Pressable style={styles.btnGhost} onPress={onRecheck} accessibilityRole="button">
            <Text style={styles.btnGhostText}>{REMEDY_COPY.checkAgain}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.linkHit}
      >
        <Text style={styles.link}>{noStateOnFileLine(name)}</Text>
      </Pressable>
      {open ? (
        fix.kind === "chooseDefault" ? (
          <Text style={styles.hint}>{REMEDY_COPY.chooseDefault}</Text>
        ) : (
          <View style={styles.panel}>
            <TextInput
              value={state ? (US_STATES.find((s) => s.code === state)?.name ?? state) : query}
              onChangeText={(t) => {
                setState(null);
                setQuery(t);
              }}
              placeholder={REMEDY_COPY.stateLabel}
              accessibilityLabel={REMEDY_COPY.stateLabel}
              autoCapitalize="words"
              autoCorrect={false}
              style={styles.input}
            />
            {!state && matches.length > 0 ? (
              <View style={styles.chips}>
                {matches.map((s) => (
                  <Pressable
                    key={s.code}
                    style={styles.chip}
                    onPress={() => setState(s.code)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.chipText}>
                      {s.code} — {s.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {save.isError ? <Text style={styles.error}>{REMEDY_COPY.failed}</Text> : null}
            <Pressable
              style={[styles.btnFill, (!state || save.isPending) && styles.btnDisabled]}
              disabled={!state || save.isPending}
              onPress={() =>
                state &&
                save.mutate(
                  {
                    customerId,
                    addressId: fix.kind === "setState" ? fix.addressId : null,
                    state,
                  },
                  { onSuccess: () => setSaved(true) },
                )
              }
              accessibilityRole="button"
              accessibilityState={{ disabled: !state || save.isPending }}
            >
              <Text style={styles.btnFillText}>
                {save.isPending ? REMEDY_COPY.saving : REMEDY_COPY.save}
              </Text>
            </Pressable>
          </View>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  linkHit: { minHeight: 44, justifyContent: "center" },
  link: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    textDecorationLine: "underline",
  },
  hint: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  panel: { backgroundColor: ios.fill3, borderRadius: 12, padding: 12, gap: 8 },
  input: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: ios.bgElev,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: ios.bgElev,
  },
  chipText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  error: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.system.red },
  saved: { backgroundColor: ios.fill3, borderRadius: 12, padding: 12, gap: 8 },
  savedText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label },
  btnGhost: {
    minHeight: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.bgElev,
  },
  btnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  btnFill: {
    minHeight: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.brand,
  },
  btnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
  btnDisabled: { opacity: 0.4 },
});

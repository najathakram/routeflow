import * as React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../../components/FormSheet";
import { MoneyTextInput } from "../../../../components/MoneyTextInput";
import {
  useCreditNote,
  useReissueCreditNote,
  useUpdateCreditNote,
  useVoidPreview,
} from "../../../../lib/api/credit-notes";
import { useAdminInvoice } from "../../../../lib/api/admin";
import {
  CREDIT_NOTE_REASON_MAX,
  type CreditNoteEditDraft,
  creditNoteDraftAmount,
  creditNoteExpiryEditable,
  creditNoteLines,
  planCreditNoteEdit,
  reissueConfirmMessage,
} from "../../../../lib/credit-notes-logic";
import { confirm } from "../../../../lib/confirm";
import { showToast } from "../../../../lib/toast";
import { creditNoteErrorCopy, refusalCopy } from "../../../../lib/credit-note-error-copy";

/** A fresh Idempotency-Key per opened edit (SA-535b): a retry of the same edit is a replay. */
function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * #2648 / SA-535(c), mirrors web's EditCreditNoteModal. Reason/expiry only ⇒ a plain save
 * (PATCH). An amount or line change confirms "This voids CN-X and issues a new credit note"
 * (+ what it un-applies, from void-preview), then reissues and opens the new note.
 */
export default function EditCreditNoteScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: cn, isLoading } = useCreditNote(id ?? "");
  const update = useUpdateCreditNote();
  const reissue = useReissueCreditNote();
  const [key] = React.useState(newKey);
  const [draft, setDraft] = React.useState<CreditNoteEditDraft | null>(null);

  const lines = React.useMemo(() => (cn ? creditNoteLines(cn) : []), [cn]);
  const { data: invoice } = useAdminInvoice(lines.length ? (cn?.invoiceId ?? "") : "");
  const describe = (invoiceItemId: string) =>
    (
      (invoice as { items?: Array<{ id: string; description?: string }> } | undefined)?.items ?? []
    ).find((it) => it.id === invoiceItemId)?.description ?? "Invoice line";

  React.useEffect(() => {
    if (!cn || draft) return;
    setDraft({
      amount: Number(cn.amount),
      lineAmounts: Object.fromEntries(lines.map((l) => [l.invoiceItemId, Number(l.amount)])),
      reason: cn.reason ?? "",
      expiry: cn.expiresAt ? cn.expiresAt.slice(0, 10) : "",
    });
  }, [cn, draft, lines]);

  const plan = cn && draft ? planCreditNoteEdit(cn, draft) : null;
  const preview = useVoidPreview(id ?? "", plan?.kind === "reissue");

  if (isLoading || !cn || !draft || !plan) {
    return (
      <FormSheet title="Edit credit note" onSubmit={() => router.back()} submitLabel="Back">
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </FormSheet>
    );
  }

  // Owner rule: never show a server message; refusals map by code to fixed copy.
  const onErr = (e: unknown, fallback: string) => showToast(creditNoteErrorCopy(e, fallback));

  const submit = () => {
    if (plan.kind === "invalid") return showToast(plan.message);
    if (plan.kind === "none") return router.back();
    if (plan.kind === "patch") {
      update.mutate(
        { id: cn.id, ...plan.patch },
        {
          onSuccess: () => {
            showToast("Credit note updated");
            router.back();
          },
          onError: (e) => onErr(e, "Couldn't save the credit note."),
        },
      );
      return;
    }
    if (preview.data?.refusalCode || preview.data?.refusal)
      return showToast(refusalCopy(preview.data.refusalCode));
    confirm(
      "Change the credit amount?",
      reissueConfirmMessage(cn.creditNoteNumber, plan.input.amount, preview.data?.invoices ?? []),
      () =>
        reissue.mutate(
          { id: cn.id, idempotencyKey: key, ...plan.input },
          {
            onSuccess: (res) => {
              showToast(
                `${res.voided.creditNoteNumber} replaced by ${res.creditNote.creditNoteNumber}`,
              );
              router.replace(`/(operator)/credit-notes/${res.creditNote.id}`);
            },
            onError: (e) => onErr(e, "Nothing was changed. Please try again."),
          },
        ),
      { confirmText: "Void and issue new", destructive: true },
    );
  };

  const busy = update.isPending || reissue.isPending;
  // Mirrors web: only an ISSUED note's expiry is editable in place (a money change reissues instead).
  // A changed expiry stays editable so it can be put back (amount -> expiry -> amount back is not a trap).
  const expiryEditable = creditNoteExpiryEditable(cn, draft.expiry, plan.kind);
  const set = (patch: Partial<CreditNoteEditDraft>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <FormSheet
      title="Edit credit note"
      subtitle={cn.creditNoteNumber}
      submitLabel={busy ? "Saving…" : plan.kind === "reissue" ? "Continue" : "Save"}
      submitting={busy}
      submitDisabled={plan.kind === "invalid" || (plan.kind === "reissue" && preview.isLoading)}
      confirmDiscardIfDirty={plan.kind !== "none" && !busy}
      onSubmit={submit}
    >
      <FormSection title="Amount">
        {lines.length ? (
          <>
            {lines.map((l) => (
              <FormField key={l.invoiceItemId} label={describe(l.invoiceItemId)}>
                <MoneyTextInput
                  accessibilityLabel={describe(l.invoiceItemId)}
                  value={draft.lineAmounts[l.invoiceItemId] ?? null}
                  onChangeValue={(v) =>
                    set({ lineAmounts: { ...draft.lineAmounts, [l.invoiceItemId]: v } })
                  }
                  placeholder="0.00"
                  style={styles.input}
                />
              </FormField>
            ))}
            <Text style={styles.total}>
              Credit amount ${creditNoteDraftAmount(cn, draft).toFixed(2)}
            </Text>
          </>
        ) : (
          <FormField label="Credit amount">
            <MoneyTextInput
              accessibilityLabel="Credit amount"
              value={draft.amount}
              onChangeValue={(v) => set({ amount: v })}
              placeholder="0.00"
              style={styles.input}
            />
          </FormField>
        )}
        {plan.kind === "reissue" ? (
          <Text style={styles.hint}>
            Changing the amount voids {cn.creditNoteNumber} and issues a new credit note.
          </Text>
        ) : null}
        {plan.kind === "reissue" && (preview.data?.refusalCode || preview.data?.refusal) ? (
          <Text style={styles.error}>{refusalCopy(preview.data?.refusalCode)}</Text>
        ) : null}
      </FormSection>
      <FormSection title="Details">
        <FormField label="Reason">
          <FormTextInput
            value={draft.reason}
            onChangeText={(t) => set({ reason: t })}
            maxLength={CREDIT_NOTE_REASON_MAX}
            multiline
          />
        </FormField>
        <FormField
          label="Expires"
          hint="YYYY-MM-DD; leave empty for no expiry."
          error={plan.kind === "invalid" ? plan.message : undefined}
        >
          <FormTextInput
            value={draft.expiry}
            onChangeText={(t) => set({ expiry: t.trim() })}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            editable={expiryEditable}
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  center: { padding: 40, alignItems: "center" },
  // The same field look as FormTextInput (FormSheet's `input`), so the amount reads as editable.
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
  total: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  hint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk },
});

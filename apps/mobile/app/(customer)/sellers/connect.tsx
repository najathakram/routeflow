import { useState } from "react";
import { useRouter } from "expo-router";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useRequestSeller } from "../../../lib/api/buyer";
import { showToast } from "../../../lib/toast";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ConnectSellerScreen() {
  const router = useRouter();
  const requestMut = useRequestSeller();
  const [sellerSlug, setSellerSlug] = useState("");
  const [emailAtSeller, setEmailAtSeller] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canSubmit = sellerSlug.trim().length > 0 && EMAIL_RE.test(emailAtSeller.trim());

  const onSubmit = () => {
    setError(null);
    requestMut.mutate(
      { sellerSlug: sellerSlug.trim().toLowerCase(), emailAtSeller: emailAtSeller.trim() },
      {
        onSuccess: () => {
          showToast("Connection request sent");
          router.back();
        },
        onError: (e: any) =>
          setError(
            e?.response?.data?.message ??
              "Could not send the connection request. Check the seller code and try again.",
          ),
      },
    );
  };

  return (
    <FormSheet
      title="Connect a Seller"
      submitLabel="Send Request"
      onSubmit={onSubmit}
      submitting={requestMut.isPending}
      submitDisabled={!canSubmit}
    >
      <FormSection>
        <FormField label="Seller company code" hint="Ask your sales rep for their RouteFlow code.">
          <FormTextInput
            value={sellerSlug}
            onChangeText={setSellerSlug}
            placeholder="e.g. acme-foods"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
        </FormField>
        <FormField
          label="Your email at this seller"
          hint="Must match the email on your customer account there — this links your history and negotiated prices."
          error={error ?? undefined}
        >
          <FormTextInput
            value={emailAtSeller}
            onChangeText={setEmailAtSeller}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}

import { useRouter } from "expo-router";
import {
  RegulatedCategoryForm,
  emptyRegulatedCategoryForm,
} from "../../../components/RegulatedCategoryForm";
import { useCreateTrackedCategory } from "../../../lib/api/tracked-categories";
import { showToast } from "../../../lib/toast";

export default function NewRegulatedCategoryScreen() {
  const router = useRouter();
  const mut = useCreateTrackedCategory();

  return (
    <RegulatedCategoryForm
      title="New type"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      initial={emptyRegulatedCategoryForm()}
      onSubmit={(payload) => {
        mut.mutate(payload, {
          onSuccess: (created) => {
            showToast("Type created");
            router.replace(`/(operator)/regulated/${created.id}`);
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        });
      }}
    />
  );
}

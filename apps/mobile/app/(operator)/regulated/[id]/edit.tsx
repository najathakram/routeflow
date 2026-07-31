import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { RegulatedCategoryForm } from "../../../../components/RegulatedCategoryForm";
import {
  useTrackedCategory,
  useUpdateTrackedCategory,
} from "../../../../lib/api/tracked-categories";
import { showToast } from "../../../../lib/toast";

export default function EditRegulatedCategoryScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: category, isLoading } = useTrackedCategory(id);
  const mut = useUpdateTrackedCategory();

  if (isLoading || !category) {
    return (
      <View
        style={{ flex: 1, backgroundColor: ios.bg, alignItems: "center", justifyContent: "center" }}
      >
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }

  return (
    <RegulatedCategoryForm
      title="Edit regulated type"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      initial={{
        name: category.name,
        taxType: category.taxType,
        rate: String(category.rate ?? "0"),
        unitBasis: category.unitBasis ?? "",
        priceIncludesTax: category.priceIncludesTax,
        invoiceTreatment: category.invoiceTreatment,
        requiresLicense: category.requiresLicense,
        reportTemplate: category.reportTemplate,
        reportCadence: category.reportCadence,
        active: category.active,
        wholesalerLicenseNo: category.wholesalerLicenseNo ?? "",
      }}
      onSubmit={(payload) => {
        if (!id) return;
        mut.mutate(
          { id, data: payload },
          {
            onSuccess: () => {
              showToast("Type updated");
              router.back();
            },
            onError: (e: any) =>
              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
          },
        );
      }}
    />
  );
}

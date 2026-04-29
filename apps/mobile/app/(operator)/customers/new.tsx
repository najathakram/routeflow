import { useRouter } from "expo-router";
import {
  CustomerForm,
  emptyCustomerForm,
} from "../../../components/CustomerForm";
import { useCreateCustomer } from "../../../lib/api/customers";
import { showToast } from "../../../lib/toast";

export default function NewCustomerScreen() {
  const router = useRouter();
  const mut = useCreateCustomer();
  return (
    <CustomerForm
      title="New customer"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      initial={emptyCustomerForm()}
      onSubmit={(payload) =>
        mut.mutate(payload, {
          onSuccess: (res) => {
            showToast("Customer created");
            router.replace(`/(operator)/customers/${res.id}`);
          },
          onError: (e: any) =>
            showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        })
      }
    />
  );
}

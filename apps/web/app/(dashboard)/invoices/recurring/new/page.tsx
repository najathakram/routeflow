"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useCreateRecurringInvoice } from "@/lib/api/invoices";
import { RecurringInvoiceForm } from "../_components/RecurringInvoiceForm";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NewRecurringInvoicePage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const createRecurring = useCreateRecurringInvoice();

  React.useEffect(() => {
    setTitle("New Recurring Template");
  }, [setTitle]);

  return (
    <div className="space-y-5 p-6">
      <Link
        href="/invoices/recurring"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Recurring Invoices
      </Link>

      <h2 className="text-2xl font-bold text-navy">New Recurring Template</h2>

      <RecurringInvoiceForm
        mode="create"
        isPending={createRecurring.isPending}
        submitLabel="Create Template"
        onSubmit={(dto) =>
          createRecurring.mutate(dto, {
            onSuccess: () => {
              toast({ title: "Recurring template created", variant: "success" });
              router.push("/invoices/recurring");
            },
            onError: (err: any) => {
              toast({
                title: "Failed to create template",
                description: err?.response?.data?.message ?? "Please try again.",
                variant: "error",
              });
            },
          })
        }
      />
    </div>
  );
}

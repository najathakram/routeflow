"use client";
import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button, Card, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useRecurringInvoice, useUpdateRecurringInvoice } from "@/lib/api/invoices";
import { RecurringInvoiceForm } from "../../_components/RecurringInvoiceForm";

export default function EditRecurringInvoicePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const { data: template, isLoading, isError } = useRecurringInvoice(params.id);
  const updateRecurring = useUpdateRecurringInvoice();

  React.useEffect(() => {
    setTitle("Edit Recurring Template");
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
      <h2 className="text-2xl font-bold text-navy">Edit Recurring Template</h2>
      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
        </div>
      ) : isError || !template ? (
        <Card>
          <p className="text-sm text-navy">This recurring template could not be loaded.</p>
          <Button className="mt-3" variant="secondary" href="/invoices/recurring">
            Back to Recurring Invoices
          </Button>
        </Card>
      ) : (
        <RecurringInvoiceForm
          mode="edit"
          initial={template}
          isPending={updateRecurring.isPending}
          submitLabel="Save Changes"
          onSubmit={({ customerId: _customerId, ...dto }) =>
            updateRecurring.mutate(
              { id: template.id, ...dto },
              {
                onSuccess: () => {
                  toast({ title: "Recurring template updated", variant: "success" });
                  router.push("/invoices/recurring");
                },
                onError: (err: any) =>
                  toast({
                    title: "Failed to update template",
                    description: err?.response?.data?.message ?? "Please try again.",
                    variant: "error",
                  }),
              },
            )
          }
        />
      )}
    </div>
  );
}

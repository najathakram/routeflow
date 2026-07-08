"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ShieldCheck, Plus, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { Badge, Button, Modal, Input, Select, useToast } from "@routeflow/ui/web";
import { fmtDate } from "@/lib/formatting";
import { useTrackedCategories } from "@/lib/api/tracked-categories";
import {
  useCustomerAuthorizations,
  useCreateAuthorization,
  useApproveAuthorization,
  useRejectAuthorization,
  useRenewAuthorization,
  displayAuthStatus,
  authStatusBadge,
  type CustomerAuthorization,
} from "@/lib/api/authorizations";

const todayIso = () => new Date().toISOString().slice(0, 10);

function sourceLabel(source: CustomerAuthorization["source"]): string {
  return source === "RETAILER_SUBMITTED" ? "Submitted by buyer" : "Added by you";
}

// ─── Capture / renew form ───────────────────────────────────────────────────────

function LicenseModal({
  customerId,
  mode,
  auth,
  onClose,
}: {
  customerId: string;
  mode: "create" | "renew";
  auth?: CustomerAuthorization;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: categories } = useTrackedCategories({ active: true });
  const create = useCreateAuthorization(customerId);
  const renew = useRenewAuthorization(customerId);

  const licenseCategories = (categories ?? []).filter((c) => c.requiresLicense);

  const [trackedCategoryId, setTrackedCategoryId] = React.useState(auth?.trackedCategoryId ?? "");
  const [licenseNumber, setLicenseNumber] = React.useState(auth?.licenseNumber ?? "");
  const [expiresAt, setExpiresAt] = React.useState(
    auth?.expiresAt ? auth.expiresAt.slice(0, 10) : "",
  );
  const [error, setError] = React.useState<string | null>(null);

  const pending = create.isPending || renew.isPending;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "create" && !trackedCategoryId) return setError("Choose a category.");
    if (!licenseNumber.trim()) return setError("Enter the license number.");
    if (!expiresAt) return setError("Enter the expiry date.");
    if (new Date(expiresAt) < new Date(todayIso()))
      return setError("The expiry date is in the past.");

    const iso = new Date(expiresAt).toISOString();
    const onSuccess = () => {
      toast({
        title: mode === "create" ? "License captured" : "License renewed",
        description: "The customer is now verified for this category.",
        variant: "success",
      });
      onClose();
    };
    const onError = (err: unknown) =>
      setError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Something went wrong. Please try again.",
      );

    if (mode === "create") {
      create.mutate(
        { trackedCategoryId, licenseNumber: licenseNumber.trim(), expiresAt: iso },
        { onSuccess, onError },
      );
    } else if (auth) {
      renew.mutate(
        { aid: auth.id, data: { licenseNumber: licenseNumber.trim(), expiresAt: iso } },
        { onSuccess, onError },
      );
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={
        mode === "create" ? "Add a verified license" : `Renew ${auth?.trackedCategory.name} license`
      }
      description={
        mode === "create"
          ? "Recording a license here verifies the customer for this category immediately."
          : "Re-verify with the customer's updated license details."
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="license-form" loading={pending}>
            {mode === "create" ? "Verify license" : "Renew"}
          </Button>
        </>
      }
    >
      <form id="license-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {mode === "create" ? (
          <Select
            label="Category"
            placeholder="Select a license-required category"
            value={trackedCategoryId}
            onChange={(e) => setTrackedCategoryId(e.target.value)}
            options={licenseCategories.map((c) => ({ value: c.id, label: c.name }))}
          />
        ) : (
          <div>
            <p className="text-sm font-medium text-navy">Category</p>
            <p className="text-sm text-navy/70">{auth?.trackedCategory.name}</p>
          </div>
        )}
        <Input
          label="License number"
          value={licenseNumber}
          onChange={(e) => setLicenseNumber(e.target.value)}
          placeholder="e.g. TOB-0099123"
        />
        <Input
          label="Expiry date"
          type="date"
          min={todayIso()}
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
        />
        {error && <p className="text-xs text-danger">{error}</p>}
      </form>
    </Modal>
  );
}

// ─── Reject form ────────────────────────────────────────────────────────────────

function RejectModal({
  customerId,
  auth,
  onClose,
}: {
  customerId: string;
  auth: CustomerAuthorization;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const reject = useRejectAuthorization(customerId);
  const [reason, setReason] = React.useState("");

  const onConfirm = () => {
    reject.mutate(
      { aid: auth.id, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast({ title: "License rejected", variant: "success" });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reject ${auth.trackedCategory.name} license`}
      description="The buyer will need to resubmit. This category stays locked for them until a license is verified."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="danger" loading={reject.isPending} onClick={onConfirm}>
            Reject license
          </Button>
        </>
      }
    >
      <label className="mb-1 block text-sm font-medium text-navy">Reason (optional)</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        placeholder="e.g. License number doesn't match the document."
        className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    </Modal>
  );
}

// ─── Tab ────────────────────────────────────────────────────────────────────────

type ModalState =
  | null
  | { type: "create" }
  | { type: "renew"; auth: CustomerAuthorization }
  | { type: "reject"; auth: CustomerAuthorization };

export function AuthorizationsTab({ customerId }: { customerId: string }) {
  const { data: auths, isLoading } = useCustomerAuthorizations(customerId);
  const approve = useApproveAuthorization(customerId);
  const { toast } = useToast();
  const [modal, setModal] = React.useState<ModalState>(null);

  const onApprove = (auth: CustomerAuthorization) =>
    approve.mutate(auth.id, {
      onSuccess: () => toast({ title: "License approved", variant: "success" }),
    });

  return (
    <Tabs.Content value="authorizations" className="mt-5 focus:outline-none">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-navy">Licenses &amp; Authorizations</h3>
          <p className="text-sm text-navy/70">
            Verify this customer for regulated categories, or review licenses they&rsquo;ve
            submitted.
          </p>
        </div>
        <Button
          size="sm"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setModal({ type: "create" })}
        >
          Add license
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        </div>
      ) : !auths || auths.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-8 text-center">
          <ShieldCheck className="mx-auto mb-2 h-8 w-8 text-navy/30" />
          <p className="text-sm font-medium text-navy">No licenses on file</p>
          <p className="mt-1 text-xs text-navy/60">
            Add a license to verify this customer for a regulated category, or wait for them to
            submit one from their portal.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-surface-border rounded-xl border border-surface-border bg-white">
          {auths.map((auth) => {
            const display = displayAuthStatus(auth);
            const badge = authStatusBadge(display);
            return (
              <div key={auth.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-navy">
                      {auth.trackedCategory.name}
                    </span>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-navy/60">
                    {sourceLabel(auth.source)}
                    {auth.licenseNumber ? ` · #${auth.licenseNumber}` : ""}
                    {auth.expiresAt ? ` · Expires ${fmtDate(auth.expiresAt)}` : ""}
                  </p>
                  {auth.status === "VERIFIED" && auth.verifiedByName && (
                    <p className="mt-0.5 text-xs text-navy/40">
                      Verified by {auth.verifiedByName}
                      {auth.verifiedAt ? ` on ${fmtDate(auth.verifiedAt)}` : ""}
                    </p>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  {auth.status === "PENDING_REVIEW" && (
                    <>
                      <Button
                        size="sm"
                        leftIcon={<CheckCircle2 className="h-4 w-4" />}
                        loading={approve.isPending && approve.variables === auth.id}
                        onClick={() => onApprove(auth)}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<XCircle className="h-4 w-4" />}
                        onClick={() => setModal({ type: "reject", auth })}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  {(display === "VERIFIED" || display === "EXPIRED") && (
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<RefreshCw className="h-4 w-4" />}
                      onClick={() => setModal({ type: "renew", auth })}
                    >
                      Renew
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modal?.type === "create" && (
        <LicenseModal customerId={customerId} mode="create" onClose={() => setModal(null)} />
      )}
      {modal?.type === "renew" && (
        <LicenseModal
          customerId={customerId}
          mode="renew"
          auth={modal.auth}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "reject" && (
        <RejectModal customerId={customerId} auth={modal.auth} onClose={() => setModal(null)} />
      )}
    </Tabs.Content>
  );
}

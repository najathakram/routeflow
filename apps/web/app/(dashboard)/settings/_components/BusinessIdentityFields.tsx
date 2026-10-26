"use client";

import * as React from "react";
import { Input, useToast } from "@routeflow/ui/web";
import type { UseFormRegisterReturn } from "react-hook-form";
import { apiClient } from "@/lib/api-client";
import { isReadOnlyRefusal } from "@/lib/read-only-refusal";
import { useTenant } from "@/components/tenant-provider";

/**
 * B1231 (SA-814 section 6): the business name lives in the branding config, not in PATCH /settings.
 * A tenant admin saves a changed name with PUT /tenants/me/config/branding; every other role, and
 * the account email for everyone, is shown read-only.
 */
export const NAME_ADMIN_ONLY_COPY = "Only an account admin can change the business name.";
export const NAME_SAVE_FAILED_COPY = "Couldn't save the business name";
export const EMAIL_READ_ONLY_COPY = "The account admin's sign-in email. It can't be changed here.";

/** The two identity fields leave the PATCH /settings body: the API refuses both. */
export function splitProfileIdentity<T extends { businessName: string; email?: string }>(
  values: T,
): { businessName: string; fields: Omit<T, "businessName" | "email"> } {
  const { businessName, email: _email, ...fields } = values;
  return { businessName, fields };
}

/** Saves the name; resolves true only when it was stored, and refreshes the branding cache then. */
export function useSaveBusinessName() {
  const { toast } = useToast();
  const { refresh } = useTenant();
  return React.useCallback(
    async (name: string): Promise<boolean> => {
      try {
        await apiClient.put("/tenants/me/config/branding", { businessName: name.trim() });
      } catch (err) {
        if (!isReadOnlyRefusal(err)) toast({ title: NAME_SAVE_FAILED_COPY, variant: "error" });
        return false;
      }
      await refresh();
      return true;
    },
    [toast, refresh],
  );
}

function ReadOnlyValue({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div>
      <dl>
        <dt className="text-sm font-medium text-navy">{label}</dt>
        <dd className="text-sm text-navy">{value || "—"}</dd>
      </dl>
      <p className="mt-1 text-xs text-navy/70">{note}</p>
    </div>
  );
}

export function BusinessIdentityFields(props: {
  canEditName: boolean;
  nameRegister: UseFormRegisterReturn;
  nameError?: string;
  savedName: string;
  savedEmail: string;
}) {
  return (
    <>
      {props.canEditName ? (
        <Input label="Business name" register={props.nameRegister} error={props.nameError} />
      ) : (
        <ReadOnlyValue label="Business name" value={props.savedName} note={NAME_ADMIN_ONLY_COPY} />
      )}
      <ReadOnlyValue label="Account email" value={props.savedEmail} note={EMAIL_READ_ONLY_COPY} />
    </>
  );
}

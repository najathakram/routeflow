"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckCircle2, Copy, Check } from "lucide-react";
import { Modal, Input, Button } from "@routeflow/ui/web";

// ─── Schema ───────────────────────────────────────────────────────────────────

const driverSchema = z.object({
  contactName: z.string().min(1, "Required"),
  email: z.string().email("Enter a valid email"),
  phone: z.string().min(7, "Enter a valid phone number").optional().or(z.literal("")),
  username: z.string().min(3, "At least 3 characters").regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers, underscores only"),
  vehicleMake: z.string().optional(),
  vehicleModel: z.string().optional(),
  vehicleColour: z.string().optional(),
  vehiclePlate: z.string().optional(),
});

type DriverFormValues = z.infer<typeof driverSchema>;

// ─── Component ────────────────────────────────────────────────────────────────

export interface AddDriverModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateDriver: (data: DriverFormValues) => Promise<string>;
}

export function AddDriverModal({ isOpen, onClose, onCreateDriver }: AddDriverModalProps) {
  const [tempPassword, setTempPassword] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting, touchedFields },
  } = useForm<DriverFormValues>({
    resolver: zodResolver(driverSchema),
  });

  // Auto-suggest username from name (only if user hasn't manually edited it)
  const nameValue = watch("contactName") ?? "";
  React.useEffect(() => {
    if (touchedFields.username) return;
    const parts = nameValue.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[parts.length - 1]) {
      setValue(
        "username",
        `${parts[0][0].toLowerCase()}${parts[parts.length - 1].toLowerCase()}`,
      );
    }
  }, [nameValue, touchedFields.username, setValue]);

  const handleClose = () => {
    setTempPassword(null);
    setCopied(false);
    setApiError(null);
    reset();
    onClose();
  };

  const onSubmit = async (data: DriverFormValues) => {
    setApiError(null);
    try {
      const password = await onCreateDriver(data);
      setTempPassword(password);
    } catch (err: unknown) {
      // Prefer the API's error message (Axios: err.response.data.message) over the generic one
      const apiMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      const fallbackMsg = (err as { message?: string })?.message;
      setApiError(apiMsg || fallbackMsg || "Failed to create driver. Please try again.");
    }
  };

  const copyPassword = async () => {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title={tempPassword ? "Driver Created" : "Add Driver"}
      description={
        tempPassword
          ? "Share the temporary password with the driver. They will be prompted to change it on first login."
          : "Fill in the driver's details to create their account."
      }
      footer={
        tempPassword ? (
          <Button onClick={handleClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" type="button" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" form="driver-form" loading={isSubmitting}>
              Create Driver
            </Button>
          </>
        )
      }
    >
      {tempPassword ? (
        /* ── Success view ── */
        <div className="flex flex-col items-center gap-5 py-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success-bg">
            <CheckCircle2 className="h-7 w-7 text-success" />
          </div>
          <div className="w-full space-y-2 text-center">
            <p className="text-sm font-medium text-navy">Temporary password</p>
            <div className="flex items-center justify-center gap-2">
              <code className="rounded-lg border border-surface-border bg-surface-raised px-4 py-2 font-mono text-lg font-bold tracking-widest text-navy">
                {tempPassword}
              </code>
              <button
                onClick={copyPassword}
                className="rounded p-2 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-success" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* ── Form view ── */
        <form
          id="driver-form"
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          className="space-y-4"
        >
          {apiError && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
              {apiError}
            </div>
          )}
          <Input
            label="Full Name"
            placeholder="Jane Smith"
            register={register("contactName")}
            error={errors.contactName?.message}
          />
          <Input
            label="Email"
            type="email"
            placeholder="jane.smith@example.com"
            register={register("email")}
            error={errors.email?.message}
          />
          <Input
            label="Phone"
            type="tel"
            placeholder="(512) 555-0100"
            register={register("phone")}
            error={errors.phone?.message}
          />
          <Input
            label="Username"
            placeholder="jsmith"
            register={register("username")}
            error={errors.username?.message}
          />
          <Input
            label="Vehicle Make"
            placeholder="Ford"
            register={register("vehicleMake")}
            error={errors.vehicleMake?.message}
          />
          <Input
            label="Vehicle Model"
            placeholder="Transit"
            register={register("vehicleModel")}
            error={errors.vehicleModel?.message}
          />
          <Input
            label="Vehicle Colour"
            placeholder="White"
            register={register("vehicleColour")}
            error={errors.vehicleColour?.message}
          />
          <Input
            label="Vehicle Plate"
            placeholder="TX PLT-XXXX"
            register={register("vehiclePlate")}
            error={errors.vehiclePlate?.message}
          />
        </form>
      )}
    </Modal>
  );
}

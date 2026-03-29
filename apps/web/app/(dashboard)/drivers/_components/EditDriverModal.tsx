"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Modal, Input, Button } from "@routeflow/ui/web";
import type { Driver } from "@/lib/api/drivers";

// ─── Schema ───────────────────────────────────────────────────────────────────

const editDriverSchema = z.object({
  contactName: z.string().min(1, "Required"),
  phone: z.string().min(7, "Enter a valid phone number").optional().or(z.literal("")),
  vehicleMake: z.string().optional(),
  vehicleModel: z.string().optional(),
  vehicleColour: z.string().optional(),
  vehiclePlate: z.string().optional(),
});

type EditDriverFormValues = z.infer<typeof editDriverSchema>;

// ─── Component ────────────────────────────────────────────────────────────────

export interface EditDriverModalProps {
  driver: Driver;
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: EditDriverFormValues) => Promise<void>;
}

export function EditDriverModal({ driver, isOpen, onClose, onSave }: EditDriverModalProps) {
  const [apiError, setApiError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EditDriverFormValues>({
    resolver: zodResolver(editDriverSchema),
    defaultValues: {
      contactName: driver.contactName ?? "",
      phone: driver.phone ?? "",
      vehicleMake: driver.vehicleMake ?? "",
      vehicleModel: driver.vehicleModel ?? "",
      vehicleColour: driver.vehicleColour ?? "",
      vehiclePlate: driver.vehiclePlate ?? "",
    },
  });

  // Re-populate form whenever the driver changes (e.g. modal re-opened for different driver)
  React.useEffect(() => {
    reset({
      contactName: driver.contactName ?? "",
      phone: driver.phone ?? "",
      vehicleMake: driver.vehicleMake ?? "",
      vehicleModel: driver.vehicleModel ?? "",
      vehicleColour: driver.vehicleColour ?? "",
      vehiclePlate: driver.vehiclePlate ?? "",
    });
    setApiError(null);
  }, [driver, reset]);

  const handleClose = () => {
    setApiError(null);
    onClose();
  };

  const onSubmit = async (data: EditDriverFormValues) => {
    setApiError(null);
    try {
      await onSave(data);
      handleClose();
    } catch (err: unknown) {
      const apiMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      const fallbackMsg = (err as { message?: string })?.message;
      setApiError(apiMsg || fallbackMsg || "Failed to save changes. Please try again.");
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title="Edit Driver"
      description="Update the driver's profile details."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-driver-form" loading={isSubmitting}>
            Save Changes
          </Button>
        </>
      }
    >
      <form
        id="edit-driver-form"
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
          label="Phone"
          type="tel"
          placeholder="(512) 555-0100"
          register={register("phone")}
          error={errors.phone?.message}
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
    </Modal>
  );
}

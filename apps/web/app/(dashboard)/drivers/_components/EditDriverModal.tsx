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
  // Lengths mirror UpdateDriverDto's @MaxLength so the API can't reject a save
  // the form accepted.
  homeLine1: z.string().max(200, "Too long").optional(),
  homeCity: z.string().max(100, "Too long").optional(),
  homeState: z.string().max(50, "Too long").optional(),
  homeZip: z.string().max(20, "Too long").optional(),
});

type EditDriverFormValues = z.infer<typeof editDriverSchema>;

/**
 * The API stores the home base as ONE composed string (`Driver.homeAddress`,
 * the non-empty parts joined with ", " — see DriversService.update) plus its
 * geocoded coords, so split it back apart for the form. A 4-part string maps
 * straight back onto the four inputs; anything else goes into line 1 whole, so
 * re-saving an untouched form recomposes byte-identical to what's stored.
 */
function splitHomeAddress(homeAddress?: string | null) {
  const parts = (homeAddress ?? "").split(", ");
  if (parts.length === 4) {
    return { homeLine1: parts[0], homeCity: parts[1], homeState: parts[2], homeZip: parts[3] };
  }
  return { homeLine1: homeAddress ?? "", homeCity: "", homeState: "", homeZip: "" };
}

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
      ...splitHomeAddress(driver.homeAddress),
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
      ...splitHomeAddress(driver.homeAddress),
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
      // Sending any home field makes the API recompose + re-geocode the home
      // base. Omit them entirely when there's nothing set and nothing typed, so
      // an unrelated edit (phone, vehicle) doesn't burn a geocode call; keep
      // them when the driver HAS a home base so blanking the fields clears it.
      const { homeLine1, homeCity, homeState, homeZip, ...rest } = data;
      const homeTouched = [homeLine1, homeCity, homeState, homeZip].some((v) => !!v?.trim());
      const payload =
        homeTouched || driver.homeAddress
          ? { ...rest, homeLine1, homeCity, homeState, homeZip }
          : rest;
      await onSave(payload);
      handleClose();
    } catch (err: unknown) {
      const apiMsg = (err as { response?: { data?: { message?: string } } })?.response?.data
        ?.message;
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

        <div className="space-y-4 border-t border-gray-200 pt-4">
          <div>
            <p className="text-sm font-medium text-navy">Home Base</p>
            <p className="text-xs text-gray-500">
              Optional. Lets a trip start from this driver&apos;s home instead of the depot. Leave
              blank to clear it.
            </p>
          </div>
          <Input
            label="Home Address"
            placeholder="42 Home Way"
            register={register("homeLine1")}
            error={errors.homeLine1?.message}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input
              label="City"
              placeholder="Austin"
              register={register("homeCity")}
              error={errors.homeCity?.message}
            />
            <Input
              label="State"
              placeholder="TX"
              register={register("homeState")}
              error={errors.homeState?.message}
            />
            <Input
              label="ZIP"
              placeholder="78701"
              register={register("homeZip")}
              error={errors.homeZip?.message}
            />
          </div>
        </div>
      </form>
    </Modal>
  );
}

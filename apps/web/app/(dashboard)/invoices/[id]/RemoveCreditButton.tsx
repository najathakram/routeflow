"use client";

/**
 * "Remove credit" on an applied CREDIT_NOTE payment (#2403). Shown to every STAFF role — the
 * set the API's RolesGuard accepts for POST /credit-notes/:id/unapply (@Roles(OPERATOR), which
 * TENANT_ADMIN and SUPER_ADMIN also satisfy) — and never on a voided invoice. The same staff
 * condition the dashboard uses elsewhere (layout.tsx, RouteGuard.tsx `isStaffRole`).
 */
export function RemoveCreditButton({
  role,
  voided,
  onRemove,
}: {
  role: string | undefined;
  voided: boolean;
  onRemove: () => void;
}) {
  const isStaff = !!role && role !== "CUSTOMER" && role !== "DRIVER";
  if (!isStaff || voided) return null;
  return (
    <button type="button" onClick={onRemove} className="font-medium text-danger hover:underline">
      Remove credit
    </button>
  );
}

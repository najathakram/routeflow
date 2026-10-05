"use client";

import * as React from "react";
import { BusinessProfilePicker } from "./BusinessProfilePicker";
import { SetupSummary } from "./SetupSummary";
import { currentRoleIsSuperAdmin } from "./super-admin";

/**
 * The top of the tenant's "Setup" tab: the plain-English current setup, then the business-profile picker. Platform
 * admin only — it renders nothing for any other role (the feature console below it already says so), and every route
 * behind it is SuperAdminGuard-ed server-side. `version` remounts the summary after a profile was applied.
 */
export function SetupSection({
  tenantId,
  version,
  onApplied,
}: {
  tenantId: string;
  version: number;
  /** The tenant's setup changed: the tab reloads everything that reads it. */
  onApplied: () => void;
}) {
  if (!currentRoleIsSuperAdmin()) return null;
  return (
    <>
      <SetupSummary key={`summary-${version}`} tenantId={tenantId} />
      <BusinessProfilePicker tenantId={tenantId} onApplied={onApplied} />
    </>
  );
}

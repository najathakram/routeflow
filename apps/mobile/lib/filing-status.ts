/**
 * B297 PR5 (B771): how a regulated filing's status reads. A LOCKED filing is a filed filing that was closed by a
 * tenant admin, not a failed one (the UI used to fold every non-GENERATED status into "Failed").
 */
const LABEL: Record<string, string> = {
  GENERATED: "Generated",
  LOCKED: "Locked",
  FAILED: "Failed",
};

export function filingStatusLabel(status: string): string {
  return LABEL[status] ?? "Failed";
}

/** True for a filing that exists as a valid artifact (generated or locked). */
export function isFiledOk(status: string): boolean {
  return status === "GENERATED" || status === "LOCKED";
}

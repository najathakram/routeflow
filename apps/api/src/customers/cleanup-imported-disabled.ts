import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * #2629 (owner policy 4c, SA-531/531b): "Cleanup imported customers" is DISABLED until a real
 * import marker exists. Both entry points (CustomersService.previewImportedCleanup /
 * deleteImportedCustomers) select customers by a heuristic (not linked as an ACTIVE buyer), not
 * by a persisted import record, so they can reach customers that were never imported. This guard
 * is each public method's FIRST statement (no Prisma call at all). The kept bodies live on in
 * runImportedCleanupPreview / runImportedCustomersCleanup, which no controller reaches.
 */
export function assertCleanupImportedEnabled(): void {
  throw new ConflictException({
    code: API_ERROR_CODES.CLEANUP_IMPORTED_DISABLED,
    message: "Cleaning up imported customers is disabled until imports are recorded.",
  });
}

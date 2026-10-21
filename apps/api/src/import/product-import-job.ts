/** SA-823 section 5 (row 655): a regrouping product import that is too slow for one HTTP request runs as a background job. */
export const PRODUCT_IMPORT_QUEUE = "product-import";

/**
 * The most REGROUPING Family rows an apply runs inside the request. Measured on the DB lane at b0bdd2bb3: about 95 ms per
 * regrouped row (200 rows = 19 s), so 2,500 rows would be about 4 minutes against the 60 s line. 200 rows keeps a request
 * near 20 s; a larger apply is queued and the caller polls the job. A preview is always synchronous.
 */
export const IMPORT_FAMILY_SYNC_MAX_ROWS = 200;

export interface ProductImportJobData {
  tenantId: string;
  userId: string;
  fileName?: string;
  /** The uploaded CSV (<= 10 MB), base64. The job re-plans live from it, exactly like a synchronous apply. */
  fileBase64: string;
}

export interface ProductImportJobCounts {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export type ProductImportJobState = "queued" | "running" | "done" | "failed";

export interface ProductImportJobStatus {
  id: string;
  state: ProductImportJobState;
  /** 0-100, rows walked so far. */
  progress: number;
  /** Rows created / updated / unchanged / skipped so far (kept in the progress data, so a failed job still shows them). */
  counts?: ProductImportJobCounts;
  /** The same body a synchronous apply returns (counts, rows, skippedRows, warnings, families), when done. */
  result?: unknown;
  error?: string;
}
